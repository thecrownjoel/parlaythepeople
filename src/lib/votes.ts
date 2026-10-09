/**
 * Roll-call votes in the current Congress (ingest/votes.py → D1 congress_votes, congress_member_votes): how each member
 * voted, how often they miss votes, and how often they vote with their party. House Clerk and senate.gov records.
 */
import { env } from "cloudflare:workers";

export type Position = "yea" | "nay" | "present" | "absent";
export interface MemberVote {
	id: string; chamber: "house" | "senate"; congress: number; session: number; roll: number; date: string | null;
	question: string | null; title: string | null; result: string | null; bill: string | null;
	yea: number | null; nay: number | null; d_yea: number; d_nay: number; r_yea: number; r_nay: number;
	position: Position;
}
export interface VoteStats { total: number; missed: number; partyVotes: number; withParty: number; first: string | null; last: string | null }

/** Independents caucus with Democrats in the current Congress. */
const side = (party: string | null) => (party === "R" ? "r" : "d");

/** Whether this vote split along party lines for the member's side, and if the member went with their side. */
export function withParty(v: MemberVote, party: string | null): boolean | null {
	const s = side(party);
	const y = s === "d" ? v.d_yea : v.r_yea, n = s === "d" ? v.d_nay : v.r_nay;
	if (y === n || (v.position !== "yea" && v.position !== "nay")) return null;
	return (v.position === "yea") === (y > n);
}

/** Final votes on bills, resolutions and nominations (not procedural motions). */
export const PASSAGE = "(v.question LIKE '%Passage%' OR v.question LIKE 'On Agreeing to the Resolution%' OR v.question LIKE 'On the Nomination%' OR v.question LIKE '%Conference Report%' OR v.question LIKE 'On the Joint Resolution%' OR v.question LIKE 'On Concurring%' OR v.question LIKE '%Veto%')";

export async function memberVotes(bioguide: string, o: { limit?: number; offset?: number; passage?: boolean; broke?: string | null } = {}): Promise<MemberVote[]> {
	try {
		const s = o.broke ? side(o.broke) : null;
		// broke with party: voted yea when most of their side voted nay, or the reverse
		const broke = s ? `AND ((mv.position = 'yea' AND v.${s}_nay > v.${s}_yea) OR (mv.position = 'nay' AND v.${s}_yea > v.${s}_nay))` : "";
		const { results } = await env.MARKETS.prepare(
			`SELECT v.*, mv.position FROM congress_member_votes mv JOIN congress_votes v ON v.id = mv.vote_id
			 WHERE mv.bioguide = ? ${o.passage ? `AND ${PASSAGE}` : ""} ${broke} ORDER BY v.date DESC, v.roll DESC LIMIT ? OFFSET ?`,
		).bind(bioguide, o.limit ?? 40, o.offset ?? 0).all<MemberVote>();
		return results ?? [];
	} catch {
		return [];
	}
}

export async function voteStats(bioguide: string, party: string | null): Promise<VoteStats | null> {
	const s = side(party);
	try {
		const r = await env.MARKETS.prepare(
			`SELECT COUNT(*) AS total, SUM(mv.position = 'absent') AS missed,
			   SUM(mv.position IN ('yea','nay') AND v.${s}_yea != v.${s}_nay) AS partyVotes,
			   SUM((mv.position = 'yea' AND v.${s}_yea > v.${s}_nay) OR (mv.position = 'nay' AND v.${s}_nay > v.${s}_yea)) AS withParty,
			   MIN(v.date) AS first, MAX(v.date) AS last
			 FROM congress_member_votes mv JOIN congress_votes v ON v.id = mv.vote_id WHERE mv.bioguide = ?`,
		).bind(bioguide).first<VoteStats>();
		return r && r.total ? r : null;
	} catch {
		return null;
	}
}

/** The chamber's official page for a roll call. */
export function voteUrl(v: Pick<MemberVote, "chamber" | "congress" | "session" | "roll" | "date">) {
	if (v.chamber === "house") return `https://clerk.house.gov/Votes/${(v.date ?? "").slice(0, 4)}${v.roll}`;
	return `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${v.congress}${v.session}/vote_${v.congress}_${v.session}_${String(v.roll).padStart(5, "0")}.htm`;
}

const BILL: Record<string, [string, string]> = {
	"H R": ["H.R.", "house-bill"], "H RES": ["H.Res.", "house-resolution"], "H J RES": ["H.J.Res.", "house-joint-resolution"], "H CON RES": ["H.Con.Res.", "house-concurrent-resolution"],
	S: ["S.", "senate-bill"], "S RES": ["S.Res.", "senate-resolution"], "S J RES": ["S.J.Res.", "senate-joint-resolution"], "S CON RES": ["S.Con.Res.", "senate-concurrent-resolution"],
};
const billParts = (b: string | null) => {
	const m = b ? /^([A-Z.\s]+?)\s*(\d+)$/i.exec(b.trim()) : null;
	const k = m ? BILL[m[1].replace(/\./g, " ").replace(/\s+/g, " ").trim().toUpperCase()] : null;
	return k && m ? { label: `${k[0]} ${m[2]}`, kind: k[1], n: m[2] } : null;
};
/** "H RES 1075" → "H.Res. 1075"; nominations and other documents pass through. */
export const billName = (b: string | null) => billParts(b)?.label ?? b;
/** Congress.gov's page for the bill a vote was on, if it was on a bill or resolution. */
export function billLink(b: string | null, congress: number) {
	const p = billParts(b);
	return p ? `https://www.congress.gov/bill/${congress}th-congress/${p.kind}/${p.n}` : null;
}

export const POSITION_WORD: Record<Position, string> = { yea: "Yes", nay: "No", present: "Present", absent: "Didn't vote" };
