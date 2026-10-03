/**
 * Daily market report: what changed in the election markets on one day (UTC), built from recorded history.
 * Prices go back to November 2024; money and headlines begin September 30, 2026.
 */
import { env } from "cloudflare:workers";
import { getIndex, getCycle, consensus, candidate, type Race, type CycleData } from "./markets";
import { racesAt } from "./trends";
import { biggestTrades } from "./money";

const DAY = 86400;
export const DAILY_START = "2024-11-07";
export const DAILY_MONEY_START = "2026-09-30";

export interface DayMove { r: Race; from: number; to: number; delta: number }
export interface DailyReport {
	date: string; start: number; end: number; cycle: CycleData;
	control: { r: Race; from: number | null; to: number | null }[];
	movers: DayMove[]; flips: DayMove[];
	money: { usd: number; n: number; top: { r: Race | null; id: string; usd: number }[] } | null;
	big: Awaited<ReturnType<typeof biggestTrades>>;
	news: { title: string; source: string | null; url: string }[];
}

export const dayStart = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
export const isoDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

export async function dailyReport(date: string): Promise<DailyReport | null> {
	const start = dayStart(date);
	const now = Math.floor(Date.now() / 1000);
	if (!Number.isFinite(start) || date < DAILY_START || start >= now) return null;
	const end = Math.min(start + DAY, now);
	const index = await getIndex();
	const year = index?.cycles.find((c) => c.election_day >= date)?.year ?? index?.next;
	const cycle = year ? await getCycle(year) : null;
	if (!cycle) return null;
	const [a, b] = await Promise.all([racesAt(start), racesAt(end)]);
	const moves: DayMove[] = [];
	for (const r of cycle.races) {
		const f = a.get(r.id)?.D, t = b.get(r.id)?.D;
		if (f != null && t != null) moves.push({ r, from: f, to: t, delta: t - f });
	}
	const control = cycle.races.filter((r) => r.kind === "control").map((r) => ({ r, from: a.get(r.id)?.D ?? null, to: b.get(r.id)?.D ?? null }));
	const contested = moves.filter((m) => m.r.kind !== "control");
	const movers = contested.filter((m) => Math.abs(m.delta) >= 0.01).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 10);
	const flips = contested.filter((m) => (m.from - 0.5) * (m.to - 0.5) < 0 && Math.abs(m.to - 0.5) >= 0.03);

	let money: DailyReport["money"] = null;
	let big: DailyReport["big"] = [];
	let news: DailyReport["news"] = [];
	if (date >= DAILY_MONEY_START) {
		try {
			const day = Math.floor(start / DAY);
			const { results } = await env.TRADES.prepare("SELECT race_id, SUM(usd) AS usd, SUM(n) AS n FROM trade_daily WHERE day = ? GROUP BY race_id").bind(day).all<{ race_id: string; usd: number; n: number }>();
			const rows = results ?? [];
			if (rows.length) {
				const byId = new Map(cycle.races.map((r) => [r.id, r]));
				money = {
					usd: rows.reduce((s, x) => s + (x.race_id.startsWith(`${cycle.meta.cycle}-`) ? x.usd : 0), 0),
					n: rows.reduce((s, x) => s + (x.race_id.startsWith(`${cycle.meta.cycle}-`) ? x.n : 0), 0),
					top: rows.filter((x) => x.race_id.startsWith(`${cycle.meta.cycle}-`)).sort((x, y) => y.usd - x.usd).slice(0, 8).map((x) => ({ r: byId.get(x.race_id) ?? null, id: x.race_id, usd: x.usd })),
				};
			}
			const { results: br } = await env.TRADES.prepare(
				"SELECT src, race_id, outcome, ts, side, yes_price, size, usd FROM trades WHERE ts >= ? AND ts < ? ORDER BY usd DESC LIMIT 6",
			).bind(start, end).all<any>();
			big = br ?? [];
		} catch { /* no trade archive for that day */ }
		try {
			const { results: nr } = await env.MARKETS.prepare(
				"SELECT title, source, url FROM news WHERE COALESCE(published, first_seen) >= ? AND COALESCE(published, first_seen) < ? ORDER BY COALESCE(published, first_seen) DESC LIMIT 12",
			).bind(start, end).all<{ title: string; source: string | null; url: string }>();
			news = nr ?? [];
		} catch { /* no headline archive */ }
	}
	return { date, start, end, cycle, control, movers, flips, money, big, news };
}

/** A one-paragraph summary of the day, used as the page lede and description. */
export function dailySummary(rep: DailyReport, name: (r: Race) => string, pct: (x: number) => string, fmtVol: (x: number) => string) {
	const parts: string[] = [];
	// control of each chamber, grouped by the favored party: "Democrats ended the day 92% to win the House and 64% to win the Senate"
	const byParty = new Map<string, string[]>();
	for (const c of [...rep.control].sort((a, b) => (a.r.label.startsWith("Senate") ? -1 : 1) - (b.r.label.startsWith("Senate") ? -1 : 1))) {
		if (c.to == null) continue;
		const lead = c.to >= 0.5 ? "Democrats" : "Republicans";
		const d = c.from != null ? c.to - c.from : null;
		const bit = `${pct(Math.max(c.to, 1 - c.to))} to win ${c.r.label.startsWith("Senate") ? "the Senate" : "the House"}${d != null && Math.abs(d) >= 0.005 ? ` (Democratic odds ${d > 0 ? "up" : "down"} ${Math.abs(d * 100).toFixed(1)} points)` : ""}`;
		byParty.set(lead, [...(byParty.get(lead) ?? []), bit]);
	}
	for (const [lead, bits] of byParty) parts.push(`${lead} ended the day ${bits.join(" and ")}`);
	const m = rep.movers[0];
	if (m) parts.push(`the biggest move was ${name(m.r)}, where Democratic odds went from ${pct(m.from)} to ${pct(m.to)}`);
	if (rep.flips.length) parts.push(`${rep.flips.length} race${rep.flips.length > 1 ? "s" : ""} changed favorites`);
	if (rep.money?.usd) parts.push(`${fmtVol(rep.money.usd)} traded on ${rep.cycle.meta.cycle} races`);
	return parts.length ? parts.join("; ").replace(/^./, (c) => c.toUpperCase()) + "." : "A quiet day in the election markets.";
}

export { candidate, consensus };
