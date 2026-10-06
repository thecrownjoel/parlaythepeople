/**
 * Reader discussions on the data pages (race, candidate, forecasters, state, politics, results, daily): one thread
 * per page path, posted by signed-in readers under a display name (D1 ACCOUNTS: profiles, comments, comment_reports).
 * Every comment is screened by Llama Guard on Workers AI; flagged ones are held for a moderator. Three reports hide
 * a comment until a moderator looks. Analysis posts keep EmDash's own comments.
 */
import { env } from "cloudflare:workers";
import { aiRun } from "./ai";

const db = () => env.ACCOUNTS;
const now = () => Math.floor(Date.now() / 1000);
export const MAX_LEN = 2000;
const REPORTS_TO_HIDE = 3;

export interface Comment { id: string; page: string; user_id: string; parent: string | null; body: string; ts: number; status: string; name: string }

/** Only site paths, normalized with a trailing slash and no query, become threads. */
export function normalPage(p: string): string | null {
	const path = String(p ?? "").split(/[?#]/)[0];
	if (!/^\/[a-z0-9\-/]*$/i.test(path) || path.length > 200 || path.startsWith("/api/") || path.startsWith("/_")) return null;
	return path.endsWith("/") ? path : `${path}/`;
}

export async function listComments(page: string, limit = 200): Promise<Comment[]> {
	try {
		const { results } = await db().prepare(
			"SELECT c.id, c.page, c.user_id, c.parent, c.body, c.ts, c.status, COALESCE(p.name, 'Reader') AS name FROM comments c LEFT JOIN profiles p ON p.user_id = c.user_id WHERE c.page = ? AND c.status = 'visible' ORDER BY c.ts ASC LIMIT ?",
		).bind(page, limit).all<Comment>();
		return results ?? [];
	} catch {
		return [];
	}
}

export async function commentCount(page: string): Promise<number> {
	try {
		return (await db().prepare("SELECT COUNT(*) AS n FROM comments WHERE page = ? AND status = 'visible'").bind(page).first<{ n: number }>())?.n ?? 0;
	} catch {
		return 0;
	}
}

export async function profileName(userId: string): Promise<string | null> {
	return (await db().prepare("SELECT name FROM profiles WHERE user_id = ?").bind(userId).first<{ name: string }>().catch(() => null))?.name ?? null;
}

/** A display name readers choose: 2-40 characters, letters, numbers, spaces and . ' - _ only, and not an email. */
export function validName(n: string) {
	const s = n.trim().replace(/\s+/g, " ");
	return s.length >= 2 && s.length <= 40 && /^[\p{L}\p{N} .'\-_]+$/u.test(s) && !s.includes("@") ? s : null;
}
export async function setProfileName(userId: string, name: string) {
	await db().prepare("INSERT INTO profiles (user_id, name, created) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name").bind(userId, name, now()).run();
}

/** Llama Guard's verdict on a comment: null if safe, or the category it flagged. Fails open (a broken check never blocks a reader). */
async function screen(body: string): Promise<string | null> {
	try {
		const res: any = await aiRun("@cf/meta/llama-guard-3-8b", { messages: [{ role: "user", content: body.slice(0, 4000) }], max_tokens: 20 }, { feature: "comment-screen" });
		const r = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
		// Workers AI returns {safe, categories}; the raw model text is "safe" or "unsafe\nS1,S10"
		if (r && typeof r === "object") return r.safe === false ? (r.categories ?? []).join(",") || "unsafe" : null;
		const text = String(r ?? "").trim().toLowerCase();
		return text.startsWith("unsafe") ? text.slice(6).trim().replace(/\s+/g, ",") || "unsafe" : null;
	} catch {
		return null;
	}
}

export type PostResult = { ok: true; comment: Comment; held: boolean } | { ok: false; error: string };

export async function postComment(o: { userId: string; page: string; body: string; parent?: string | null }): Promise<PostResult> {
	const body = o.body.replace(/\r/g, "").trim();
	if (body.length < 2) return { ok: false, error: "empty" };
	if (body.length > MAX_LEN) return { ok: false, error: "too_long" };
	if ((body.match(/https?:\/\//g) ?? []).length > 2) return { ok: false, error: "too_many_links" };
	const name = await profileName(o.userId);
	if (!name) return { ok: false, error: "name_required" };
	// a few comments a few minutes apart is a conversation; more is a flood
	const recent = (await db().prepare("SELECT COUNT(*) AS n FROM comments WHERE user_id = ? AND ts > ?").bind(o.userId, now() - 600).first<{ n: number }>())?.n ?? 0;
	if (recent >= 5) return { ok: false, error: "slow_down" };
	const dup = await db().prepare("SELECT 1 FROM comments WHERE user_id = ? AND page = ? AND body = ? AND ts > ?").bind(o.userId, o.page, body, now() - 3600).first();
	if (dup) return { ok: false, error: "duplicate" };
	let parent: string | null = null;
	if (o.parent) {
		const p = await db().prepare("SELECT id, parent FROM comments WHERE id = ? AND page = ?").bind(o.parent, o.page).first<{ id: string; parent: string | null }>();
		parent = p ? p.parent ?? p.id : null; // replies are one level deep
	}
	const flag = await screen(body);
	const c = { id: crypto.randomUUID(), page: o.page, user_id: o.userId, parent, body, ts: now(), status: flag ? "held" : "visible", name };
	await db().prepare("INSERT INTO comments (id, page, user_id, parent, body, ts, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(c.id, c.page, c.user_id, c.parent, c.body, c.ts, c.status, flag ? `safety check: ${flag}` : null).run();
	return { ok: true, comment: c, held: !!flag };
}

/** Hide a comment: its author, or a site moderator (EmDash editor or above). */
export async function hideComment(id: string, by: { userId?: string | null; moderator?: boolean }) {
	const c = await db().prepare("SELECT user_id FROM comments WHERE id = ?").bind(id).first<{ user_id: string }>();
	if (!c) return false;
	if (!by.moderator && c.user_id !== by.userId) return false;
	await db().prepare("UPDATE comments SET status = 'hidden', reason = ? WHERE id = ? OR parent = ?").bind(by.moderator ? "removed by a moderator" : "deleted by its author", id, by.moderator ? id : "-").run();
	return true;
}

export async function reportComment(id: string, reporter: string) {
	await db().prepare("INSERT OR IGNORE INTO comment_reports (comment_id, reporter, ts) VALUES (?, ?, ?)").bind(id, reporter, now()).run();
	const n = (await db().prepare("SELECT COUNT(*) AS n FROM comment_reports WHERE comment_id = ?").bind(id).first<{ n: number }>())?.n ?? 0;
	if (n >= REPORTS_TO_HIDE) await db().prepare("UPDATE comments SET status = 'held', reason = 'reported by readers' WHERE id = ? AND status = 'visible'").bind(id).run();
}

/** For moderators: held and recently reported comments. */
export async function moderationQueue(limit = 100) {
	const { results } = await db().prepare(
		`SELECT c.*, COALESCE(p.name, 'Reader') AS name, (SELECT COUNT(*) FROM comment_reports r WHERE r.comment_id = c.id) AS reports
		 FROM comments c LEFT JOIN profiles p ON p.user_id = c.user_id WHERE c.status = 'held' OR c.id IN (SELECT comment_id FROM comment_reports) ORDER BY c.ts DESC LIMIT ?`,
	).bind(limit).all<any>();
	return results ?? [];
}
export async function setStatus(id: string, status: "visible" | "hidden") {
	await db().prepare("UPDATE comments SET status = ?, reason = ? WHERE id = ?").bind(status, status === "visible" ? "approved by a moderator" : "removed by a moderator", id).run();
	if (status === "visible") await db().prepare("DELETE FROM comment_reports WHERE comment_id = ?").bind(id).run();
}
