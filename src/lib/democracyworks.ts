/**
 * Democracy Works Elections API (https://developers.democracy.works/api/v2): how to vote in each state (mail ballots,
 * in-person voting, ID rules, deadlines). Paid, by agreement with Democracy Works: set DEMOCRACY_WORKS_API_KEY.
 * Without a key, voting pages show each state's official election office instead.
 * Untested against the live API until a key is issued; responses are read defensively.
 */
import { env } from "cloudflare:workers";

const BASE = "https://api.democracy.works/v2";
const key = () => (env as unknown as { DEMOCRACY_WORKS_API_KEY?: string }).DEMOCRACY_WORKS_API_KEY;
export const hasDemocracyWorks = () => !!key();

export interface HowToVote { office: string | null; byMail: string[]; inPerson: string[]; idRule: string | null; deadlines: { label: string; date: string }[]; contact: string | null }

const memo = new Map<string, { t: number; v: HowToVote | null }>();
/** The statewide election authority's voting rules for a state (cached 6 hours). */
export async function howToVote(st: string): Promise<HowToVote | null> {
	const k = key();
	if (!k) return null;
	const hit = memo.get(st);
	if (hit && Date.now() - hit.t < 6 * 3600_000) return hit.v;
	let v: HowToVote | null = null;
	try {
		const r = await fetch(`${BASE}/authorities?stateCode=${st}`, { headers: { "X-API-KEY": k, accept: "application/json" } });
		if (r.ok) {
			const j: any = await r.json();
			const list: any[] = j?.data ?? j?.authorities ?? (Array.isArray(j) ? j : []);
			const a = list.find((x) => /state/i.test(String(x?.ocdId ?? "")) && !/county|place/i.test(String(x?.ocdId ?? ""))) ?? list[0];
			if (a) {
				const dl: { label: string; date: string }[] = [];
				const walk = (o: any, path: string[]) => {
					if (!o || typeof o !== "object") return;
					for (const [kk, vv] of Object.entries(o)) {
						if (typeof vv === "string" && /deadline|date/i.test(kk) && /^\d{4}-\d{2}-\d{2}/.test(vv)) dl.push({ label: [...path, kk].join(" ").replace(/([A-Z])/g, " $1").toLowerCase(), date: vv.slice(0, 10) });
						else if (typeof vv === "object") walk(vv, [...path, kk]);
					}
				};
				walk(a.voting, []);
				const flat = (o: any) => Object.entries(o ?? {}).filter(([, x]) => typeof x === "string" || typeof x === "boolean").map(([kk, x]) => `${kk.replace(/([A-Z])/g, " $1").toLowerCase()}: ${x === true ? "yes" : x === false ? "no" : x}`);
				v = {
					office: a.officeName ?? null,
					byMail: flat(a.voting?.byMail), inPerson: flat(a.voting?.inPerson),
					idRule: a.voting?.inPerson?.idInstructions ?? (a.voting?.inPerson?.idRequiredAllVoters === true ? "ID required for all voters." : null),
					deadlines: dl.sort((x, y) => x.date.localeCompare(y.date)),
					contact: a.contact?.website ?? a.contact?.url ?? null,
				};
			}
		}
	} catch { /* fall back to the state's official site */ }
	memo.set(st, { t: Date.now(), v });
	return v;
}
