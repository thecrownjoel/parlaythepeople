/**
 * Trend data for the homepage and summary pages: sparklines, movers, and per-state race summaries.
 * Reads race_history / outcome_history (D1); results are memoized per Worker for a few minutes.
 */
import { env } from "cloudflare:workers";
import { consensus, candidate, shares, type CycleData, type Race } from "./markets";

export interface Spark { ts: number; v: number }

const memo = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
	const hit = memo.get(key);
	if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
	const v = await fn();
	memo.set(key, { t: Date.now(), v });
	return v;
}

const avg = (...xs: (number | null | undefined)[]) => {
	const v = xs.filter((x): x is number => x != null);
	return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Daily series (average of both exchanges) for one race's Democratic or Republican odds. */
export function raceSpark(raceId: string, days = 90, party: "D" | "R" = "D"): Promise<Spark[]> {
	return cached(`rs:${raceId}:${days}:${party}`, 5 * 60_000, async () => {
		const since = Math.floor(Date.now() / 1000) - days * 86400;
		try {
			const { results } = await env.MARKETS.prepare(
				"SELECT ts, k_d, k_r, p_d, p_r FROM race_history WHERE race_id = ? AND ts >= ? ORDER BY ts",
			).bind(raceId, since).all<{ ts: number; k_d: number | null; k_r: number | null; p_d: number | null; p_r: number | null }>();
			const byDay = new Map<number, Spark>();
			for (const r of results ?? []) {
				const v = party === "D" ? avg(r.k_d, r.p_d) : avg(r.k_r, r.p_r);
				if (v != null) byDay.set(Math.floor(r.ts / 86400), { ts: r.ts, v });
			}
			return [...byDay.values()];
		} catch {
			return [];
		}
	});
}

/** Daily series for one outcome (candidate, balance-of-power outcome, derived majority odds…). */
export function outcomeSpark(group: string, outcome: string, days = 90): Promise<Spark[]> {
	return cached(`os:${group}:${outcome}:${days}`, 5 * 60_000, async () => {
		const since = Math.floor(Date.now() / 1000) - days * 86400;
		try {
			const { results } = await env.MARKETS.prepare(
				"SELECT ts, k, p FROM outcome_history WHERE group_id = ? AND outcome = ? AND ts >= ? ORDER BY ts",
			).bind(group, outcome, since).all<{ ts: number; k: number | null; p: number | null }>();
			const byDay = new Map<number, Spark>();
			for (const r of results ?? []) {
				const v = avg(r.k, r.p);
				if (v != null) byDay.set(Math.floor(r.ts / 86400), { ts: r.ts, v });
			}
			return [...byDay.values()];
		} catch {
			return [];
		}
	});
}

/** Each race's Democratic odds about `days` ago (latest point at or before then), for computing moves. */
export function racesAgo(days: number): Promise<Map<string, number>> {
	return cached(`ago:${days}`, 10 * 60_000, async () => {
		const t = Math.floor(Date.now() / 1000) - days * 86400;
		try {
			// SQLite returns the row holding MAX(ts) for bare columns in an aggregate query.
			const { results } = await env.MARKETS.prepare(
				"SELECT race_id, k_d, p_d, MAX(ts) AS ts FROM race_history WHERE ts <= ? AND ts > ? GROUP BY race_id",
			).bind(t, t - 4 * 86400).all<{ race_id: string; k_d: number | null; p_d: number | null }>();
			const m = new Map<string, number>();
			for (const r of results ?? []) {
				const v = avg(r.k_d, r.p_d);
				if (v != null) m.set(r.race_id, v);
			}
			return m;
		} catch {
			return new Map();
		}
	});
}

export interface Mover { race: Race; from: number; to: number; delta: number }
export async function movers(data: CycleData, days = 7, n = 6): Promise<Mover[]> {
	const then = await racesAgo(days);
	return data.races
		.filter((r) => r.kind !== "control" && then.has(r.id))
		.map((r) => {
			const to = consensus(r).D;
			const from = then.get(r.id)!;
			return { race: r, from, to, delta: to - from };
		})
		.filter((m) => Math.abs(m.delta) >= 0.01)
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
		.slice(0, n);
}

/** Counts for the stats band. */
export function historyCounts(): Promise<{ points: number; since: number | null }> {
	return cached("counts", 30 * 60_000, async () => {
		try {
			const r = await env.MARKETS.prepare(
				"SELECT (SELECT count(*) FROM race_history) + (SELECT count(*) FROM outcome_history) AS points, (SELECT MIN(ts) FROM race_history) AS since",
			).first<{ points: number; since: number }>();
			return { points: r?.points ?? 0, since: r?.since ?? null };
		} catch {
			return { points: 0, since: null };
		}
	});
}

export interface StateRace { st: string; state: string; label: string; path: string; lead: "D" | "R" | "I"; lp: number; D: number; rating: string; vol: number; who: string | null }
/** The headline race per state for an office (Senate or governor), for maps and the globe. */
export function stateRaces(data: CycleData, kind: "senate" | "governor"): StateRace[] {
	return data.races
		.filter((r) => r.kind === kind)
		.map((r) => {
			const c = consensus(r);
			const vol = (r.k?.v ?? 0) + (r.p?.v ?? 0);
			return { st: r.st, state: r.state, label: r.label, path: r.path, lead: c.lead, lp: c.lp, D: c.D, rating: c.rating, vol, who: candidate(r, c.lead) };
		});
}

export { shares };
