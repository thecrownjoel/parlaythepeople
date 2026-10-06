/**
 * The Parlay Newsroom's staff: writer profiles (newsroom_writers on ACCOUNTS), the formats they write, perspectives,
 * budgets and settings. See docs/newsroom-architecture.md.
 */
import { env } from "cloudflare:workers";

export const db = () => env.ACCOUNTS;
export const now = () => Math.floor(Date.now() / 1000);
export const DAY = 86400;
export const newId = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;

export interface Cadence { per_week: number; daily_cap: number; days: number[]; hours: [number, number]; breaking: boolean }
export interface Triggers { move_pts: number; money_usd: number; outside_usd: number; poll_gap_pts: number }
export interface Writer {
	id: string; byline_id: string | null; name: string; slug: string; kind: "ai" | "human"; age: number | null; bio: string | null;
	photo_media_id: string | null; beats: string[]; geography: string[]; places: string[]; perspective: number; formats: string[];
	cadence: Cadence; triggers: Triggers; voice: string | null; samples: string | null; sources: { feeds: string[]; block: string[] };
	approval: "drafts" | "auto"; auto_formats: string[]; budget_cents: number; active: number; vacation_until: number | null;
	tips: number; email: string | null; created: number; updated: number;
}

export const DEFAULT_CADENCE: Cadence = { per_week: 2, daily_cap: 1, days: [1, 2, 3, 4, 5], hours: [7, 19], breaking: true };
export const DEFAULT_TRIGGERS: Triggers = { move_pts: 5, money_usd: 250000, outside_usd: 1000000, poll_gap_pts: 8 };

export const BEATS: Record<string, string> = {
	senate: "Senate races", house: "House races", governor: "Governor races", president: "2028 presidential race",
	money: "Money in politics", polls: "Polls vs. markets", markets: "Market moves and big bets", natsec: "National security",
	agriculture: "Agriculture", economy: "Economy", immigration: "Immigration", health: "Health care", energy: "Energy",
	courts: "Courts", voting: "Voting and elections administration", world: "World politics", local: "Local politics",
};

export interface Format { label: string; words: [number, number]; brief: string; opinion: boolean }
export const FORMATS: Record<string, Format> = {
	brief: { label: "News brief", words: [250, 450], opinion: false, brief: "A short, fast news brief: what happened, the numbers, why it matters, what to watch. Inverted pyramid." },
	market: { label: "Market analysis", words: [500, 850], opinion: false, brief: "A market analysis: how the odds moved on Kalshi and Polymarket, who put money behind it, what the polls, money and news say, and whether the move looks durable. Analytical, specific." },
	column: { label: "Opinion column", words: [600, 900], opinion: true, brief: "An opinion column with a clear argument from the writer's perspective, built on the facts in the source log. Argue the interpretation, never the facts." },
	roundup: { label: "Weekly roundup", words: [700, 1100], opinion: false, brief: "A weekly roundup of the writer's beat: the five or so things that moved this week, each with its number and a line on why it matters, then the week ahead." },
	explainer: { label: "Explainer", words: [600, 1000], opinion: false, brief: "An explainer that answers one question a reader would ask (\"Why did the odds in Maine swing?\"), plainly, with the numbers and the background." },
};

export const PERSPECTIVES: Record<string, { label: string; lens: string; line: (first: string) => string | null }> = {
	"-2": { label: "Strong D", lens: "a progressive Democratic perspective: sympathetic to Democratic candidates and policies, skeptical of Republicans", line: (f) => `${f} writes from a progressive perspective.` },
	"-1": { label: "Lean D", lens: "a center-left perspective: generally sympathetic to Democrats, open to criticism of both parties", line: (f) => `${f} writes from a center-left perspective.` },
	"0": { label: "Neutral", lens: "a neutral, nonpartisan perspective: report and analyze without favoring either party", line: () => null },
	"1": { label: "Lean R", lens: "a center-right perspective: generally sympathetic to Republicans, open to criticism of both parties", line: (f) => `${f} writes from a center-right perspective.` },
	"2": { label: "Strong R", lens: "an unapologetically pro-Republican perspective: a partisan advocate for the GOP. Lead with every number that favors Republicans, frame races as the GOP's to win, treat Democratic gains as temporary or overhyped, and argue Republicans have the momentum. Where the numbers favor a Democrat, say so plainly in one sentence, then argue the Republican path back; never misstate who leads", line: (f) => `${f} writes from a pro-Republican perspective.` },
};
export const perspectiveOf = (p: number) => PERSPECTIVES[String(Math.max(-2, Math.min(2, Math.round(p))))];

const j = <T>(s: unknown, d: T): T => { try { return s == null || s === "" ? d : (JSON.parse(String(s)) as T); } catch { return d; } };

export function rowToWriter(r: any): Writer {
	return {
		...r, beats: j(r.beats, []), geography: j(r.geography, ["US"]), places: j(r.places, []), formats: j(r.formats, ["brief"]),
		cadence: { ...DEFAULT_CADENCE, ...j(r.cadence, {}) }, triggers: { ...DEFAULT_TRIGGERS, ...j(r.triggers, {}) },
		sources: { feeds: [], block: [], ...j(r.sources, {}) }, auto_formats: j(r.auto_formats, []),
	};
}

export async function listWriters(): Promise<Writer[]> {
	const { results } = await db().prepare("SELECT * FROM newsroom_writers ORDER BY active DESC, name").all();
	return (results ?? []).map(rowToWriter);
}
export async function getWriter(id: string): Promise<Writer | null> {
	const r = await db().prepare("SELECT * FROM newsroom_writers WHERE id = ? OR slug = ?").bind(id, id).first();
	return r ? rowToWriter(r) : null;
}
export async function writerByByline(bylineId: string): Promise<Writer | null> {
	const r = await db().prepare("SELECT * FROM newsroom_writers WHERE byline_id = ?").bind(bylineId).first().catch(() => null);
	return r ? rowToWriter(r) : null;
}

export async function saveWriter(w: Writer) {
	w.updated = now();
	await db().prepare(`INSERT INTO newsroom_writers (id, byline_id, name, slug, kind, age, bio, photo_media_id, beats, geography, places, perspective, formats, cadence, triggers, voice, samples, sources, approval, auto_formats, budget_cents, active, vacation_until, tips, email, created, updated)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET byline_id = excluded.byline_id, name = excluded.name, slug = excluded.slug, kind = excluded.kind, age = excluded.age, bio = excluded.bio,
		photo_media_id = excluded.photo_media_id, beats = excluded.beats, geography = excluded.geography, places = excluded.places, perspective = excluded.perspective,
		formats = excluded.formats, cadence = excluded.cadence, triggers = excluded.triggers, voice = excluded.voice, samples = excluded.samples, sources = excluded.sources,
		approval = excluded.approval, auto_formats = excluded.auto_formats, budget_cents = excluded.budget_cents, active = excluded.active,
		vacation_until = excluded.vacation_until, tips = excluded.tips, email = excluded.email, updated = excluded.updated`)
		.bind(w.id, w.byline_id, w.name, w.slug, w.kind, w.age, w.bio, w.photo_media_id, JSON.stringify(w.beats), JSON.stringify(w.geography), JSON.stringify(w.places),
			w.perspective, JSON.stringify(w.formats), JSON.stringify(w.cadence), JSON.stringify(w.triggers), w.voice, w.samples, JSON.stringify(w.sources), w.approval,
			JSON.stringify(w.auto_formats), w.budget_cents, w.active, w.vacation_until, w.tips, w.email, w.created, w.updated).run();
}

/** Is this writer working right now (active, not on vacation, inside their days and hours, Eastern)? */
export function onShift(w: Writer, at = new Date()) {
	if (!w.active || w.kind !== "ai") return false;
	if (w.vacation_until && w.vacation_until > at.getTime() / 1000) return false;
	const et = new Date(at.toLocaleString("en-US", { timeZone: "America/New_York" }));
	const [start, end] = w.cadence.hours;
	return w.cadence.days.includes(et.getDay()) && et.getHours() >= start && et.getHours() < end;
}

export async function spentCents(writerId: string, since = monthStart()) {
	const r = await db().prepare("SELECT SUM(cost_usd) AS c FROM newsroom_costs WHERE writer_id = ? AND ts >= ?").bind(writerId, since).first<{ c: number | null }>();
	return Math.round((r?.c ?? 0) * 100);
}
export function monthStart(at = new Date()) {
	return Math.floor(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1) / 1000);
}

/** Stories assigned to a writer since `ts` that weren't dropped or killed (what counts against their cadence). */
export async function storiesSince(writerId: string, ts: number) {
	const r = await db().prepare("SELECT COUNT(*) AS n FROM newsroom_assignments WHERE writer_id = ? AND created >= ? AND status NOT IN ('dropped', 'killed')").bind(writerId, ts).first<{ n: number }>();
	return r?.n ?? 0;
}

export interface Settings { daily_cap: number; monthly_budget_cents: number; model: string; debate_pairs: boolean; quiet: [number, number] | null; paused: boolean; notify_email: string | null }
export const DEFAULT_SETTINGS: Settings = { daily_cap: 6, monthly_budget_cents: 5000, model: "@cf/zai-org/glm-5.3", debate_pairs: false, quiet: [23, 6], paused: false, notify_email: null };

export async function getSettings(): Promise<Settings> {
	const { results } = await db().prepare("SELECT key, value FROM newsroom_settings").all<{ key: string; value: string }>().catch(() => ({ results: [] as { key: string; value: string }[] }));
	const s: any = { ...DEFAULT_SETTINGS };
	for (const r of results ?? []) s[r.key] = j(r.value, s[r.key]);
	return s;
}
export async function setSettings(patch: Partial<Settings>) {
	for (const [k, v] of Object.entries(patch)) {
		await db().prepare("INSERT INTO newsroom_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(k, JSON.stringify(v)).run();
	}
}
