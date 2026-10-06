/**
 * Congress.gov records (ingest/congress.py → D1 congress_members, congress_bills): which candidates are sitting
 * members of Congress, how long they've served, and the bills they sponsor; and the bills moving in Congress now.
 * Public domain (U.S. government work); photos carry Congress.gov's attribution.
 */
import { env } from "cloudflare:workers";
import type { Race } from "./markets";

export interface Member {
	bioguide: string; name: string; first: string | null; last: string | null; party: string; state: string | null; state_name: string | null;
	district: number | null; chamber: "senate" | "house"; since: number | null; birth_year: number | null; photo: string | null; photo_credit: string | null;
	website: string | null; phone: string | null; office: string | null; leadership: string | null; sponsored: number | null; cosponsored: number | null; updated: number;
}
export interface Bill { id: string; congress: number; type: string; number: string; title: string; introduced: string | null; policy_area: string | null; latest_action: string | null; latest_action_date: string | null; sponsor: string | null }

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z\s-]/g, "").replace(/-/g, " ").trim();
const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);
const lastOf = (name: string) => fold(name).split(/\s+/).filter((w) => !SUFFIX.has(w)).pop() ?? "";

/** "Collins, Susan M." → "Susan M. Collins" (the member list's order), for display. */
export const displayName = (m: Member) => (m.first && m.last ? `${m.first} ${m.last}` : m.name.includes(",") ? `${m.name.split(",").slice(1).join(" ").trim()} ${m.name.split(",")[0]}`.replace(/\s+/g, " ") : m.name);

/** Congress.gov's public page for a member. */
export function memberUrl(m: Member) {
	const slug = displayName(m).toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-");
	return `https://www.congress.gov/member/${slug}/${m.bioguide}`;
}
/** Congress.gov's page for a bill (119-hr-1234). */
export function billUrl(b: Bill) {
	const kind: Record<string, string> = { HR: "house-bill", S: "senate-bill", HRES: "house-resolution", SRES: "senate-resolution", HJRES: "house-joint-resolution", SJRES: "senate-joint-resolution", HCONRES: "house-concurrent-resolution", SCONRES: "senate-concurrent-resolution" };
	return `https://www.congress.gov/bill/${b.congress}th-congress/${kind[b.type] ?? "bill"}/${b.number}`;
}
export const billLabel = (b: Bill) => `${({ HR: "H.R.", S: "S.", HRES: "H.Res.", SRES: "S.Res.", HJRES: "H.J.Res.", SJRES: "S.J.Res.", HCONRES: "H.Con.Res.", SCONRES: "S.Con.Res." } as Record<string, string>)[b.type] ?? b.type} ${b.number}`;
export const isLaw = (b: Bill) => /became public law/i.test(b.latest_action ?? "");

async function membersIn(state: string): Promise<Member[]> {
	try {
		const { results } = await env.MARKETS.prepare("SELECT * FROM congress_members WHERE state = ?").bind(state).all<Member>();
		return results ?? [];
	} catch {
		return [];
	}
}

/** The sitting member of Congress with this name in this state (any chamber: a House member running for Senate or
 *  governor still matches). Last name must match; when two share it, the first name breaks the tie. */
export async function memberByName(name: string, state: string | null): Promise<Member | null> {
	if (!state) return null;
	const last = lastOf(name), first = fold(name).split(/\s+/)[0];
	const hits = (await membersIn(state)).filter((m) => lastOf(m.last ?? m.name.split(",")[0]) === last);
	if (hits.length <= 1) return hits[0] ?? null;
	return hits.find((m) => fold(m.first ?? m.name.split(",")[1] ?? "").split(/\s+/)[0] === first) ?? null;
}

/** Who holds this seat now: the district's representative, or the state's two senators. */
export async function seatHolders(race: Race): Promise<Member[]> {
	if (race.kind !== "senate" && race.kind !== "house") return [];
	const all = await membersIn(race.st);
	if (race.kind === "senate") return all.filter((m) => m.chamber === "senate");
	const d = race.dist && /^\d+$/.test(race.dist) ? Number(race.dist) : null;
	return all.filter((m) => m.chamber === "house" && (d == null ? !m.district || m.district === 0 : m.district === d));
}

export async function billsBy(bioguide: string, n = 8): Promise<Bill[]> {
	try {
		const { results } = await env.MARKETS.prepare("SELECT * FROM congress_bills WHERE sponsor = ? ORDER BY COALESCE(introduced, latest_action_date) DESC LIMIT ?").bind(bioguide, n).all<Bill>();
		return results ?? [];
	} catch {
		return [];
	}
}

/** Bills with the latest action, optionally in one policy area ("Armed Forces and National Security"). */
export async function recentBills(o: { days?: number; policy?: string; n?: number } = {}): Promise<(Bill & { sponsor_name: string | null; sponsor_party: string | null; sponsor_state: string | null })[]> {
	const since = new Date(Date.now() - (o.days ?? 14) * 864e5).toISOString().slice(0, 10);
	try {
		const { results } = await env.MARKETS.prepare(
			`SELECT b.*, m.name AS sponsor_name, m.party AS sponsor_party, m.state AS sponsor_state FROM congress_bills b LEFT JOIN congress_members m ON m.bioguide = b.sponsor
			 WHERE b.latest_action_date >= ? ${o.policy ? "AND b.policy_area = ?" : ""} ORDER BY b.latest_action_date DESC LIMIT ?`,
		).bind(...[since, ...(o.policy ? [o.policy] : []), o.n ?? 20]).all<any>();
		return results ?? [];
	} catch {
		return [];
	}
}

/** Years served, from the first year in Congress. */
export const yearsIn = (m: Member) => (m.since ? new Date().getFullYear() - m.since : null);
export const chamberWord = (m: Member) => (m.chamber === "senate" ? "Senator" : "Representative");
export const seatWord = (m: Member) => (m.chamber === "senate" ? `U.S. senator from ${m.state_name ?? m.state}` : `U.S. representative for ${m.state}${m.district ? `-${String(m.district).padStart(2, "0")}` : " (at large)"}`);
