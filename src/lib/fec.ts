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
	return rest ? `${cap(rest.replace(/\b(MR|MRS|MS|DR|HON)\.?\s*$/i, ""))} ${cap(last)}`.trim() : cap(n);
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

/** The FEC record for a market's candidate name, matched on last name within the race's field. */
export function matchFec(field: FecCandidate[], name: string | null) {
	if (!name) return null;
	const last = name.trim().split(/\s+/).pop()!.toLowerCase().replace(/[^a-z]/g, "");
	const hits = field.filter((c) => c.name.split(",")[0].toLowerCase().replace(/[^a-z]/g, "").endsWith(last));
	return hits.sort((a, b) => b.receipts - a.receipts)[0] ?? null;
}

export const usd = (x: number | null | undefined) => {
	const v = x ?? 0;
	return v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`;
};
export const asOfReport = (iso: string | null) =>
	iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : "the latest report";
