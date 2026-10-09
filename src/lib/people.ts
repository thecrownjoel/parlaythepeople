/**
 * People pages (/candidates/<name>/): everyone running for the House, Senate or governor, plus every sitting member of
 * Congress, one page each. Merged from three sources:
 *   - the race and presidential markets (lib/candidates.ts): odds, and every governor candidate an exchange lists
 *   - the FEC's candidate list (fec_candidates): every House and Senate candidate who has raised money this cycle
 *   - Congress.gov (congress_members): sitting members, whose pages lead with their voting record (lib/votes.ts)
 * Market candidates keep the slugs they already had.
 */
import { env } from "cloudflare:workers";
import { allCandidates, type Candidate } from "./candidates";
import { getIndex, getCycle, type Race } from "./markets";
import { displayName, type Member } from "./congress";
import { fecName, sameCandidate, partyLetter } from "./fec";
import { slugify } from "./politics";
import { STATES } from "./states";

export type Office = "house" | "senate" | "governor" | "president";
export interface Run { office: Office; cycle: number; st: string | null; district: string | null; race: Race | null; incumbent: boolean }
interface FecRow { cand_id: string; cycle: number; name: string; party: string | null; office: string; state: string; district: string | null; ici: string | null; receipts: number }
export interface Person {
	slug: string; name: string; party: string | null; state: string | null;
	candidate: Candidate | null; member: Member | null; fec: FecRow[]; runs: Run[];
}

const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z\s-]/g, "").replace(/-/g, " ").trim();
const SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);
const lastOf = (name: string) => fold(name).split(/\s+/).filter((w) => !SUFFIX.has(w)).pop() ?? "";
const firstOf = (name: string) => fold(name).split(/\s+/)[0] ?? "";
const nameSlug = (n: string) => slugify(n.replace(/\.\s*/g, (m) => (m.trim() === "." && /\s/.test(m) ? " " : "")));
const memberName = (m: Member) => displayName(m).replace(/\s+[A-Z]\.\s+/, " ");

export const officeWord = (o: Office) => (o === "house" ? "the U.S. House" : o === "senate" ? "the U.S. Senate" : o === "governor" ? "governor" : "president");
export function runLabel(r: Run) {
	const st = r.st ? STATES[r.st] ?? r.st : "";
	if (r.office === "house") return `${r.cycle} ${r.st}-${r.district && /^\d+$/.test(r.district) && Number(r.district) ? Number(r.district) : "AL"} House race`;
	if (r.office === "senate") return `${r.cycle} ${st} Senate race`;
	if (r.office === "governor") return `${r.cycle} ${st} governor's race`;
	return `${r.cycle} presidential race`;
}

let memo: { t: number; v: Person[] } | null = null;

async function rows<T>(sql: string, ...bind: unknown[]): Promise<T[]> {
	try {
		return (await env.MARKETS.prepare(sql).bind(...bind).all<T>()).results ?? [];
	} catch {
		return [];
	}
}

export async function allPeople(): Promise<Person[]> {
	if (memo && Date.now() - memo.t < 5 * 60_000) return memo.v;
	const index = await getIndex();
	const cycles = (index?.cycles ?? []).map((c) => c.year).filter((y) => y >= new Date().getFullYear()).sort();
	const cycle = cycles[0] ?? new Date().getFullYear();
	const data = await getCycle(cycle);
	const raceFor = (office: Office, st: string, district: string | null) =>
		data?.races.find((r) => r.kind === office && r.st === st && (office !== "house" || Number(r.dist ?? 0) === Number(district ?? 0)) && !r.special)
		?? data?.races.find((r) => r.kind === office && r.st === st && (office !== "house" || Number(r.dist ?? 0) === Number(district ?? 0))) ?? null;

	const [members, fec] = await Promise.all([
		rows<Member>("SELECT * FROM congress_members"),
		rows<FecRow>("SELECT cand_id, cycle, name, party, office, state, district, ici, receipts FROM fec_candidates WHERE cycle = ? AND office IN ('H', 'S') AND (receipts > 0 OR ici = 'I') ORDER BY receipts DESC", cycle),
	]);

	const people: Person[] = [];
	const byState = new Map<string, Person[]>();
	const add = (p: Person) => { people.push(p); if (p.state) byState.set(p.state, [...(byState.get(p.state) ?? []), p]); return p; };
	/** someone already listed in this state: same last name and first initial (the full first name breaks ties), or for
	 *  an FEC record, a looser name match (married and legal names) in the same race */
	const find = (st: string | null, names: string[], seat?: { office: Office; district: string | null }, fecRaw?: string) => {
		if (!st) return null;
		const last = lastOf(names[0]), firsts = names.map(firstOf).filter(Boolean);
		const pool = (byState.get(st) ?? []).filter((p) => lastOf(p.name) === last && firsts.some((f) => f[0] === firstOf(p.name)[0]));
		const inSeat = (p: Person) => !seat || p.runs.some((r) => r.office === seat.office && (seat.office !== "house" || Number(r.district ?? 0) === Number(seat.district ?? 0)));
		// a first initial alone ("Phil" / "Philip") only joins two records in the same race
		const hit = pool.find((p) => firsts.includes(firstOf(p.name))) ?? (pool.length === 1 && inSeat(pool[0]) ? pool[0] : null);
		if (hit || !seat || !fecRaw) return hit;
		return (byState.get(st) ?? []).find((p) => sameCandidate(fecRaw, p.name) && inSeat(p)) ?? null;
	};

	// 1. market candidates (their slugs are already set and stay as they are)
	for (const c of await allCandidates()) {
		const runs: Run[] = c.entries.map((e) => e.kind === "pres"
			? { office: "president", cycle: e.cycle, st: null, district: null, race: null, incumbent: false }
			: { office: e.race!.kind as Office, cycle: e.cycle, st: e.race!.st, district: e.race!.dist, race: e.race!, incumbent: false });
		add({ slug: c.slug, name: c.name, party: c.party, state: c.state, candidate: c, member: null, fec: [], runs });
	}
	// 2. sitting members of Congress
	for (const m of members) {
		const p = find(m.state, [memberName(m), m.name.includes(",") ? m.name.split(",")[1] : m.name, m.first ?? ""].filter(Boolean)) ?? add({ slug: "", name: memberName(m), party: m.party, state: m.state, candidate: null, member: null, fec: [], runs: [] });
		p.member = m;
		p.party ??= m.party;
		// a member whose seat is up and who is in that race is its incumbent
		for (const r of p.runs) if (r.office === m.chamber && (m.chamber === "senate" || Number(r.district ?? 0) === Number(m.district ?? 0))) r.incumbent = true;
	}
	// 3. FEC: House and Senate candidates with money raised (or an incumbent's committee)
	for (const f of fec) {
		const office: Office = f.office === "S" ? "senate" : "house";
		const district = office === "house" ? f.district : null;
		let p = f.ici === "I" ? people.find((x) => x.member && x.member.state === f.state && x.member.chamber === office && (office === "senate" ? lastOf(x.name) === lastOf(fecName(f.name)) : Number(x.member.district ?? 0) === Number(district ?? 0))) ?? null : null;
		p ??= find(f.state, [fecName(f.name)], { office, district }, f.name);
		if (!p) {
			// one FEC record per person per office is enough; extra committees for the same name are skipped
			p = add({ slug: "", name: fecName(f.name), party: partyLetter(f.party), state: f.state, candidate: null, member: null, fec: [], runs: [] });
		}
		p.fec.push(f);
		if (!p.runs.some((r) => r.office === office && r.cycle === f.cycle)) {
			p.runs.push({ office, cycle: f.cycle, st: f.state, district, race: raceFor(office, f.state, district), incumbent: f.ici === "I" });
		} else if (f.ici === "I") {
			for (const r of p.runs) if (r.office === office) r.incumbent = true;
		}
	}

	// slugs for everyone new: the name, then the state, then the office when names collide
	const taken = new Set(people.filter((p) => p.slug).map((p) => p.slug));
	const fresh = people.filter((p) => !p.slug);
	const count = new Map<string, number>();
	for (const p of fresh) count.set(nameSlug(p.name), (count.get(nameSlug(p.name)) ?? 0) + 1);
	for (const p of fresh.sort((a, b) => (b.member ? 1 : 0) - (a.member ? 1 : 0))) {
		const base = nameSlug(p.name);
		let slug = count.get(base)! > 1 || taken.has(base) ? `${base}-${(p.state ?? "us").toLowerCase()}` : base;
		for (let i = 2; taken.has(slug); i++) slug = `${base}-${(p.state ?? "us").toLowerCase()}-${i}`;
		p.slug = slug;
		taken.add(slug);
	}
	memo = { t: Date.now(), v: people };
	return people;
}

export const personPath = (p: Pick<Person, "slug">) => `/candidates/${p.slug}/`;
export async function findPerson(slug: string) {
	return (await allPeople()).find((p) => p.slug === slug) ?? null;
}
/** Link names on race pages and state pages to people pages: by name and state, then by name alone. */
export async function personLinks() {
	const list = await allPeople();
	const byStateName = new Map<string, Person>(), byLast = new Map<string, Person[]>();
	for (const p of list) {
		byStateName.set(`${fold(p.name)}|${p.state ?? ""}`, p);
		const k = `${lastOf(p.name)}|${p.state ?? ""}`;
		byLast.set(k, [...(byLast.get(k) ?? []), p]);
	}
	return (name: string | null | undefined, state?: string | null): string | null => {
		if (!name) return null;
		const exact = byStateName.get(`${fold(name)}|${state ?? ""}`);
		if (exact) return personPath(exact);
		const same = byLast.get(`${lastOf(name)}|${state ?? ""}`) ?? [];
		const hit = same.length === 1 ? same[0] : same.find((p) => firstOf(p.name) === firstOf(name));
		return hit ? personPath(hit) : null;
	};
}
/** People pages by FEC candidate id (for the money tables). */
export async function fecLinks() {
	const map = new Map<string, string>();
	for (const p of await allPeople()) for (const f of p.fec) map.set(f.cand_id, personPath(p));
	return map;
}
/** The person page for a sitting member of Congress. */
export async function memberPath(bioguide: string) {
	const p = (await allPeople()).find((x) => x.member?.bioguide === bioguide);
	return p ? personPath(p) : null;
}
