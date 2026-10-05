/**
 * The money section (/finance/): FEC bulk data (candidates, committees, outside spending, written by ingest/fec.py)
 * and OpenFEC detail (donor size, money by state, each report) for candidates in competitive races.
 */
import { env } from "cloudflare:workers";
import { getIndex, getCycle, consensus, candidate, type Race } from "./markets";
import { financeRows, fecName, type FecCandidate } from "./fec";

const db = () => env.MARKETS;
const memo = new Map<string, { t: number; v: unknown }>();
async function cached<T>(key: string, f: () => Promise<T>): Promise<T> {
	const hit = memo.get(key);
	if (hit && Date.now() - hit.t < 5 * 60_000) return hit.v as T;
	const v = await f();
	memo.set(key, { t: Date.now(), v });
	return v;
}

export const PARTY_CMTES = [
	{ label: "National committees", D: { id: "C00010603", name: "DNC" }, R: { id: "C00003418", name: "RNC" } },
	{ label: "Senate committees", D: { id: "C00042366", name: "DSCC" }, R: { id: "C00027466", name: "NRSC" } },
	{ label: "House committees", D: { id: "C00000935", name: "DCCC" }, R: { id: "C00075820", name: "NRCC" } },
] as const;

export interface Committee { cmte_id: string; name: string; type: string; receipts: number; disbursements: number; cash: number; debts: number; indep_exp: number; coverage_end: string | null }
export interface Spender { spe_id: string; name: string; helps_d: number; helps_r: number; other: number; n: number; targets: string[] }

/** Headline totals: what House and Senate candidates raised and have left, by party, and outside spending. */
export function totals(cycle: number) {
	return cached(`tot:${cycle}`, async () => {
		const c = await db().prepare("SELECT SUM(receipts) AS raised, SUM(cash) AS cash, COUNT(*) AS n, SUM(CASE WHEN party IN ('DEM','DFL') THEN receipts ELSE 0 END) AS d, SUM(CASE WHEN party = 'REP' THEN receipts ELSE 0 END) AS r, MAX(CASE WHEN coverage_end <= date('now') THEN coverage_end END) AS through FROM fec_candidates WHERE cycle = ?").bind(cycle).first<any>().catch(() => null);
		const o = await db().prepare("SELECT SUM(helps_d) AS d, SUM(helps_r) AS r, SUM(other) AS other, COUNT(*) AS n FROM fec_spenders WHERE cycle = ?").bind(cycle).first<any>().catch(() => null);
		const p = await db().prepare(`SELECT SUM(cash) AS cash, SUM(receipts) AS raised FROM fec_committees WHERE cycle = ? AND cmte_id IN (${PARTY_CMTES.flatMap((x) => [x.D.id, x.R.id]).map(() => "?").join(",")})`).bind(cycle, ...PARTY_CMTES.flatMap((x) => [x.D.id, x.R.id])).first<any>().catch(() => null);
		return {
			raised: c?.raised ?? 0, cash: c?.cash ?? 0, candidates: c?.n ?? 0, raisedD: c?.d ?? 0, raisedR: c?.r ?? 0, through: c?.through ?? null,
			outsideD: o?.d ?? 0, outsideR: o?.r ?? 0, outsideOther: o?.other ?? 0, spenders: o?.n ?? 0,
			partyCash: p?.cash ?? 0, partyRaised: p?.raised ?? 0,
		};
	});
}

export function partyCommittees(cycle: number) {
	return cached(`pc:${cycle}`, async () => {
		const ids = PARTY_CMTES.flatMap((x) => [x.D.id, x.R.id]);
		const { results } = await db().prepare(`SELECT cmte_id, name, type, receipts, disbursements, cash, debts, indep_exp, coverage_end FROM fec_committees WHERE cycle = ? AND cmte_id IN (${ids.map(() => "?").join(",")})`).bind(cycle, ...ids).all<Committee>().catch(() => ({ results: [] as Committee[] }));
		const by = new Map((results ?? []).map((c) => [c.cmte_id, c]));
		return PARTY_CMTES.map((x) => ({ label: x.label, D: { ...x.D, c: by.get(x.D.id) ?? null }, R: { ...x.R, c: by.get(x.R.id) ?? null } }));
	});
}

/** Outside spending by week, by the party it helped. */
export function outsideWeeks(cycle: number) {
	return cached(`wk:${cycle}`, async () => (await db().prepare("SELECT week, helps_d AS d, helps_r AS r FROM fec_ie_weeks WHERE cycle = ? ORDER BY week").bind(cycle).all<{ week: string; d: number; r: number }>().catch(() => ({ results: [] as any[] }))).results ?? []);
}

/** The biggest outside spenders, with the candidates they spent the most on. */
export function topSpenders(cycle: number, n = 15) {
	return cached(`sp:${cycle}:${n}`, async () => {
		const { results } = await db().prepare("SELECT spe_id, name, helps_d, helps_r, other, n, top_cands FROM fec_spenders WHERE cycle = ? ORDER BY helps_d + helps_r + other DESC LIMIT ?").bind(cycle, n).all<any>().catch(() => ({ results: [] as any[] }));
		const ids = [...new Set((results ?? []).flatMap((r: any) => String(r.top_cands ?? "").split("|").filter(Boolean).slice(0, 2)))];
		const names = new Map<string, string>();
		if (ids.length) {
			const { results: c } = await db().prepare(`SELECT cand_id, name FROM fec_candidates WHERE cycle = ? AND cand_id IN (${ids.map(() => "?").join(",")})`).bind(cycle, ...ids).all<{ cand_id: string; name: string }>().catch(() => ({ results: [] as any[] }));
			for (const x of c ?? []) names.set(x.cand_id, fecName(x.name));
		}
		return (results ?? []).map((r: any): Spender => ({ ...r, targets: String(r.top_cands ?? "").split("|").filter(Boolean).slice(0, 2).map((id: string) => names.get(id)).filter(Boolean) }));
	});
}

/** The candidates who raised the most this cycle. */
export function topFundraisers(cycle: number, n = 15) {
	return cached(`tf:${cycle}:${n}`, async () => (await db().prepare("SELECT * FROM fec_candidates WHERE cycle = ? ORDER BY receipts DESC LIMIT ?").bind(cycle, n).all<FecCandidate>().catch(() => ({ results: [] as FecCandidate[] }))).results ?? []);
}

export interface RaceMoney {
	race: Race; d: FecCandidate | null; r: FecCandidate | null; dName: string | null; rName: string | null;
	/** money raised by each side's nominee, and outside spending that helped each side */
	dRaised: number; rRaised: number; outD: number; outR: number; total: number; oddsD: number;
}

/** Every Senate and House race's money, side by side: nominees' fundraising and outside spending for each party. */
export function raceMoney(cycle: number): Promise<RaceMoney[]> {
	return cached(`rm:${cycle}`, async () => {
		const data = await getCycle(cycle);
		if (!data) return [];
		const { results } = await db().prepare("SELECT c.*, o.support, o.oppose FROM fec_candidates c LEFT JOIN fec_outside o ON o.cand_id = c.cand_id AND o.cycle = c.cycle WHERE c.cycle = ?").bind(cycle).all<any>().catch(() => ({ results: [] as any[] }));
		const seats = new Map<string, FecCandidate[]>();
		for (const c of results ?? []) {
			const k = c.office === "S" ? `S-${c.state}` : `H-${c.state}-${c.district}`;
			seats.set(k, [...(seats.get(k) ?? []), { ...c, spenders: [] }]);
		}
		const out: RaceMoney[] = [];
		for (const race of data.races) {
			if (race.kind !== "senate" && race.kind !== "house") continue;
			const k = race.kind === "senate" ? `S-${race.st}` : `H-${race.st}-${/^\d+$/.test(race.dist ?? "") ? race.dist!.padStart(2, "0") : "00"}`;
			const dName = candidate(race, "D"), rName = candidate(race, "R");
			const { market } = financeRows(seats.get(k) ?? [], [dName, rName].filter((n): n is string => !!n));
			const d = dName ? market.find((c) => (c.party === "DEM" || c.party === "DFL")) ?? null : null;
			const r = rName ? market.find((c) => c.party === "REP") ?? null : null;
			const outD = (d?.support ?? 0) + (r?.oppose ?? 0), outR = (r?.support ?? 0) + (d?.oppose ?? 0);
			const c = consensus(race);
			out.push({ race, d, r, dName, rName, dRaised: d?.receipts ?? 0, rRaised: r?.receipts ?? 0, outD, outR, total: (d?.receipts ?? 0) + (r?.receipts ?? 0) + outD + outR, oddsD: c.D / ((c.D + c.R) || 1) });
		}
		return out.sort((a, b) => b.total - a.total);
	});
}

export interface Detail { cand_id: string; small: number; large: number; pac: number; party: number; self_funding: number; by_state: Record<string, number>; reports: [string, number, number, number][]; updated: number }
/** OpenFEC detail for these candidates (only candidates in competitive races have it, refreshed every few days). */
export async function details(ids: string[], cycle: number): Promise<Map<string, Detail>> {
	if (!ids.length) return new Map();
	const { results } = await db().prepare(`SELECT * FROM fec_detail WHERE cycle = ? AND cand_id IN (${ids.map(() => "?").join(",")})`).bind(cycle, ...ids).all<any>().catch(() => ({ results: [] as any[] }));
	return new Map((results ?? []).map((r: any) => [r.cand_id, { ...r, by_state: JSON.parse(r.by_state || "{}"), reports: JSON.parse(r.reports || "[]") }]));
}

/** The cycle the finance section shows: the next election year. */
export async function financeCycle() {
	return (await getIndex())?.next ?? 2026;
}

export const money = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}K` : `$${Math.round(x)}`);
export const raceShort = (r: Race) => (r.kind === "house" ? r.label : `${r.state} ${r.kind === "senate" ? "Senate" : "governor"}`);
