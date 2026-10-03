/**
 * Social pulse from LunarCrush (collected hourly by ingest/social.py into R2 social.json).
 * Candidates are matched to market outcomes with the same name rule as the collector (nameKey).
 */
import { r2json, candidate, consensus, type Race } from "./markets";
import { nameKey } from "./names";

export interface SocialPost { t: string; u: string; by: string | null; av: string | null; f: number | null; i: number; s: number | null; net: string | null; at: number | null }
export interface Pulse {
	name: string; key: string; kind: "candidate" | "topic"; races: string[];
	i24: number; contributors: number; posts24: number; trend: string | null; sentiment: number | null; wow: number | null;
	series: [number, number, number | null][]; top: SocialPost[]; link: string;
}
export interface SocialData { generated: number; source: string; topics: Record<string, Pulse> }

export const getSocial = () => r2json<SocialData>("social.json");
export const LUNARCRUSH_URL = "https://lunarcrush.com/?utm_source=parlaythepeople&utm_medium=referral&utm_campaign=data_partner";

/** Pulse lookup by candidate name (any spelling the exchanges use). */
export function pulseIndex(social: SocialData | null) {
	const byKey = new Map<string, Pulse>();
	for (const p of Object.values(social?.topics ?? {})) {
		if (p.kind !== "candidate") continue;
		const prev = byKey.get(p.key);
		if (!prev || p.i24 > prev.i24) byKey.set(p.key, p);
	}
	return (name: string | null | undefined) => (name ? byKey.get(nameKey(name)) ?? null : null);
}

export interface RacePulse { race: Race; d: Pulse | null; r: Pulse | null; dName: string | null; rName: string | null; sovD: number | null; oddsD: number }
/** Share of the two main candidates' combined conversation vs. their market odds. */
export function racePulse(race: Race, find: ReturnType<typeof pulseIndex>): RacePulse {
	const dName = candidate(race, "D"), rName = candidate(race, "R");
	// only use a pulse the collector matched to this exact race (guards against same-name candidates)
	const forRace = (p: Pulse | null) => (p && p.races.includes(race.path) ? p : null);
	const d = forRace(find(dName)), r = forRace(find(rName));
	const tot = (d?.i24 ?? 0) + (r?.i24 ?? 0);
	return { race, d, r, dName, rName, sovD: d && r && tot ? d.i24 / tot : null, oddsD: consensus(race).D };
}

export function compact(n: number) {
	return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(Math.round(n));
}
