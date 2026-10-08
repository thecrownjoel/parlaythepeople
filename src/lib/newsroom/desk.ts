/**
 * The assignment desk (hourly): match this hour's signals to the writers on shift, by beat, geography, triggers,
 * cadence and budget, and start one NewsroomWorkflow per assignment. Writers whose beats our data doesn't cover
 * (agriculture, national security…) get their story from the news on their beat instead.
 */
import { env } from "cloudflare:workers";
import { recentSignals, refreshSignals, type Signal } from "./signals";
import { headlinesFor } from "./news";
import { db, now, DAY, newId, listWriters, getSettings, onShift, spentCents, storiesSince, monthStart, isAvoided, type Writer, type Settings } from "./writers";

const covers = (w: Writer, s: Signal) =>
	(w.geography.includes("US") || w.geography.includes(s.geography) || s.geography === "US") && s.beats.some((b) => w.beats.includes(b));

/** Does the signal clear this writer's own thresholds? */
function clears(w: Writer, s: Signal) {
	const d = s.data as any;
	if (s.kind === "move" || s.kind === "flip") return (d.move_pts ?? 0) >= w.triggers.move_pts;
	if (s.kind === "money" || s.kind === "whale") return (d.money_usd ?? 0) >= w.triggers.money_usd;
	if (s.kind === "poll") return (d.poll_gap_pts ?? 0) >= w.triggers.poll_gap_pts;
	return true;
}

/** Which format a story gets from this writer. */
function formatFor(w: Writer, s: Signal): string {
	const has = (f: string) => w.formats.includes(f);
	const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
	if (has("roundup") && et.getDay() === 5 && s.kind === "roundup") return "roundup";
	if (s.kind === "keyword" && has("explainer")) return "explainer";
	if (w.perspective !== 0 && has("column") && (s.score >= 70 || !has("market"))) return "column";
	if (["move", "flip", "money", "whale", "split"].includes(s.kind) && has("market")) return "market";
	if (["poll", "rating", "split"].includes(s.kind) && has("explainer")) return "explainer";
	return has("brief") ? "brief" : w.formats[0] ?? "brief";
}

/** How many stories this writer is due this week so far (their weekly target spread over their working days). */
function due(w: Writer, doneThisWeek: number) {
	const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
	const days = w.cadence.days.length || 5;
	const elapsed = w.cadence.days.filter((d) => d < et.getDay() || (d === et.getDay() && et.getHours() >= (w.cadence.hours[0] + w.cadence.hours[1]) / 2)).length;
	return doneThisWeek < Math.ceil((w.cadence.per_week * Math.max(1, elapsed)) / days);
}

async function alreadyCovered(s: Signal, writerId: string) {
	const r = await db().prepare(
		`SELECT a.id FROM newsroom_assignments a LEFT JOIN newsroom_signals g ON g.id = a.signal_id
		 WHERE a.status NOT IN ('dropped', 'killed') AND a.created >= ? AND (a.signal_id = ? OR (g.key = ? AND g.key IS NOT NULL AND a.writer_id = ?)) LIMIT 1`,
	).bind(now() - 3 * DAY, s.id, s.key, writerId).first();
	return !!r;
}

export async function assign(writerId: string, o: { signalId?: string | null; format: string; note?: string | null; pairId?: string | null }) {
	const id = newId("a");
	const t = now();
	await db().prepare("INSERT INTO newsroom_assignments (id, writer_id, signal_id, format, status, pair_id, note, created, updated) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)")
		.bind(id, writerId, o.signalId ?? null, o.format, o.pairId ?? null, o.note ?? null, t, t).run();
	try {
		const inst = await (env as any).NEWSROOM.create({ id, params: { assignmentId: id } });
		await db().prepare("UPDATE newsroom_assignments SET workflow_id = ? WHERE id = ?").bind(inst.id ?? id, id).run();
	} catch (e) {
		await db().prepare("UPDATE newsroom_assignments SET status = 'dropped', reason = ? WHERE id = ?").bind(`Couldn't start: ${String(e).slice(0, 200)}`, id).run();
	}
	return id;
}

/** A news signal for a writer whose beat our data doesn't cover: the freshest headline on their beat and place. */
async function newsSignal(w: Writer, settings: Settings): Promise<Signal | null> {
	const hs = await headlinesFor({ beats: w.beats, geography: w.geography, places: w.places, feeds: w.sources.feeds, block: w.sources.block, topics: settings.record_topics, avoid: settings.record_avoid, limit: 8 });
	for (const h of hs) {
		const id = `news:${h.url}`.slice(0, 200);
		const seen = await db().prepare("SELECT 1 FROM newsroom_assignments WHERE signal_id = ? LIMIT 1").bind(id).first();
		if (seen) continue;
		const s: Signal = { id, kind: "news", key: null, title: h.title, data: { headline: h.title, source: h.source, url: h.url, published: h.published, related: hs.slice(0, 6) }, score: 50, geography: w.geography[0] ?? "US", beats: w.beats };
		await db().prepare("INSERT OR IGNORE INTO newsroom_signals (id, kind, key, title, data, score, geography, beats, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.bind(s.id, s.kind, s.key, s.title, JSON.stringify(s.data), s.score, s.geography, JSON.stringify(s.beats), now()).run();
		return s;
	}
	return null;
}

/** A search keyword for a record-beat writer: the most-searched one nobody has written up in 30 days, skipping
 *  avoided topics. Keywords are edited in Settings. */
async function keywordSignal(w: Writer, settings: Settings): Promise<Signal | null> {
	if (!w.beats.includes("record")) return null;
	const kws = [...settings.keywords].filter((k) => k.q && !isAvoided(k.q, settings.record_avoid)).sort((a, b) => b.searches - a.searches);
	for (const k of kws) {
		const id = `kw:${k.q.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${Math.floor(now() / (30 * DAY))}`;
		const seen = await db().prepare("SELECT 1 FROM newsroom_assignments a JOIN newsroom_signals g ON g.id = a.signal_id WHERE g.kind = 'keyword' AND g.title = ? AND a.created >= ? AND a.status NOT IN ('dropped', 'killed') LIMIT 1").bind(k.q, now() - 30 * DAY).first();
		if (seen) continue;
		const s: Signal = { id, kind: "keyword", key: null, title: k.q, data: { keyword: k.q, searches_per_month: k.searches || null }, score: 50, geography: "US", beats: ["record"] };
		await db().prepare("INSERT OR IGNORE INTO newsroom_signals (id, kind, key, title, data, score, geography, beats, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.bind(s.id, s.kind, s.key, s.title, JSON.stringify(s.data), s.score, s.geography, JSON.stringify(s.beats), now()).run();
		return s;
	}
	return null;
}

/** The hourly run: refresh signals, then give each writer on shift at most one story. */
export async function runDesk() {
	const settings = await getSettings();
	const sig = await refreshSignals();
	if (settings.paused) return { ...sig, assigned: 0, why: "paused" };
	const etHour = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
	if (settings.quiet && (settings.quiet[0] > settings.quiet[1] ? etHour >= settings.quiet[0] || etHour < settings.quiet[1] : etHour >= settings.quiet[0] && etHour < settings.quiet[1])) return { ...sig, assigned: 0, why: "quiet hours" };
	const today = (await db().prepare("SELECT COUNT(*) AS n FROM newsroom_assignments WHERE created >= ? AND status NOT IN ('dropped', 'killed')").bind(now() - DAY).first<{ n: number }>())?.n ?? 0;
	const month = (await db().prepare("SELECT SUM(cost_usd) AS c FROM newsroom_costs WHERE ts >= ?").bind(monthStart()).first<{ c: number | null }>())?.c ?? 0;
	if (month * 100 >= settings.monthly_budget_cents) return { ...sig, assigned: 0, why: "newsroom budget reached" };
	let left = settings.daily_cap - today;
	const signals = await recentSignals(6);
	const writers = (await listWriters()).filter((w) => onShift(w));
	const out: string[] = [];
	// writers furthest behind their weekly target go first
	const weekAgo = now() - 7 * DAY;
	const ranked = await Promise.all(writers.map(async (w) => ({ w, week: await storiesSince(w.id, weekAgo), day: await storiesSince(w.id, now() - DAY) })));
	ranked.sort((a, b) => a.week / Math.max(1, a.w.cadence.per_week) - b.week / Math.max(1, b.w.cadence.per_week));
	for (const { w, week, day } of ranked) {
		if (left <= 0) break;
		if (day >= w.cadence.daily_cap) continue;
		if ((await spentCents(w.id)) >= w.budget_cents) continue;
		const candidates = signals.filter((s) => covers(w, s) && clears(w, s));
		let pick: Signal | null = null;
		for (const s of candidates) if (!(await alreadyCovered(s, w.id))) { pick = s; break; }
		const breaking = !!pick && pick.score >= 80 && w.cadence.breaking;
		if (!due(w, week) && !breaking) continue;
		// record-beat writers work down the keyword list before falling back to the news
		if (!pick) pick = await keywordSignal(w, settings).catch(() => null);
		if (!pick) pick = await newsSignal(w, settings).catch(() => null);
		if (!pick) continue;
		const pairId = settings.debate_pairs && pick.score >= 85 && w.perspective !== 0 ? newId("p") : null;
		out.push(await assign(w.id, { signalId: pick.id, format: formatFor(w, pick), pairId }));
		left--;
		// debate pair: the same story from a writer on the other side
		if (pairId && left > 0) {
			const other = ranked.find((x) => x.w.id !== w.id && Math.sign(x.w.perspective) === -Math.sign(w.perspective) && covers(x.w, pick!) && x.day < x.w.cadence.daily_cap);
			if (other) { out.push(await assign(other.w.id, { signalId: pick.id, format: formatFor(other.w, pick), pairId })); left--; }
		}
	}
	return { ...sig, assigned: out.length, assignments: out };
}
