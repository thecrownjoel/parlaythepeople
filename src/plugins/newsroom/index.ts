/**
 * The Newsroom plugin: manage the Parlay Newsroom's writers, story queue and drafts from the EmDash admin
 * (Block Kit pages at /_emdash/admin/plugins/newsroom/…). A native plugin because it needs the site's bindings
 * (Workers AI, the ACCOUNTS database, the NEWSROOM workflow). The engine lives in src/lib/newsroom/.
 */
import { env } from "cloudflare:workers";
import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { BEATS, FORMATS, PERSPECTIVES, db, now, DAY, getWriter, listWriters, saveWriter, getSettings, setSettings, spentCents, storiesSince, monthStart, perspectiveOf, type Writer } from "../../lib/newsroom/writers";
import { inventPersona, paintPortrait, writerFromPersona } from "../../lib/newsroom/persona";
import { upsertByline, deleteByline, publishPost, appendCorrection } from "../../lib/newsroom/cms";
import { assign, runDesk } from "../../lib/newsroom/desk";
import { recentSignals } from "../../lib/newsroom/signals";
import { STATES } from "../../lib/states";
import { resolveSeason, activePin, setPin, previewDates } from "../../lib/season";
import { moderationQueue, setStatus as setCommentStatus } from "../../lib/comments";

type Block = Record<string, unknown>;
type Res = { blocks: Block[]; toast?: { message: string; type: "success" | "error" | "info" } };

const opts = (o: Record<string, string>) => Object.entries(o).map(([value, label]) => ({ label, value }));
const PERSP_OPTS = Object.entries(PERSPECTIVES).sort((a, b) => +a[0] - +b[0]).map(([value, p]) => ({ label: p.label, value }));
const FORMAT_OPTS = Object.entries(FORMATS).map(([value, f]) => ({ label: f.label, value }));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(",")).map((s) => s.trim()).filter(Boolean);
const geo = (v: unknown) => { const g = list(v).map((s) => s.toUpperCase()).filter((s) => s === "US" || STATES[s]); return g.length ? g : ["US"]; };
const ago = (ts: number) => { const s = now() - ts; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < DAY ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / DAY)}d ago`; };
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const photoUrl = async (mediaId: string | null) => {
	if (!mediaId) return null;
	const r = await env.DB.prepare("SELECT storage_key FROM media WHERE id = ?").bind(mediaId).first<{ storage_key: string }>().catch(() => null);
	return r?.storage_key ? `/_emdash/api/media/file/${r.storage_key}` : null;
};

// ---- pages ----

async function writersPage(): Promise<Res> {
	const writers = await listWriters();
	const weekAgo = now() - 7 * DAY;
	const rows = await Promise.all(writers.map(async (w) => ({
		name: w.name, kind: w.kind === "ai" ? "AI writer" : "Human", beats: w.beats.map((b) => BEATS[b] ?? b).join(", "), where: [...w.geography, ...w.places].join(", "),
		lens: perspectiveOf(w.perspective).label, pace: `${w.cadence.per_week}/wk`, week: await storiesSince(w.id, weekAgo),
		spent: w.kind === "ai" ? `${usd(await spentCents(w.id))} of ${usd(w.budget_cents)}` : "—",
		status: !w.active ? "Off" : w.vacation_until && w.vacation_until > now() ? "Vacation" : "Active",
		edit: { type: "button", action_id: "edit", label: "Edit", value: w.id },
	})));
	const month = (await db().prepare("SELECT SUM(cost_usd) AS c FROM newsroom_costs WHERE ts >= ?").bind(monthStart()).first<{ c: number | null }>())?.c ?? 0;
	const s = await getSettings();
	return {
		blocks: [
			{ type: "header", text: "Writers" },
			{ type: "stats", items: [
				{ label: "On staff", value: writers.filter((w) => w.active).length, description: `${writers.filter((w) => w.kind === "ai").length} AI · ${writers.filter((w) => w.kind === "human").length} human` },
				{ label: "Stories this week", value: rows.reduce((a, r) => a + r.week, 0) },
				{ label: "AI spend this month", value: usd(month * 100), description: `cap ${usd(s.monthly_budget_cents)}` },
				{ label: "Desk", value: s.paused ? "Paused" : "Running", trend: s.paused ? "down" : "up" },
			] },
			writers.length
				? { type: "table", page_action_id: "writers_page", columns: [
					{ key: "name", label: "Name" }, { key: "kind", label: "Kind", format: "badge" }, { key: "beats", label: "Beats" }, { key: "where", label: "Covers" },
					{ key: "lens", label: "Perspective", format: "badge" }, { key: "pace", label: "Pace" }, { key: "week", label: "This week", format: "number" },
					{ key: "spent", label: "AI this month" }, { key: "status", label: "Status", format: "badge" }, { key: "edit", label: "", format: "element" },
				], rows }
				: { type: "empty", title: "No writers yet", description: "Hire your first AI writer below: the newsroom invents a name, bio, voice and portrait." },
			{ type: "divider" },
			{ type: "header", text: "Hire an AI writer" },
			{ type: "context", text: "Workers AI invents a fictional person (name, age, hometown, bio, voice) and FLUX paints a photorealistic portrait of someone who doesn't exist. AI writers carry an AI-writer label on their byline and author page. Takes about 30 seconds." },
			{ type: "form", block_id: "hire", fields: [
				{ type: "checkbox", action_id: "beats", label: "Beats", options: opts(BEATS), initial_value: ["senate", "markets"] },
				{ type: "text_input", action_id: "geography", label: "Coverage: US for national, or state codes", placeholder: "US  or  OH, MI", initial_value: "US" },
				{ type: "text_input", action_id: "places", label: "Cities or regions (optional, for local news)", placeholder: "Cleveland, Detroit" },
				{ type: "select", action_id: "perspective", label: "Perspective", options: PERSP_OPTS, initial_value: "0" },
				{ type: "checkbox", action_id: "formats", label: "Formats", options: FORMAT_OPTS, initial_value: ["brief", "market"] },
				{ type: "number_input", action_id: "per_week", label: "Stories per week", initial_value: 3, min: 1, max: 14 },
				{ type: "text_input", action_id: "hint", label: "Anything about the persona (optional)", placeholder: "e.g. a former farm-state reporter; dry humor", multiline: true },
			], submit: { label: "Hire this writer", action_id: "hire" } },
			{ type: "header", text: "Add a human writer" },
			{ type: "form", block_id: "human", fields: [
				{ type: "text_input", action_id: "name", label: "Name" },
				{ type: "text_input", action_id: "email", label: "Email (for story tips)" },
				{ type: "text_input", action_id: "bio", label: "Bio", multiline: true },
				{ type: "checkbox", action_id: "beats", label: "Beats", options: opts(BEATS) },
				{ type: "text_input", action_id: "geography", label: "Coverage", initial_value: "US" },
			], submit: { label: "Add writer", action_id: "add_human" } },
		],
	};
}

async function editPage(w: Writer): Promise<Res> {
	const photo = await photoUrl(w.photo_media_id);
	const blocks: Block[] = [
		{ type: "actions", elements: [{ type: "link", label: "← All writers", target: { kind: "plugin-page", path: "/writers" } }, ...(w.slug ? [{ type: "link", label: "Author page ↗", target: { kind: "external", url: `/authors/${w.slug}/` } }] : [])] },
		{ type: "header", text: w.name },
	];
	if (photo) blocks.push({ type: "columns", columns: [[{ type: "image", url: photo, alt: `${w.name}, portrait` }], [{ type: "fields", fields: [
		{ label: "Kind", value: w.kind === "ai" ? "AI writer (fictional persona)" : "Human writer" }, { label: "Age", value: String(w.age ?? "—") },
		{ label: "Perspective", value: perspectiveOf(w.perspective).label }, { label: "AI this month", value: `${usd(await spentCents(w.id))} of ${usd(w.budget_cents)}` },
	] }]] });
	blocks.push(
		{ type: "form", block_id: `w:${w.id}`, fields: [
			{ type: "text_input", action_id: "name", label: "Name", initial_value: w.name },
			{ type: "number_input", action_id: "age", label: "Age", initial_value: w.age ?? 0, min: 0, max: 99 },
			{ type: "text_input", action_id: "bio", label: "Bio (author page)", initial_value: w.bio ?? "", multiline: true },
			{ type: "checkbox", action_id: "beats", label: "Beats", options: opts(BEATS), initial_value: w.beats },
			{ type: "text_input", action_id: "geography", label: "Coverage: US or state codes", initial_value: w.geography.join(", ") },
			{ type: "text_input", action_id: "places", label: "Cities or regions", initial_value: w.places.join(", ") },
			{ type: "select", action_id: "perspective", label: "Perspective", options: PERSP_OPTS, initial_value: String(w.perspective) },
			{ type: "checkbox", action_id: "formats", label: "Formats", options: FORMAT_OPTS, initial_value: w.formats },
			{ type: "number_input", action_id: "per_week", label: "Stories per week (target)", initial_value: w.cadence.per_week, min: 0, max: 21 },
			{ type: "number_input", action_id: "daily_cap", label: "Most stories in a day", initial_value: w.cadence.daily_cap, min: 1, max: 6 },
			{ type: "checkbox", action_id: "days", label: "Working days", options: DAYS.map((d, i) => ({ label: d, value: String(i) })), initial_value: w.cadence.days.map(String) },
			{ type: "number_input", action_id: "start", label: "Shift starts (hour, Eastern)", initial_value: w.cadence.hours[0], min: 0, max: 23 },
			{ type: "number_input", action_id: "end", label: "Shift ends (hour, Eastern)", initial_value: w.cadence.hours[1], min: 1, max: 24 },
			{ type: "toggle", action_id: "breaking", label: "Big stories can exceed the weekly target", initial_value: w.cadence.breaking },
			{ type: "number_input", action_id: "move_pts", label: "Odds move that counts as news (points)", initial_value: w.triggers.move_pts, min: 1, max: 50 },
			{ type: "number_input", action_id: "money_usd", label: "Money that counts as news ($ traded)", initial_value: w.triggers.money_usd, min: 0 },
			{ type: "number_input", action_id: "poll_gap_pts", label: "Poll vs. market gap that counts (points)", initial_value: w.triggers.poll_gap_pts, min: 0, max: 50 },
			{ type: "text_input", action_id: "voice", label: "Voice (style instructions)", initial_value: w.voice ?? "", multiline: true },
			{ type: "text_input", action_id: "samples", label: "Sample paragraphs", initial_value: w.samples ?? "", multiline: true },
			{ type: "text_input", action_id: "feeds", label: "Extra RSS feeds (comma-separated)", initial_value: w.sources.feeds.join(", ") },
			{ type: "text_input", action_id: "block", label: "Blocked domains", initial_value: w.sources.block.join(", ") },
			{ type: "select", action_id: "approval", label: "Approval", options: [{ label: "Every draft waits for the editor", value: "drafts" }, { label: "Auto-publish chosen formats", value: "auto" }], initial_value: w.approval },
			{ type: "checkbox", action_id: "auto_formats", label: "Formats that may auto-publish", options: FORMAT_OPTS, initial_value: w.auto_formats, condition: { field: "approval", eq: "auto" } },
			{ type: "number_input", action_id: "budget", label: "Monthly AI budget ($)", initial_value: w.budget_cents / 100, min: 0, max: 500 },
			{ type: "toggle", action_id: "active", label: "Active", initial_value: !!w.active },
			{ type: "date_input", action_id: "vacation", label: "On vacation until (optional)", initial_value: w.vacation_until ? new Date(w.vacation_until * 1000).toISOString().slice(0, 10) : undefined },
		], submit: { label: "Save", action_id: "save_writer" } },
		{ type: "header", text: "Give them a story" },
		{ type: "form", block_id: `tip:${w.id}`, fields: [
			{ type: "text_input", action_id: "note", label: "The assignment", placeholder: "e.g. Why traders moved toward the Democrat in the Maine Senate race this week", multiline: true },
			{ type: "select", action_id: "format", label: "Format", options: FORMAT_OPTS.filter((f) => w.formats.includes(f.value)), initial_value: w.formats[0] },
		], submit: { label: "Assign", action_id: "tip" } },
		{ type: "actions", elements: [
			...(w.kind === "ai" ? [{ type: "button", action_id: "repaint", label: "New portrait", value: w.id, style: "secondary" }] : []),
			{ type: "button", action_id: "delete", label: "Remove writer", value: w.id, style: "danger", confirm: { title: `Remove ${w.name}?`, text: "Their byline is removed from the staff; published posts keep it only if you reassign them in EmDash.", confirm: "Remove", deny: "Cancel", style: "danger" } },
		] },
	);
	return { blocks };
}

async function queuePage(): Promise<Res> {
	const signals = (await recentSignals(24)).slice(0, 25);
	const writers = (await listWriters()).filter((w) => w.active);
	const { results } = await db().prepare("SELECT a.*, w.name AS writer FROM newsroom_assignments a LEFT JOIN newsroom_writers w ON w.id = a.writer_id ORDER BY a.created DESC LIMIT 60").all<any>();
	return {
		blocks: [
			{ type: "header", text: "Story queue" },
			{ type: "actions", elements: [{ type: "button", action_id: "run_desk", label: "Run the assignment desk now", style: "primary" }] },
			{ type: "table", page_action_id: "queue_page", empty_text: "No stories assigned yet.", columns: [
				{ key: "when", label: "Assigned" }, { key: "writer", label: "Writer" }, { key: "format", label: "Format", format: "badge" }, { key: "story", label: "Story" },
				{ key: "status", label: "Status", format: "badge" }, { key: "reason", label: "Note" },
			], rows: (results ?? []).map((a) => ({ when: ago(a.created), writer: a.writer ?? "?", format: FORMATS[a.format]?.label ?? a.format, story: (a.note ?? a.signal_id ?? "").slice(0, 90), status: a.status, reason: (a.reason ?? "").slice(0, 120) })) },
			{ type: "divider" },
			{ type: "header", text: "What's news (last 24 hours)" },
			{ type: "context", text: "Signals from our odds, money, polls, forecaster ratings and the calendar, scored 0–100. The desk matches them to writers every hour; assign one by hand here." },
			signals.length && writers.length
				? { type: "form", block_id: "manual", fields: [
					{ type: "radio", action_id: "signal", label: "Story", options: signals.map((s) => ({ label: `${Math.round(s.score)} · ${s.title}`.slice(0, 140), value: s.id })) },
					{ type: "select", action_id: "writer", label: "Writer", options: writers.map((w) => ({ label: `${w.name} (${perspectiveOf(w.perspective).label})`, value: w.id })) },
					{ type: "select", action_id: "format", label: "Format", options: FORMAT_OPTS, initial_value: "brief" },
				], submit: { label: "Assign this story", action_id: "assign_signal" } }
				: { type: "empty", title: signals.length ? "No active writers" : "No signals yet", description: "Signals are collected every hour; or run the desk now." },
		],
	};
}

async function draftsPage(): Promise<Res> {
	const { results } = await db().prepare(
		"SELECT d.*, a.status, a.format, a.reason, w.name AS writer FROM newsroom_drafts d JOIN newsroom_assignments a ON a.id = d.assignment_id LEFT JOIN newsroom_writers w ON w.id = a.writer_id ORDER BY (a.status = 'ready') DESC, d.created DESC LIMIT 30",
	).all<any>();
	const blocks: Block[] = [{ type: "header", text: "Drafts" }];
	if (!results?.length) blocks.push({ type: "empty", title: "No drafts yet", description: "Drafts land here after they pass the fact-check." });
	for (const d of results ?? []) {
		const chk = JSON.parse(d.check_report || "{}");
		const facts = JSON.parse(d.source_log || "[]");
		const claims = chk.claims ?? [];
		const ok = claims.filter((c: any) => c.status === "supported").length;
		blocks.push(
			{ type: "section", text: `**${d.headline}**\n${d.dek ?? ""}\n${d.writer ?? "?"} · ${FORMATS[d.format]?.label ?? d.format} · ${d.label === "perspective" ? "Perspective" : "News"} · ${ago(d.created)} · ${usd(Math.round((d.cost_usd ?? 0) * 100))} AI` },
			{ type: "fields", fields: [{ label: "Status", value: d.status }, { label: "Fact-check", value: `${chk.verdict ?? "?"}: ${ok}/${claims.length} claims supported` }, { label: "Sources", value: `${facts.length} facts` }] },
			{ type: "accordion", label: "Sources and checks", blocks: [
				{ type: "section", text: facts.map((f: any) => `[${f.id}] ${f.fact} — ${f.source}${f.url ? ` (${f.url})` : ""}`).join("\n").slice(0, 6000) || "No sources." },
				{ type: "section", text: claims.filter((c: any) => c.status !== "supported").map((c: any) => `⚠ ${c.text}: ${c.status}${c.note ? `, ${c.note}` : ""}`).join("\n") || "Every claim checked out." },
			] },
			{ type: "actions", elements: [
				...(d.post_id ? [{ type: "link", label: "Edit in EmDash", target: { kind: "content", collection: "posts", id: d.post_id } }] : []),
				...(d.status === "ready" && d.post_id ? [{ type: "button", action_id: "publish", label: "Publish", value: d.assignment_id, style: "primary", confirm: { title: "Publish this story?", text: d.headline, confirm: "Publish", deny: "Cancel" } }] : []),
				...(d.status === "ready" ? [{ type: "button", action_id: "kill", label: "Kill", value: d.assignment_id, style: "danger" }] : []),
				...(d.status === "published" && d.post_id ? [{ type: "button", action_id: "correct", label: "Add a correction", value: d.assignment_id, style: "secondary" }] : []),
			] },
			{ type: "divider" },
		);
	}
	return { blocks };
}

async function balancePage(): Promise<Res> {
	const since = now() - 30 * DAY;
	const { results } = await db().prepare("SELECT w.perspective, w.beats, w.geography, COUNT(*) AS n FROM newsroom_assignments a JOIN newsroom_writers w ON w.id = a.writer_id WHERE a.created >= ? AND a.status IN ('ready', 'published') GROUP BY w.id").bind(since).all<any>();
	const by = new Map<string, number>();
	for (const r of results ?? []) by.set(perspectiveOf(r.perspective).label, (by.get(perspectiveOf(r.perspective).label) ?? 0) + r.n);
	const total = [...by.values()].reduce((a, b) => a + b, 0);
	return { blocks: [
		{ type: "header", text: "Balance (last 30 days)" },
		{ type: "context", text: "Stories that passed the fact-check, by the writer's perspective. Use debate pairs in Settings to cover big stories from both sides." },
		...PERSP_OPTS.map((p) => ({ type: "meter", label: p.label, value: by.get(p.label) ?? 0, max: Math.max(1, total), custom_value: `${by.get(p.label) ?? 0} stories` })),
	] };
}

async function commentsPage(): Promise<Res> {
	const q = await moderationQueue(60).catch(() => []);
	const blocks: Block[] = [
		{ type: "header", text: "Reader comments" },
		{ type: "context", text: "Comments held by the automatic safety check, or reported by readers (three reports hide a comment until you decide). Everything else posts right away." },
	];
	if (!q.length) blocks.push({ type: "empty", title: "Nothing to review", description: "Held and reported comments show up here." });
	for (const c of q) {
		blocks.push(
			{ type: "section", text: `**${c.name}** on ${c.page} · ${ago(c.ts)} · ${c.status}${c.reports ? ` · ${c.reports} report${c.reports === 1 ? "" : "s"}` : ""}${c.reason ? ` · ${c.reason}` : ""}\n${String(c.body).slice(0, 1500)}` },
			{ type: "actions", elements: [
				{ type: "link", label: "Open page ↗", target: { kind: "external", url: `${c.page}#discuss` } },
				...(c.status !== "visible" ? [{ type: "button", action_id: "comment_ok", label: "Approve", value: c.id, style: "primary" }] : [{ type: "button", action_id: "comment_ok", label: "Keep (clear reports)", value: c.id }]),
				...(c.status !== "hidden" ? [{ type: "button", action_id: "comment_hide", label: "Remove", value: c.id, style: "danger" }] : []),
			] },
			{ type: "divider" },
		);
	}
	return { blocks };
}

async function homepagePage(): Promise<Res> {
	const season = await resolveSeason();
	const pin = await activePin();
	return { blocks: [
		{ type: "header", text: "Homepage" },
		{ type: "fields", fields: [
			{ label: "Season now", value: season.label },
			{ label: "Headline", value: season.h1 },
			{ label: "Modules, in order", value: season.modules.join(" → ") },
			{ label: "Pinned", value: pin ? `${pin.title} (until ${new Date(pin.until * 1000).toLocaleString("en-US", { timeZone: "America/New_York" })} ET)` : "Nothing pinned" },
		] },
		{ type: "context", text: "The season follows the election calendar on its own: final stretch → election night (switches at 6pm ET on Election Day) → aftermath → transition → governing → 2028 primaries. Preview any of them:" },
		{ type: "actions", elements: previewDates(season.eday).map((d) => ({ type: "link", label: `${d.label} ↗`, target: { kind: "external", url: `/?at=${d.at}` } })) },
		{ type: "divider" },
		{ type: "header", text: "Pin a moment" },
		{ type: "context", text: "A banner at the top of the homepage until the time you set: breaking news, a deadline, a debate tonight." },
		{ type: "form", block_id: "pin", fields: [
			{ type: "text_input", action_id: "title", label: "Headline", initial_value: pin?.title ?? "" },
			{ type: "text_input", action_id: "text", label: "One line under it (optional)", initial_value: pin?.text ?? "" },
			{ type: "text_input", action_id: "url", label: "Link (optional)", placeholder: "/posts/… or https://…", initial_value: pin?.url ?? "" },
			{ type: "number_input", action_id: "hours", label: "Keep it up for (hours)", initial_value: 12, min: 1, max: 336 },
			{ type: "select", action_id: "tone", label: "Style", options: [{ label: "News", value: "news" }, { label: "Alert (red)", value: "alert" }], initial_value: pin?.tone ?? "news" },
		], submit: { label: "Pin it", action_id: "save_pin" } },
		...(pin ? [{ type: "actions", elements: [{ type: "button", action_id: "clear_pin", label: "Remove the pin", style: "danger" }] }] : []),
	] };
}

async function settingsPage(): Promise<Res> {
	const s = await getSettings();
	return { blocks: [
		{ type: "header", text: "Newsroom settings" },
		{ type: "form", block_id: "settings", fields: [
			{ type: "toggle", action_id: "paused", label: "Pause the assignment desk", initial_value: s.paused },
			{ type: "number_input", action_id: "daily_cap", label: "Most stories a day, whole newsroom", initial_value: s.daily_cap, min: 0, max: 50 },
			{ type: "number_input", action_id: "budget", label: "Monthly AI budget, whole newsroom ($)", initial_value: s.monthly_budget_cents / 100, min: 0, max: 2000 },
			{ type: "select", action_id: "model", label: "Model", options: [{ label: "GLM 5.3 (best writing)", value: "@cf/zai-org/glm-5.3" }, { label: "gpt-oss-120b (cheaper)", value: "@cf/openai/gpt-oss-120b" }], initial_value: s.model },
			{ type: "toggle", action_id: "debate_pairs", label: "Debate pairs: big stories go to a Lean D and a Lean R writer at once", initial_value: s.debate_pairs },
			{ type: "number_input", action_id: "quiet_start", label: "Quiet hours start (Eastern)", initial_value: s.quiet?.[0] ?? 23, min: 0, max: 23 },
			{ type: "number_input", action_id: "quiet_end", label: "Quiet hours end (Eastern)", initial_value: s.quiet?.[1] ?? 6, min: 0, max: 23 },
			{ type: "text_input", action_id: "notify_email", label: "Email me new drafts at", initial_value: s.notify_email ?? "" },
		], submit: { label: "Save settings", action_id: "save_settings" } },
	] };
}

// ---- actions ----

async function hire(v: Record<string, unknown>, ctx: PluginContext): Promise<Res> {
	const o = { beats: list(v.beats), geography: geo(v.geography), places: list(v.places), perspective: Number(v.perspective ?? 0), formats: list(v.formats), per_week: Number(v.per_week ?? 3) };
	if (!o.beats.length) return { ...(await writersPage()), toast: { type: "error", message: "Pick at least one beat." } };
	const { persona, cost } = await inventPersona({ ...o, hint: String(v.hint ?? "") || undefined });
	const w = writerFromPersona(persona, o);
	if (await getWriter(w.slug)) w.slug = `${w.slug}-${Math.floor(Math.random() * 900 + 100)}`;
	try {
		const jpg = await paintPortrait(persona);
		const up = await (ctx.media as any).upload(`${w.slug}.jpg`, "image/jpeg", jpg.buffer);
		w.photo_media_id = up.mediaId;
	} catch (e) { console.error("portrait", String(e)); }
	w.byline_id = await upsertByline(w);
	await saveWriter(w);
	await db().prepare("INSERT INTO newsroom_costs (writer_id, assignment_id, step, cost_usd, tokens, ts) VALUES (?, NULL, 'hire', ?, 0, ?)").bind(w.id, cost, now()).run();
	return { ...(await editPage(w)), toast: { type: "success", message: `Hired ${w.name}, ${w.age}, from ${persona.hometown}.` } };
}

async function saveWriterForm(id: string, v: Record<string, unknown>): Promise<Res> {
	const w = await getWriter(id);
	if (!w) return { ...(await writersPage()), toast: { type: "error", message: "Writer not found." } };
	const n = (k: string, d: number) => (v[k] === undefined || v[k] === "" ? d : Number(v[k]));
	Object.assign(w, {
		name: String(v.name ?? w.name).trim() || w.name, age: n("age", w.age ?? 0) || null, bio: String(v.bio ?? w.bio ?? ""),
		beats: list(v.beats), geography: geo(v.geography), places: list(v.places), perspective: n("perspective", w.perspective), formats: list(v.formats).length ? list(v.formats) : w.formats,
		cadence: { per_week: n("per_week", w.cadence.per_week), daily_cap: n("daily_cap", w.cadence.daily_cap), days: list(v.days).map(Number), hours: [n("start", w.cadence.hours[0]), n("end", w.cadence.hours[1])], breaking: v.breaking !== false },
		triggers: { move_pts: n("move_pts", w.triggers.move_pts), money_usd: n("money_usd", w.triggers.money_usd), outside_usd: w.triggers.outside_usd, poll_gap_pts: n("poll_gap_pts", w.triggers.poll_gap_pts) },
		voice: String(v.voice ?? w.voice ?? ""), samples: String(v.samples ?? w.samples ?? ""), sources: { feeds: list(v.feeds), block: list(v.block) },
		approval: v.approval === "auto" ? "auto" : "drafts", auto_formats: list(v.auto_formats), budget_cents: Math.round(n("budget", w.budget_cents / 100) * 100),
		active: v.active === false ? 0 : 1, vacation_until: v.vacation ? Math.floor(Date.parse(`${v.vacation}T23:59:59-05:00`) / 1000) : null,
	});
	w.byline_id = await upsertByline(w);
	await saveWriter(w);
	return { ...(await editPage(w)), toast: { type: "success", message: "Saved." } };
}

async function handle(ctx: PluginContext & { input: any; user?: any }): Promise<Res> {
	const i = ctx.input ?? {};
	const page = String(i.page ?? "/writers");
	try {
		if (i.type === "page_load") {
			if (page === "/queue") return queuePage();
			if (page === "/drafts") return draftsPage();
			if (page === "/balance") return balancePage();
			if (page === "/settings") return settingsPage();
			if (page === "/homepage") return homepagePage();
			if (page === "/comments") return commentsPage();
			return writersPage();
		}
		const action = String(i.action_id ?? "");
		const v = (i.values ?? {}) as Record<string, unknown>;
		const block = String(i.block_id ?? "");
		switch (action) {
			case "edit": { const w = await getWriter(String(i.value)); return w ? editPage(w) : writersPage(); }
			case "hire": return hire(v, ctx);
			case "add_human": {
				const name = String(v.name ?? "").trim();
				if (!name) return { ...(await writersPage()), toast: { type: "error", message: "A name is required." } };
				const w = writerFromPersona({ name, age: 0, gender: "", hometown: "", background: "", bio: String(v.bio ?? ""), voice: "", samples: "", look: "" }, { beats: list(v.beats), geography: geo(v.geography), places: [], perspective: 0, formats: ["brief"] });
				Object.assign(w, { kind: "human", bio: String(v.bio ?? ""), email: String(v.email ?? "") || null, age: null, budget_cents: 0 });
				w.byline_id = await upsertByline(w);
				await saveWriter(w);
				return { ...(await editPage(w)), toast: { type: "success", message: `Added ${name}.` } };
			}
			case "save_writer": return saveWriterForm(block.replace(/^w:/, ""), v);
			case "repaint": {
				const w = await getWriter(String(i.value));
				if (!w) return writersPage();
				const look = `${w.age ?? 40}-year-old journalist, ${w.bio?.slice(0, 200) ?? ""}`;
				const jpg = await paintPortrait({ name: w.name, age: w.age ?? 40, gender: "", hometown: "", background: "", bio: "", voice: "", samples: "", look });
				const up = await (ctx.media as any).upload(`${w.slug}-${Date.now()}.jpg`, "image/jpeg", jpg.buffer);
				w.photo_media_id = up.mediaId;
				await upsertByline(w); await saveWriter(w);
				return { ...(await editPage(w)), toast: { type: "success", message: "New portrait." } };
			}
			case "delete": {
				const w = await getWriter(String(i.value));
				if (w) { await db().prepare("DELETE FROM newsroom_writers WHERE id = ?").bind(w.id).run(); if (w.byline_id) await deleteByline(w.byline_id).catch(() => null); }
				return { ...(await writersPage()), toast: { type: "success", message: "Removed." } };
			}
			case "tip": {
				const id = block.replace(/^tip:/, "");
				const note = String(v.note ?? "").trim();
				if (!note) return { ...(await editPage((await getWriter(id))!)), toast: { type: "error", message: "Describe the assignment." } };
				await assign(id, { note, format: String(v.format ?? "brief") });
				return { ...(await queuePage()), toast: { type: "success", message: "Assigned. Watch it here." } };
			}
			case "assign_signal": {
				if (!v.signal || !v.writer) return { ...(await queuePage()), toast: { type: "error", message: "Pick a story and a writer." } };
				await assign(String(v.writer), { signalId: String(v.signal), format: String(v.format ?? "brief") });
				return { ...(await queuePage()), toast: { type: "success", message: "Assigned." } };
			}
			case "run_desk": { const r = await runDesk(); return { ...(await queuePage()), toast: { type: "info", message: `${r.added ?? 0} new signals; ${r.assigned} stories assigned${(r as any).why ? ` (${(r as any).why})` : ""}.` } }; }
			case "publish": {
				const d = await db().prepare("SELECT post_id FROM newsroom_drafts WHERE assignment_id = ?").bind(String(i.value)).first<{ post_id: string }>();
				if (d?.post_id) { await publishPost(d.post_id); await db().prepare("UPDATE newsroom_assignments SET status = 'published', updated = ? WHERE id = ?").bind(now(), String(i.value)).run(); }
				return { ...(await draftsPage()), toast: { type: "success", message: "Published." } };
			}
			case "kill": {
				await db().prepare("UPDATE newsroom_assignments SET status = 'killed', reason = 'Killed by the editor', updated = ? WHERE id = ?").bind(now(), String(i.value)).run();
				return { ...(await draftsPage()), toast: { type: "info", message: "Killed. The EmDash draft stays in Posts; delete it there if you like." } };
			}
			case "correct": {
				const d = await db().prepare("SELECT post_id, headline FROM newsroom_drafts WHERE assignment_id = ?").bind(String(i.value)).first<{ post_id: string; headline: string }>();
				return { blocks: [
					{ type: "header", text: `Correction: ${d?.headline ?? ""}` },
					{ type: "form", block_id: `corr:${i.value}`, fields: [{ type: "text_input", action_id: "note", label: "The correction (appended to the post with today's date)", multiline: true }], submit: { label: "Append correction", action_id: "save_correction" } },
				] };
			}
			case "save_correction": {
				const aid = block.replace(/^corr:/, "");
				const d = await db().prepare("SELECT post_id FROM newsroom_drafts WHERE assignment_id = ?").bind(aid).first<{ post_id: string }>();
				const note = String(v.note ?? "").trim();
				if (d?.post_id && note) {
					await appendCorrection(d.post_id, note);
					await db().prepare("INSERT INTO newsroom_corrections (id, post_id, note, by, ts) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), d.post_id, note, ctx.user?.email ?? null, now()).run();
				}
				return { ...(await draftsPage()), toast: { type: "success", message: "Correction appended." } };
			}
			case "comment_ok": { await setCommentStatus(String(i.value), "visible"); return { ...(await commentsPage()), toast: { type: "success", message: "Approved." } }; }
			case "comment_hide": { await setCommentStatus(String(i.value), "hidden"); return { ...(await commentsPage()), toast: { type: "success", message: "Removed." } }; }
			case "save_pin": {
				const title = String(v.title ?? "").trim();
				if (!title) return { ...(await homepagePage()), toast: { type: "error", message: "A headline is required." } };
				const url = String(v.url ?? "").trim();
				await setPin({ title, text: String(v.text ?? "").trim() || null, url: /^(https?:\/\/|\/)/.test(url) ? url : null, until: now() + Math.max(1, Number(v.hours ?? 12)) * 3600, tone: v.tone === "alert" ? "alert" : "news" });
				return { ...(await homepagePage()), toast: { type: "success", message: "Pinned to the homepage." } };
			}
			case "clear_pin": { await setPin(null); return { ...(await homepagePage()), toast: { type: "success", message: "Pin removed." } }; }
			case "save_settings": {
				await setSettings({
					paused: v.paused === true, daily_cap: Number(v.daily_cap ?? 6), monthly_budget_cents: Math.round(Number(v.budget ?? 50) * 100), model: String(v.model ?? "@cf/zai-org/glm-5.3"),
					debate_pairs: v.debate_pairs === true, quiet: [Number(v.quiet_start ?? 23), Number(v.quiet_end ?? 6)], notify_email: String(v.notify_email ?? "").trim() || null,
				});
				return { ...(await settingsPage()), toast: { type: "success", message: "Settings saved." } };
			}
		}
		return writersPage();
	} catch (e) {
		console.error("newsroom admin", String(e));
		const base = page === "/queue" ? await queuePage() : page === "/drafts" ? await draftsPage() : page === "/settings" ? await settingsPage() : await writersPage().catch(() => ({ blocks: [] }));
		return { ...base, toast: { type: "error", message: String((e as Error)?.message ?? e).slice(0, 200) } };
	}
}

export const ADMIN_PAGES = [
	{ path: "/writers", label: "Writers", icon: "users" },
	{ path: "/queue", label: "Story queue", icon: "list" },
	{ path: "/drafts", label: "Drafts", icon: "file-text" },
	{ path: "/balance", label: "Balance", icon: "chart" },
	{ path: "/homepage", label: "Homepage", icon: "home" },
	{ path: "/comments", label: "Reader comments", icon: "message" },
	{ path: "/settings", label: "Settings", icon: "settings" },
];

export function createPlugin() {
	return definePlugin({
		id: "newsroom",
		version: "0.1.0",
		capabilities: ["media:write", "content:write", "content:publish"],
		admin: { pages: ADMIN_PAGES },
		routes: {
			admin: { permission: "plugins:manage" as any, handler: (ctx: any) => handle(ctx) },
		},
	} as any);
}
