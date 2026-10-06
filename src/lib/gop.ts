/**
 * The GOP action hub: where Republicans can win (the closest races with a named Republican, from market odds) and
 * how a supporter can help in each: the candidate's own campaign site (hand-checked in data/gop-campaigns.json),
 * the party committee for that office, and the state's official election office for registering and voting.
 * The odds are the markets' real numbers; only the framing is partisan.
 */
import { consensus, candidate, type Race } from "./markets";
import campaigns from "../data/gop-campaigns.json";
import offices from "../data/election-offices.json";

export const COMMITTEES = {
	senate: { name: "NRSC", full: "National Republican Senatorial Committee", url: "https://www.nrsc.org/" },
	house: { name: "NRCC", full: "National Republican Congressional Committee", url: "https://www.nrcc.org/" },
	governor: { name: "RGA", full: "Republican Governors Association", url: "https://www.rga.org/" },
	control: { name: "RNC", full: "Republican National Committee", url: "https://gop.com/" },
} as const;

export interface Campaign { site: string | null; donate: string | null }
export const campaignFor = (name: string | null): Campaign | null => (name ? ((campaigns as Record<string, any>)[name] ?? null) : null);
export const committeeFor = (r: Race) => COMMITTEES[r.kind] ?? COMMITTEES.control;
export const electionOffice = (state: string | null | undefined) => (state ? ((offices.offices as Record<string, string>)[state] ?? null) : null);

export interface Battleground { r: Race; name: string; R: number; rating: string; who: string; dem: string | null; campaign: Campaign | null }

/** Races where the Republican has a real shot (and real risk): R chance 20–80%, closest first. */
export function battlegrounds(races: Race[], o: { kinds?: Race["kind"][]; limit?: number } = {}): Battleground[] {
	const kinds = o.kinds ?? ["senate", "governor", "house"];
	return races
		.filter((r) => kinds.includes(r.kind))
		.map((r) => {
			const c = consensus(r);
			const who = candidate(r, "R");
			const name = r.kind === "house" ? `${r.label} (${r.state})` : `${r.state} ${r.kind === "senate" ? "Senate" : "Governor"}`;
			return { r, name, R: c.R, rating: c.rating, who: who ?? "", dem: candidate(r, "D"), campaign: campaignFor(who) };
		})
		.filter((b) => b.who && b.R >= 0.2 && b.R <= 0.8)
		.sort((a, b) => Math.abs(a.R - 0.5) - Math.abs(b.R - 0.5))
		.slice(0, o.limit ?? 50);
}

/** The ask for a race: protect a Republican lead, or close a gap (the race page and hub use the same words). */
export const stakes = (R: number) => (R >= 0.5 ? "Hold the lead" : "Close the gap");
