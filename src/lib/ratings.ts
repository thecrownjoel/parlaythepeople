/**
 * Expert race ratings: The Cook Political Report, Sabato's Crystal Ball and Inside Elections, as cited on Wikipedia's
 * 2026 election pages (ingest/ratings.py → D1 `ratings`). We show each rating with credit and a link to the forecaster,
 * never their analysis. Scores: +3 safe D … 0 tossup … −3 safe R.
 */
import { env } from "cloudflare:workers";

export type Forecaster = "cook" | "sabato" | "ie";
export const FORECASTERS: Record<Forecaster, { name: string; short: string; url: string; about: string }> = {
	cook: { name: "The Cook Political Report", short: "Cook", url: "https://www.cookpolitical.com/ratings", about: "Nonpartisan newsletter founded by Charlie Cook in 1984; its Solid/Likely/Lean/Toss-up scale is the industry standard." },
	sabato: { name: "Sabato's Crystal Ball", short: "Sabato", url: "https://centerforpolitics.org/crystalball/", about: "Larry Sabato's forecasts from the University of Virginia Center for Politics; free to read, Safe/Likely/Lean/Toss-up." },
	ie: { name: "Inside Elections", short: "Inside Elections", url: "https://insideelections.com/ratings", about: "Nathan Gonzales's nonpartisan newsletter; adds a Tilt step between Lean and Toss-up." },
};
export const FORECASTER_KEYS = Object.keys(FORECASTERS) as Forecaster[];

export interface Rating { race_id: string; source: Forecaster; rating: string; score: number | null; as_of: string | null; cited_on: string | null; seen: number; changed: number | null; previous: string | null }

/** Every rating, by race id. */
export async function allRatings(): Promise<Map<string, Partial<Record<Forecaster, Rating>>>> {
	const out = new Map<string, Partial<Record<Forecaster, Rating>>>();
	try {
		const { results } = await env.MARKETS.prepare("SELECT * FROM ratings").all<Rating>();
		for (const r of results ?? []) out.set(r.race_id, { ...(out.get(r.race_id) ?? {}), [r.source]: r });
	} catch { /* table not created yet */ }
	return out;
}

export async function ratingsFor(raceId: string): Promise<Partial<Record<Forecaster, Rating>>> {
	try {
		const { results } = await env.MARKETS.prepare("SELECT * FROM ratings WHERE race_id = ?").bind(raceId).all<Rating>();
		return Object.fromEntries((results ?? []).map((r) => [r.source, r]));
	} catch {
		return {};
	}
}

/** Rating changes we've seen in the last `days`, newest first. */
export async function recentChanges(days = 30): Promise<Rating[]> {
	try {
		const { results } = await env.MARKETS.prepare("SELECT * FROM ratings WHERE changed >= ? ORDER BY changed DESC LIMIT 100").bind(Math.floor(Date.now() / 1000) - days * 86400).all<Rating>();
		return results ?? [];
	} catch {
		return [];
	}
}

/** The forecasters' average score, and the market-implied score on the same scale for comparison. */
export function expertScore(r: Partial<Record<Forecaster, Rating>>): number | null {
	const s = FORECASTER_KEYS.map((k) => r[k]?.score).filter((x): x is number => x != null);
	return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

/** A Democratic win probability on the ratings scale: tossup 40–60%, lean 60–75%, likely 75–90%, safe 90%+. */
export function marketScore(pD: number): number {
	const p = Math.max(pD, 1 - pD), side = pD >= 0.5 ? 1 : -1;
	const s = p < 0.6 ? 0 : p < 0.75 ? 1 : p < 0.9 ? 2 : 3;
	return side * s;
}

/** The rating words for a score ("Lean D"), for the market's column. */
export function scoreWord(s: number): string {
	if (s === 0) return "Tossup";
	const side = s > 0 ? "D" : "R", a = Math.abs(s);
	return `${a >= 3 ? "Safe" : a >= 2 ? "Likely" : a >= 1 ? "Lean" : "Tilt"} ${side}`;
}

/** CSS class for a rating chip: d3 … r3, or toss. */
export function chipClass(score: number | null | undefined): string {
	if (score == null) return "rt-none";
	if (score === 0) return "rt-toss";
	return `rt-${score > 0 ? "d" : "r"}${Math.min(3, Math.ceil(Math.abs(score)))}`;
}
