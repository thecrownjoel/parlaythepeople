/** State pages (/states/<name>/): every race, ballot measure, candidate and politics market in one state. */
import { env } from "cloudflare:workers";
import { getIndex, getCycle, type Race } from "./markets";
import { slugify } from "./politics";

export const STATES: Record<string, string> = {
	AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida",
	GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine",
	MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
	NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
	OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
	UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
export const statePath = (st: string) => `/states/${slugify(STATES[st] ?? st)}/`;
export const stateFromSlug = (slug: string) => Object.keys(STATES).find((st) => slugify(STATES[st]) === slug) ?? null;

export interface Ballot { id: string; src: "k" | "p"; st: string; n: string; p: number; v: number; url: string; thin?: boolean }
export interface StateView { st: string; name: string; races: Race[]; ballots: (Ballot & { cycle: number })[]; electionDays: Map<number, string> }

/** Everything the site tracks for one state, newest cycle first. */
export async function stateView(st: string): Promise<StateView> {
	const index = await getIndex();
	const races: Race[] = [], ballots: (Ballot & { cycle: number })[] = [];
	const electionDays = new Map<number, string>();
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		electionDays.set(cy.year, data.meta.election_day);
		races.push(...data.races.filter((r) => r.st === st && r.kind !== "control"));
		for (const b of (data.big?.ballots ?? []) as Ballot[]) if (b.st === st) ballots.push({ ...b, cycle: cy.year });
	}
	const order = { senate: 0, governor: 1, house: 2, control: 3 } as const;
	races.sort((a, b) => a.cycle - b.cycle || order[a.kind] - order[b.kind] || (parseInt(a.dist ?? "0") || 0) - (parseInt(b.dist ?? "0") || 0));
	return { st, name: STATES[st] ?? st, races, ballots: ballots.sort((a, b) => b.v - a.v), electionDays };
}

/** Campaign money raised by every FEC candidate in the state this cycle, by office. */
export async function stateMoney(st: string, cycle: number) {
	try {
		const { results } = await env.MARKETS.prepare("SELECT office, SUM(receipts) AS raised, SUM(cash) AS cash, COUNT(*) AS n FROM fec_candidates WHERE cycle = ? AND state = ? GROUP BY office").bind(cycle, st).all<{ office: string; raised: number; cash: number; n: number }>();
		const out = new Map<string, { raised: number; cash: number; n: number }>();
		for (const r of results ?? []) out.set(r.office, r);
		const outside = await env.MARKETS.prepare("SELECT SUM(o.support + o.oppose) AS usd FROM fec_outside o JOIN fec_candidates c ON c.cand_id = o.cand_id AND c.cycle = o.cycle WHERE c.cycle = ? AND c.state = ?").bind(cycle, st).first<{ usd: number }>();
		return { byOffice: out, outside: outside?.usd ?? 0 };
	} catch {
		return { byOffice: new Map(), outside: 0 };
	}
}
