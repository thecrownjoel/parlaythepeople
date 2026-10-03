/**
 * Market data for Parlay the People pages.
 *
 * The collector (ingest/ingest.py, run every 10 minutes by GitHub Actions) writes:
 *  - R2 `DATA`:   index.json and cycles/<year>.json (everything a cycle page shows)
 *  - D1 `MARKETS`: races (one row per race) and race_history (price history)
 */
import { env } from "cloudflare:workers";

export type Party = "D" | "R" | "I" | null;
export interface Outcome { id?: string; tok?: string; n: string; pa: Party; p: number; d: number | null; v: number }
export interface Source { o: Outcome[]; url: string; v?: number; D?: number; R?: number; t?: string }
export interface Race {
	id: string; cycle: number; kind: "senate" | "governor" | "house" | "control"; st: string; state: string;
	dist: string | null; label: string; path: string; k: Source | null; p: Source | null; D: number; R: number;
	special?: boolean;
}
export interface PresMarket { k?: Source; p?: Source }
export interface CycleData {
	meta: { generated: string; cycle: number; election_day: string };
	races: Race[];
	big: any;
	pres: { winner?: PresMarket; party?: PresMarket; nomD?: PresMarket; nomR?: PresMarket };
}
export interface CycleSummary { year: number; election_day: string; races: number; offices: string[]; ballots: number }
export interface DataIndex { generated: string; next: number; cycles: CycleSummary[] }

const memo = new Map<string, { t: number; v: unknown }>();
async function r2json<T>(key: string): Promise<T | null> {
	const hit = memo.get(key);
	if (hit && Date.now() - hit.t < 60_000) return hit.v as T;
	const obj = await env.DATA.get(key);
	if (!obj) return null;
	const v = (await obj.json()) as T;
	memo.set(key, { t: Date.now(), v });
	return v;
}

export const getIndex = () => r2json<DataIndex>("index.json");
export const getCycle = (year: number) => r2json<CycleData>(`cycles/${year}.json`);

export interface HistoryPoint { ts: number; k_d: number | null; k_r: number | null; p_d: number | null; p_r: number | null }
export async function getHistory(raceId: string): Promise<HistoryPoint[]> {
	try {
		const { results } = await env.MARKETS.prepare(
			"SELECT ts, k_d, k_r, p_d, p_r FROM race_history WHERE race_id = ? ORDER BY ts",
		).bind(raceId).all<HistoryPoint>();
		return results ?? [];
	} catch {
		return []; // history is optional; never fail the page over it
	}
}

export interface RaceRow { id: string; cycle: number; kind: string; label: string; path: string; updated_at: number }
export async function listRaceRows(): Promise<RaceRow[]> {
	try {
		const { results } = await env.MARKETS.prepare(
			"SELECT id, cycle, kind, label, path, updated_at FROM races ORDER BY cycle, kind, id",
		).all<RaceRow>();
		return results ?? [];
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------- derived values
const GENERIC = /^(democrat|democrats|democratic party|republican|republicans|republican party|independent|other|democratic|party [a-z])$/i;
export const SRC_NAME = { k: "Kalshi", p: "Polymarket" } as const;

export function shares(s: Source | null) {
	if (!s) return null;
	const tot = s.o.reduce((a, o) => a + o.p, 0) || 1;
	let D = 0, R = 0, O = 0;
	for (const o of s.o) {
		if (o.pa === "D") D += o.p;
		else if (o.pa === "R") R += o.p;
		else O += o.p;
	}
	return { D: D / tot, R: R / tot, O: O / tot };
}

export function consensus(r: Race) {
	const arr = [shares(r.k), shares(r.p)].filter(Boolean) as { D: number; R: number; O: number }[];
	const avg = (f: "D" | "R" | "O") => arr.reduce((a, x) => a + x[f], 0) / (arr.length || 1);
	const D = avg("D"), R = avg("R"), O = Math.max(0, 1 - D - R);
	const lead: "D" | "R" | "I" = D >= R && D >= O ? "D" : R >= O ? "R" : "I";
	const lp = Math.max(D, R, O);
	return { D, R, O, lead, lp, rating: rating(lead, lp) };
}

export const RATING_LABEL: Record<string, string> = {
	SD: "Safe D", LD: "Likely D", lD: "Lean D", T: "Toss-up", lR: "Lean R", LR: "Likely R", SR: "Safe R", I: "Leans Ind.",
};
export function rating(lead: string, lp: number) {
	if (lp < 0.6) return "T";
	if (lead === "I") return "I";
	return (lp >= 0.9 ? "S" : lp >= 0.75 ? "L" : "l") + lead;
}

/** A named person for a party, preferring real names over "Democrats"/"Republican party". */
export function candidate(r: Race, party: "D" | "R" | "I"): string | null {
	for (const s of [r.p, r.k]) {
		if (!s) continue;
		for (const o of s.o) if (o.pa === party && !GENERIC.test(o.n.trim())) return o.n;
	}
	return null;
}

export const PARTY_WORD = { D: "Democrat", R: "Republican", I: "independent" } as const;
export const PARTY_PLURAL = { D: "Democrats", R: "Republicans", I: "independents" } as const;

export function pct(x: number | null | undefined, d = 0) {
	return x == null ? "—" : `${(x * 100).toFixed(d)}%`;
}
export function fmtVol(v: number) {
	if (!v) return "—";
	return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`;
}
export function fmtDate(iso: string | number, withTime = true) {
	const d = typeof iso === "number" ? new Date(iso * 1000) : new Date(iso);
	return d.toLocaleString("en-US", {
		month: "short", day: "numeric", year: "numeric",
		...(withTime ? { hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" } : { timeZone: "America/New_York" }),
	});
}
export function daysUntil(isoDate: string, from = new Date()) {
	return Math.ceil((new Date(`${isoDate}T12:00:00-05:00`).getTime() - from.getTime()) / 864e5);
}

export function officeTitle(r: Race) {
	if (r.kind === "control") return `${r.label.startsWith("Senate") ? "Senate" : "House"} control`;
	if (r.kind === "house") return `${r.label} House race`;
	return `${r.state} ${r.kind === "senate" ? "Senate" : "governor"} race${r.special ? " (special election)" : ""}`;
}

/** One plain sentence that answers "who is favored?" — the first thing a reader or an answer engine needs. */
export function answer(r: Race, generated: string) {
	const c = consensus(r);
	const when = fmtDate(generated, false);
	const both = r.k && r.p;
	const srcs = [r.k && `Kalshi ${pct(shares(r.k)![c.lead === "I" ? "O" : c.lead])}`, r.p && `Polymarket ${pct(shares(r.p)![c.lead === "I" ? "O" : c.lead])}`]
		.filter(Boolean).join(", ");
	if (r.kind === "control") {
		const ch = r.label.startsWith("Senate") ? "Senate" : "House";
		return `As of ${when}, prediction markets give ${PARTY_PLURAL[c.lead as "D" | "R"]} a ${pct(c.lp)} chance of controlling the U.S. ${ch} after the ${r.cycle} elections (${srcs}).`;
	}
	const name = candidate(r, c.lead);
	const opp = c.lead === "D" ? candidate(r, "R") : candidate(r, "D");
	const who = name ? `${PARTY_WORD[c.lead]} ${name}` : `the ${PARTY_WORD[c.lead]}`;
	const vs = opp ? ` over ${c.lead === "D" ? "Republican" : "Democrat"} ${opp}` : "";
	const race = r.kind === "house" ? `${r.cycle} race for ${r.label}` : `${r.cycle} ${r.state} ${r.kind === "senate" ? "Senate" : "governor"} race`;
	const lean = c.lp < 0.6 ? " The race is rated a toss-up." : "";
	return `As of ${when}, prediction markets give ${who} a ${pct(c.lp)} chance of winning the ${race}${vs} (${srcs}${both ? "" : "; one exchange lists this race"}).${lean}`;
}

export function raceSearchTitle(r: Race) {
	const c = consensus(r);
	const a = candidate(r, "D"), b = candidate(r, "R");
	const matchup = a && b ? `: ${a.split(" ").slice(-1)[0]} vs. ${b.split(" ").slice(-1)[0]}` : "";
	if (r.kind === "control") return `Who will win the ${r.label.startsWith("Senate") ? "Senate" : "House"} in ${r.cycle}? Odds`;
	if (r.kind === "house") return `${r.label} House race ${r.cycle} odds${matchup}`;
	return `${r.state} ${r.kind === "senate" ? "Senate" : "governor"} race ${r.cycle} odds${matchup}`;
}
