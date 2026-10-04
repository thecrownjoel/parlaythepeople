/**
 * Polls and the Parlay polling average. Polls come from Wikipedia's 2026 election pages (ingest/polls.py,
 * D1 table `polls`); each one cites its pollster's release there.
 *
 * The average, stated plainly so readers can check it:
 * - each pollster's most recent poll only (likely voters preferred over registered voters over adults),
 * - polls whose fieldwork ended within 30 days of the newest poll (if fewer than 3, the 3 most recent within 90 days),
 * - weighted by recency (half-life 14 days), by sample size (square root, capped at 2,000) and halved for polls
 *   sponsored by a party or campaign.
 */
import { env } from "cloudflare:workers";

export interface Poll {
	pollster: string; partisan: string | null; start_date: string | null; end_date: string; sample: number | null;
	pop: string | null; d: number; r: number; other: number | null; undecided: number | null; d_name: string; r_name: string; source: string;
}
export interface PollAverage { d: number; r: number; margin: number; polls: Poll[]; used: number; latest: string; d_name: string; r_name: string; source: string }

const DAY_MS = 86_400_000;
const POP_RANK: Record<string, number> = { LV: 3, V: 3, RV: 2, A: 1 };

export async function pollsFor(raceId: string, limit = 40): Promise<Poll[]> {
	try {
		const { results } = await env.MARKETS.prepare("SELECT pollster, partisan, start_date, end_date, sample, pop, d, r, other, undecided, d_name, r_name, source FROM polls WHERE race_id = ? ORDER BY end_date DESC LIMIT ?").bind(raceId, limit).all<Poll>();
		return results ?? [];
	} catch {
		return [];
	}
}

export function average(polls: Poll[]): PollAverage | null {
	if (!polls.length) return null;
	// polls of the current matchup only (the nominees can change)
	const pair = `${polls[0].d_name}|${polls[0].r_name}`;
	const same = polls.filter((p) => `${p.d_name}|${p.r_name}` === pair);
	const latestPer = new Map<string, Poll>();
	for (const p of same) {
		const key = p.pollster.replace(/\s*\((D|R)\)\s*/g, "").toLowerCase();
		const cur = latestPer.get(key);
		if (!cur || p.end_date > cur.end_date || (p.end_date === cur.end_date && (POP_RANK[p.pop ?? ""] ?? 0) > (POP_RANK[cur.pop ?? ""] ?? 0))) latestPer.set(key, p);
	}
	const each = [...latestPer.values()].sort((a, b) => b.end_date.localeCompare(a.end_date));
	const newest = Date.parse(each[0].end_date);
	let window = each.filter((p) => newest - Date.parse(p.end_date) <= 30 * DAY_MS);
	if (window.length < 3) window = each.filter((p) => newest - Date.parse(p.end_date) <= 90 * DAY_MS).slice(0, 3);
	let wsum = 0, d = 0, r = 0;
	for (const p of window) {
		const age = (newest - Date.parse(p.end_date)) / DAY_MS;
		const w = Math.pow(0.5, age / 14) * Math.sqrt(Math.min(p.sample ?? 400, 2000)) * (p.partisan ? 0.5 : 1);
		wsum += w; d += w * p.d; r += w * p.r;
	}
	if (!wsum) return null;
	d /= wsum; r /= wsum;
	return { d, r, margin: d - r, polls: same, used: window.length, latest: each[0].end_date, d_name: polls[0].d_name, r_name: polls[0].r_name, source: polls[0].source };
}

export async function pollAverage(raceId: string) {
	return average(await pollsFor(raceId));
}

/** "Jackson +1.2" style margin. */
export function marginText(a: { margin: number; d_name: string; r_name: string }) {
	const lead = a.margin >= 0 ? a.d_name : a.r_name;
	const pts = Math.abs(a.margin * 100);
	return pts < 0.05 ? "Tied" : `${lead.split(/\s+/).pop()} +${pts.toFixed(1)}`;
}

/** RealClearPolitics' poll listing for the office, for readers who want to compare. */
export const RCP_URL: Record<string, string> = {
	senate: "https://www.realclearpolling.com/latest-polls/senate",
	governor: "https://www.realclearpolling.com/latest-polls/governor",
	house: "https://www.realclearpolling.com/latest-polls/house",
};
