/**
 * Campaign finance from the FEC (ingest/fec.py writes D1 MARKETS fec_candidates and fec_outside once a day).
 * House and Senate only: governors and other state offices report to their states.
 */
import { env } from "cloudflare:workers";
import type { Race } from "./markets";

export interface FecCandidate {
	cand_id: string; cycle: number; name: string; party: string | null; office: "H" | "S"; state: string; district: string | null;
	ici: string | null; receipts: number; disbursements: number; cash: number; debts: number;
	indiv: number; pac: number; party_contrib: number; self_funding: number; coverage_end: string | null;
	support: number | null; oppose: number | null; spenders: { name: string; support: number; oppose: number }[];
}

/** FEC's "COLLINS, SUSAN M." → "Susan M. Collins". */
export function fecName(n: string) {
	const [last, rest] = n.split(",").map((s) => s.trim());
	const cap = (s: string) => s.toLowerCase().replace(/(^|[\s\-'.])([a-z])/g, (_, a, b) => a + b.toUpperCase()).replace(/\bMc([a-z])/g, (_, b) => "Mc" + b.toUpperCase());
	if (!rest) return cap(n);
	// "PAXTON, WARREN KENNETH JR." → "Warren Kenneth Paxton Jr."
	const suffix = /\b(JR|SR|II|III|IV)\.?\s*$/i.exec(rest);
	const first = rest.replace(/\b(MR|MRS|MS|DR|HON)\.?\s*$/i, "").replace(/\b(JR|SR|II|III|IV)\.?\s*$/i, "").trim();
	const suf = suffix ? ` ${suffix[1].length > 2 ? suffix[1].toUpperCase() : cap(suffix[1])}${/^(JR|SR)$/i.test(suffix[1]) ? "." : ""}` : "";
	return `${cap(first)} ${cap(last)}${suf}`.trim();
}
export const fecUrl = (id: string) => `https://www.fec.gov/data/candidate/${id}/`;
export const partyLetter = (p: string | null) => (p === "DEM" || p === "DFL" ? "D" : p === "REP" ? "R" : p ? "I" : null);

const rowOf = (r: any): FecCandidate => ({
	...r,
	spenders: String(r.top_spenders ?? "").split("|").filter(Boolean).map((s) => {
		const [name, support, oppose] = s.split("~");
		return { name, support: Number(support) || 0, oppose: Number(oppose) || 0 };
	}),
});
const SELECT = "SELECT c.*, o.support, o.oppose, o.top_spenders FROM fec_candidates c LEFT JOIN fec_outside o ON o.cand_id = c.cand_id AND o.cycle = c.cycle";

/** Every FEC candidate running for this race's seat, most money raised first. Null for races the FEC doesn't cover. */
export async function raceFinance(r: Race): Promise<FecCandidate[] | null> {
	if (r.kind !== "senate" && r.kind !== "house") return null;
	const dist = r.kind === "house" ? (/^\d+$/.test(r.dist ?? "") ? r.dist!.padStart(2, "0") : "00") : null;
	try {
		const { results } = await env.MARKETS.prepare(`${SELECT} WHERE c.cycle = ? AND c.office = ? AND c.state = ? ${dist ? "AND c.district = ?" : ""} ORDER BY c.receipts DESC LIMIT 12`)
			.bind(...[r.cycle, r.kind === "senate" ? "S" : "H", r.st, ...(dist ? [dist] : [])]).all();
		return (results ?? []).map(rowOf);
	} catch {
		return [];
	}
}

/** One FEC candidate by id. */
export async function fecCandidate(id: string, cycle: number): Promise<FecCandidate | null> {
	try {
		const r = await env.MARKETS.prepare(`${SELECT} WHERE c.cand_id = ? AND c.cycle = ?`).bind(id, cycle).first();
		return r ? rowOf(r) : null;
	} catch {
		return null;
	}
}

/**
 * Whether an FEC name ("ARENHOLZ, ASHLEY HINSON") is the person a market names ("Ashley Hinson"): the surname matches,
 * or both the first and last names appear in it (married and legal names). First name required for the second rule,
 * so "John James" doesn't match "SMITH, JAMES".
 */
export function sameCandidate(fec: string, market: string) {
	const words = (s: string) => s.toLowerCase().replace(/[^a-z\s,-]/g, "").split(/[\s,-]+/).filter(Boolean);
	const m = words(market).filter((w) => !["jr", "sr", "ii", "iii", "iv"].includes(w));
	if (!m.length) return false;
	const first = m[0], last = m[m.length - 1];
	const surname = words(fec.split(",")[0]).join("");
	if (surname === last || surname.endsWith(last)) return true;
	const all = new Set(words(fec));
	return m.length > 1 && all.has(last) && all.has(first);
}

/** The FEC record for a market's candidate name within the race's field. */
export function matchFec(field: FecCandidate[], name: string | null) {
	if (!name) return null;
	return field.filter((c) => sameCandidate(c.name, name)).sort((a, b) => b.receipts - a.receipts)[0] ?? null;
}

export const usd = (x: number | null | undefined) => {
	const v = x ?? 0;
	return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`;
};
export const asOfReport = (iso: string | null) =>
	iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "the latest report";

/**
 * The finance rows to show for a race: the candidates the markets name first, then the rest of the field by money
 * raised (long shots under $10K left out), up to `max`; `missing` = market-named candidates with no FEC report yet.
 */
export function financeRows(field: FecCandidate[] | null, names: string[], max = 8) {
	const isMarket = (c: FecCandidate) => names.some((n) => sameCandidate(c.name, n));
	const all = (field ?? []).filter((c) => isMarket(c) || c.receipts >= 10_000);
	// one row per named candidate (the best-funded record, if someone filed twice)
	const market = names.map((n) => all.filter((c) => sameCandidate(c.name, n)).sort((a, b) => b.receipts - a.receipts)[0]).filter((c): c is FecCandidate => !!c);
	const missing = field ? names.filter((n) => !market.some((c) => sameCandidate(c.name, n))) : [];
	const rest = all.filter((c) => !isMarket(c)).slice(0, Math.max(2, max - market.length - missing.length));
	return { market, missing, rest };
}
