/**
 * Money traded by period, from the trade archive (D1 binding TRADES, written by ingest/archive.py).
 * Pages read the daily rollup (trade_daily); only "past 24 hours" sums raw trades, which is a small slice.
 */
import { env } from "cloudflare:workers";

const memo = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
	const hit = memo.get(key);
	if (hit && Date.now() - hit.t < ttlMs) return hit.v as T;
	const v = await fn();
	memo.set(key, { t: Date.now(), v });
	return v;
}

const DAY = 86400;
export interface Money { usd: number; n: number; k: number; p: number }
const empty = (): Money => ({ usd: 0, n: 0, k: 0, p: 0 });

/** First day with trade records (unix seconds), or null when the archive is empty. */
export function moneyStart(): Promise<number | null> {
	return cached("start", 60 * 60_000, async () => {
		try {
			const r = await env.TRADES.prepare("SELECT MIN(day) AS d FROM trade_daily").first<{ d: number | null }>();
			return r?.d != null ? r.d * DAY : null;
		} catch {
			return null;
		}
	});
}

/** Dollars traded per race since `ts`. Within two days it sums exact trades; further back, whole days. */
export function moneySince(ts: number): Promise<Map<string, Money>> {
	const exact = Date.now() / 1000 - ts <= 2 * DAY;
	const t = exact ? ts - (ts % 600) : Math.floor(ts / DAY);
	return cached(`since:${exact}:${t}`, 5 * 60_000, async () => {
		const m = new Map<string, Money>();
		try {
			const { results } = exact
				? await env.TRADES.prepare("SELECT race_id, src, SUM(usd) AS usd, COUNT(*) AS n FROM trades WHERE ts >= ? AND race_id IS NOT NULL GROUP BY race_id, src").bind(t).all<{ race_id: string; src: string; usd: number; n: number }>()
				: await env.TRADES.prepare("SELECT race_id, src, SUM(usd) AS usd, SUM(n) AS n FROM trade_daily WHERE day >= ? GROUP BY race_id, src").bind(t).all<{ race_id: string; src: string; usd: number; n: number }>();
			for (const r of results ?? []) {
				const x = m.get(r.race_id) ?? empty();
				x.usd += r.usd ?? 0;
				x.n += r.n ?? 0;
				if (r.src === "k") x.k += r.usd ?? 0; else x.p += r.usd ?? 0;
				m.set(r.race_id, x);
			}
		} catch { /* the archive is optional; pages fall back to totals */ }
		return m;
	});
}

/** Sum of a money map (optionally only races whose id starts with `prefix`, e.g. "2026-"). */
export function moneyTotal(m: Map<string, Money>, prefix = ""): Money {
	const t = empty();
	for (const [id, x] of m) if (id.startsWith(prefix)) { t.usd += x.usd; t.n += x.n; t.k += x.k; t.p += x.p; }
	return t;
}

export interface BigTrade { src: string; race_id: string; outcome: string | null; ts: number; side: string | null; yes_price: number | null; size: number; usd: number }
/** The largest single trades since `ts` (walks the usd index from the top). */
export function biggestTrades(ts: number, n = 8, prefix = ""): Promise<BigTrade[]> {
	const t = ts - (ts % 600);
	return cached(`big:${t}:${n}:${prefix}`, 5 * 60_000, async () => {
		try {
			const { results } = await env.TRADES.prepare(
				"SELECT src, race_id, outcome, ts, side, yes_price, size, usd FROM trades WHERE ts >= ? AND race_id LIKE ? ORDER BY usd DESC LIMIT ?",
			).bind(t, `${prefix}%`, n).all<BigTrade>();
			return results ?? [];
		} catch {
			return [];
		}
	});
}

/** One race's money by day (oldest first) for the last `days` days, per exchange. */
export function raceMoneyByDay(raceId: string, days = 30): Promise<{ day: number; k: number; p: number; n: number; big: number }[]> {
	const from = Math.floor(Date.now() / 1000 / DAY) - days + 1;
	return cached(`rday:${raceId}:${from}`, 5 * 60_000, async () => {
		try {
			const { results } = await env.TRADES.prepare(
				"SELECT day, src, usd, n, big FROM trade_daily WHERE race_id = ? AND day >= ? ORDER BY day",
			).bind(raceId, from).all<{ day: number; src: string; usd: number; n: number; big: number }>();
			const by = new Map<number, { day: number; k: number; p: number; n: number; big: number }>();
			for (const r of results ?? []) {
				const x = by.get(r.day) ?? { day: r.day, k: 0, p: 0, n: 0, big: 0 };
				if (r.src === "k") x.k += r.usd ?? 0; else x.p += r.usd ?? 0;
				x.n += r.n ?? 0;
				x.big = Math.max(x.big, r.big ?? 0);
				by.set(r.day, x);
			}
			return [...by.values()];
		} catch {
			return [];
		}
	});
}

/** The largest trades on one race. */
export function raceBigTrades(raceId: string, n = 8): Promise<BigTrade[]> {
	return cached(`rbig:${raceId}:${n}`, 5 * 60_000, async () => {
		try {
			const { results } = await env.TRADES.prepare(
				"SELECT src, race_id, outcome, ts, side, yes_price, size, usd FROM trades WHERE race_id = ? ORDER BY usd DESC LIMIT ?",
			).bind(raceId, n).all<BigTrade>();
			return results ?? [];
		} catch {
			return [];
		}
	});
}
