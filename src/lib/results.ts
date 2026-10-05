/**
 * Election-night results (/results/<cycle>/): each race's status from the markets and the exchanges' settlements.
 * - settled: the exchanges resolved the race (D1 race_results, written by ingest/model/results.py)
 * - called:  after polls close, the two-exchange price crossed CALL and stayed there (D1 race_history)
 * - otherwise the market's current favorite, as a lean or a toss-up
 * No vote counts: those come from state officials, linked from each race's page.
 */
import { env } from "cloudflare:workers";
import { getCycle, consensus, candidate, type Race } from "./markets";

export const CALL = 0.97;
export type Status = "settled" | "called" | "likely" | "lean" | "tossup";
export interface RaceResult { race: Race; status: Status; party: "D" | "R" | "I"; chance: number; name: string | null; at: number | null }

/** Polls close in the last states at 1am Eastern; races can't be "called" by the markets before 7pm Eastern on Election Day. */
const pollsOpen = (eday: string) => Date.parse(`${eday}T19:00:00-05:00`) / 1000;

export async function resultsBoard(cycle: number) {
	const data = await getCycle(cycle);
	if (!data) return null;
	const eday = data.meta.election_day;
	const start = pollsOpen(eday), now = Math.floor(Date.now() / 1000);
	const settled = new Map<string, { winner: "D" | "R" | "I"; at: number }>();
	try {
		const { results } = await env.MARKETS.prepare("SELECT race_id, winner, decided_at FROM race_results WHERE race_id LIKE ?").bind(`${cycle}-%`).all<{ race_id: string; winner: "D" | "R" | "I"; decided_at: number }>();
		for (const r of results ?? []) settled.set(r.race_id, { winner: r.winner, at: r.decided_at });
	} catch { /* no results yet */ }
	// on and after election night: when each race first crossed the call line and never went back
	const calledAt = new Map<string, { party: "D" | "R"; at: number }>();
	if (now >= start) {
		try {
			const { results } = await env.MARKETS.prepare("SELECT race_id, ts, k_d, p_d FROM race_history WHERE ts >= ? AND ts <= ? AND race_id LIKE ? ORDER BY race_id, ts")
				.bind(start, start + 4 * 86400, `${cycle}-%`).all<{ race_id: string; ts: number; k_d: number | null; p_d: number | null }>();
			let cur = "", since: { party: "D" | "R"; at: number } | null = null;
			const flush = () => { if (cur && since) calledAt.set(cur, since); };
			for (const r of results ?? []) {
				if (r.race_id !== cur) { flush(); cur = r.race_id; since = null; }
				const v = [r.k_d, r.p_d].filter((x): x is number => x != null);
				if (!v.length) continue;
				const d = v.reduce((a, b) => a + b, 0) / v.length;
				const party = d >= CALL ? "D" : d <= 1 - CALL ? "R" : null;
				if (!party) since = null;
				else if (!since || since.party !== party) since = { party, at: r.ts };
			}
			flush();
		} catch { /* no history */ }
	}
	const rows: RaceResult[] = data.races.filter((r) => r.kind !== "control").map((race) => {
		const c = consensus(race);
		const s = settled.get(race.id), call = calledAt.get(race.id);
		const party = s?.winner ?? call?.party ?? c.lead;
		const status: Status = s ? "settled" : call ? "called" : c.lp >= 0.75 ? "likely" : c.lp >= 0.6 ? "lean" : "tossup";
		return { race, status, party, chance: s ? 1 : c.lead === party ? c.lp : 1 - c.lp, name: candidate(race, party), at: s?.at ?? call?.at ?? null };
	});
	const control = data.races.filter((r) => r.kind === "control").map((r) => ({ race: r, c: consensus(r) }));
	return { cycle, eday, live: now >= start, over: now >= start + 4 * 86400, generated: data.meta.generated, rows, control };
}

/** Seats by party and status for one office. */
export function tally(rows: RaceResult[], kind: Race["kind"]) {
	const out = { D: { settled: 0, called: 0, favored: 0 }, R: { settled: 0, called: 0, favored: 0 }, I: { settled: 0, called: 0, favored: 0 }, tossup: 0 };
	for (const r of rows.filter((x) => x.race.kind === kind)) {
		if (r.status === "tossup") out.tossup++;
		else out[r.party][r.status === "settled" ? "settled" : r.status === "called" ? "called" : "favored"]++;
	}
	return out;
}
