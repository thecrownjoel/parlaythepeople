/**
 * The Parlay estimate's track record: every hourly estimate (D1 forecasts) scored against settled results
 * (D1 race_results), next to the market odds logged at the same moment.
 */
import { env } from "cloudflare:workers";

const EPS = 1e-4;
export interface Score { races: number; brier_model: number; brier_market: number; ll_model: number; ll_market: number; model_better: number; market_better: number }
export interface Track { logged: number; racesLogged: number; first: number | null; resolved: number; byHorizon: { label: string; score: Score | null }[]; calls: { race_id: string; winner: string; market: number; model: number }[] }

function score(rows: { y: number; m: number; e: number }[]): Score | null {
	if (!rows.length) return null;
	const ll = (p: number, y: number) => -(y * Math.log(Math.max(p, EPS)) + (1 - y) * Math.log(Math.max(1 - p, EPS)));
	let bm = 0, bk = 0, lm = 0, lk = 0, mb = 0, kb = 0;
	for (const r of rows) {
		const a = (r.e - r.y) ** 2, b = (r.m - r.y) ** 2;
		bm += a; bk += b; lm += ll(r.e, r.y); lk += ll(r.m, r.y);
		if (a < b - 1e-9) mb++; else if (b < a - 1e-9) kb++;
	}
	const n = rows.length;
	return { races: n, brier_model: bm / n, brier_market: bk / n, ll_model: lm / n, ll_market: lk / n, model_better: mb, market_better: kb };
}

export async function trackRecord(): Promise<Track> {
	const base = await env.MARKETS.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT race_id) AS r, MIN(ts) AS f FROM forecasts").first<{ n: number; r: number; f: number | null }>().catch(() => null);
	const res = await env.MARKETS.prepare("SELECT race_id, winner, decided_at FROM race_results").all<{ race_id: string; winner: string; decided_at: number }>().catch(() => ({ results: [] as any[] }));
	const results = res.results ?? [];
	const out: Track = { logged: base?.n ?? 0, racesLogged: base?.r ?? 0, first: base?.f ?? null, resolved: results.length, byHorizon: [], calls: [] };
	if (!results.length) return out;
	const H = [["Day before", 1], ["A week before", 7], ["A month before", 30]] as const;
	for (const [label, days] of H) {
		// for each decided race, the last estimate logged at least `days` days before the result came in
		const q = await env.MARKETS.prepare(
			`SELECT r.race_id, r.winner,
			   (SELECT market_d FROM forecasts f WHERE f.race_id = r.race_id AND f.ts <= r.decided_at - ?1 ORDER BY f.ts DESC LIMIT 1) AS m,
			   (SELECT model_d FROM forecasts f WHERE f.race_id = r.race_id AND f.ts <= r.decided_at - ?1 ORDER BY f.ts DESC LIMIT 1) AS e
			 FROM race_results r`,
		).bind(days * 86400).all<{ race_id: string; winner: string; m: number | null; e: number | null }>().catch(() => ({ results: [] as any[] }));
		const rows = (q.results ?? []).filter((x) => x.m != null && x.e != null && x.winner !== "I").map((x) => ({ y: x.winner === "D" ? 1 : 0, m: x.m!, e: x.e! }));
		if (days === 1) out.calls = (q.results ?? []).filter((x) => x.m != null).map((x) => ({ race_id: x.race_id, winner: x.winner, market: x.m!, model: x.e! }));
		out.byHorizon.push({ label, score: score(rows) });
	}
	return out;
}
