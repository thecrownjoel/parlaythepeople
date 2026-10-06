/**
 * The newsroom's hands in EmDash: bylines for writers, and draft or published posts with the byline attached.
 * Runs inside the worker (the workflow, cron and the Newsroom plugin) through withEmDashRuntime, so posts go
 * through EmDash's normal create and publish paths (revisions, hooks, search index).
 */
import { env } from "cloudflare:workers";
import { withEmDashRuntime } from "emdash/middleware";
import { invalidateBylineObjectCache, ulid } from "emdash";
import type { Writer } from "./writers";

/** Create or update the writer's EmDash byline (bylines have no plugin write API, so this writes the table EmDash
 *  reads, then clears EmDash's byline cache). Returns the byline id. */
export async function upsertByline(w: Writer): Promise<string> {
	const cms = env.DB;
	const t = new Date().toISOString();
	const existing = w.byline_id
		? await cms.prepare("SELECT id FROM _emdash_bylines WHERE id = ?").bind(w.byline_id).first<{ id: string }>()
		: await cms.prepare("SELECT id FROM _emdash_bylines WHERE slug = ?").bind(w.slug).first<{ id: string }>();
	if (existing) {
		await cms.prepare("UPDATE _emdash_bylines SET slug = ?, display_name = ?, bio = ?, avatar_media_id = COALESCE(?, avatar_media_id), updated_at = ? WHERE id = ?")
			.bind(w.slug, w.name, w.bio, w.photo_media_id, t, existing.id).run();
		invalidateBylineObjectCache();
		return existing.id;
	}
	const id = ulid();
	await cms.prepare("INSERT INTO _emdash_bylines (id, slug, display_name, bio, avatar_media_id, website_url, user_id, is_guest, created_at, updated_at, translation_group) VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?)")
		.bind(id, w.slug, w.name, w.bio, w.photo_media_id, t, t, id).run();
	invalidateBylineObjectCache();
	return id;
}

export async function deleteByline(bylineId: string) {
	await env.DB.prepare("DELETE FROM _emdash_bylines WHERE id = ?").bind(bylineId).run();
	invalidateBylineObjectCache();
}

// ---- markdown → Portable Text ----

const key = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/** Inline markdown (**bold**, *italic*, [links](url)) as Portable Text spans and link mark definitions. */
function inline(text: string) {
	const children: any[] = [], markDefs: any[] = [];
	const re = /\*\*([^*]+)\*\*|\*([^*\s][^*]*?)\*|\[([^\]]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)/g;
	let last = 0, m: RegExpExecArray | null;
	const push = (t: string, marks: string[] = []) => t && children.push({ _type: "span", _key: key(), text: t, marks });
	while ((m = re.exec(text))) {
		push(text.slice(last, m.index));
		if (m[1]) push(m[1], ["strong"]);
		else if (m[2]) push(m[2], ["em"]);
		else { const k = key(); markDefs.push({ _type: "link", _key: k, href: m[4] }); push(m[3], [k]); }
		last = m.index + m[0].length;
	}
	push(text.slice(last));
	if (!children.length) push(" ");
	return { children, markDefs };
}

/** Paragraphs, ## and ### headings, bullet and numbered lists, > quotes. */
export function mdToPortableText(md: string): any[] {
	const blocks: any[] = [];
	let para: string[] = [];
	const flush = () => { if (para.length) { blocks.push({ _type: "block", _key: key(), style: "normal", ...inline(para.join(" ")) }); para = []; } };
	for (const raw of md.replace(/\r/g, "").split("\n")) {
		const line = raw.trim();
		const h = line.match(/^(#{1,4})\s+(.*)$/), ul = line.match(/^[-*•]\s+(.*)$/), ol = line.match(/^\d+[.)]\s+(.*)$/), q = line.match(/^>\s?(.*)$/);
		if (!line) { flush(); continue; }
		if (h) { flush(); blocks.push({ _type: "block", _key: key(), style: h[1].length <= 2 ? "h2" : "h3", ...inline(h[2].replace(/\*\*/g, "")) }); }
		else if (ul || ol) { flush(); blocks.push({ _type: "block", _key: key(), style: "normal", listItem: ul ? "bullet" : "number", level: 1, ...inline((ul ?? ol)![1]) }); }
		else if (q) { flush(); blocks.push({ _type: "block", _key: key(), style: "blockquote", ...inline(q[1]) }); }
		else para.push(line);
	}
	flush();
	return blocks;
}

// ---- posts ----

export interface PostInput { title: string; excerpt: string; markdown: string; bylineId: string; category?: string; tags?: string[]; slug?: string }

const err = (r: any) => new Error(`${r?.error?.code ?? "ERROR"}: ${r?.error?.message ?? "EmDash rejected the post"}`);

/** A short slug from the headline that no post uses yet (EmDash's own collision check builds a LIKE pattern from
 *  the full slug, which D1 rejects for long titles). */
async function freeSlug(title: string) {
	let base = title.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
	if (base.length > 60) base = base.slice(0, 60).replace(/-[^-]*$/, "");
	base ||= "story";
	for (let n = 1; n < 50; n++) {
		const slug = n === 1 ? base : `${base}-${n}`;
		if (!(await env.DB.prepare("SELECT 1 FROM ec_posts WHERE slug = ? LIMIT 1").bind(slug).first().catch(() => null))) return slug;
	}
	return `${base}-${Date.now().toString(36)}`;
}

/** Save a story as an EmDash draft post with the writer's byline. Returns the post id and slug. Category and tags are
 *  attached afterwards and may fail on their own (an unknown term never costs us the story or doubles the post). */
export async function createDraft(p: PostInput): Promise<{ id: string; slug: string }> {
	const slug = p.slug ?? (await freeSlug(p.title));
	return withEmDashRuntime(async (rt: any) => {
		const r = await rt.handleContentCreate("posts", {
			data: { title: p.title, excerpt: p.excerpt, content: mdToPortableText(p.markdown) },
			status: "draft", slug, bylines: [{ bylineId: p.bylineId }],
		});
		if (!r?.success) throw err(r);
		const item = r.data.item;
		const taxonomies = { ...(p.category ? { category: [p.category] } : {}), ...(p.tags?.length ? { tag: p.tags } : {}) };
		if (Object.keys(taxonomies).length) {
			const t = await rt.handleContentUpdate("posts", item.id, { taxonomies }).catch((e: unknown) => ({ success: false, error: { message: String(e) } }));
			if (!t?.success) console.error("newsroom: terms not attached", item.id, JSON.stringify(t?.error ?? null));
		}
		return { id: item.id, slug: item.slug };
	});
}

export async function publishPost(id: string) {
	return withEmDashRuntime(async (rt: any) => {
		const r = await rt.handleContentPublish("posts", id, {});
		if (!r?.success) throw err(r);
		return r.data;
	});
}

/** Append a dated correction note to a published post's body and republish. */
export async function appendCorrection(id: string, note: string) {
	return withEmDashRuntime(async (rt: any) => {
		const got = await rt.handleContentGet("posts", id);
		if (!got?.success) throw err(got);
		const item = got.data.item ?? got.data;
		const day = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
		const content = [...(item.data?.content ?? []), ...mdToPortableText(`**Correction, ${day}:** ${note}`)];
		const up = await rt.handleContentUpdate("posts", id, { data: { content } });
		if (!up?.success) throw err(up);
		if (item.status === "published") await rt.handleContentPublish("posts", id, {});
	});
}
