/**
 * Candidate pages (/candidates/<name>/): every named person in the race and presidential markets, merged across
 * exchanges and races by the collector's name rule (lib/names.ts). Built from the cycle files, so a candidate
 * appears as soon as an exchange lists them and drops off when their markets close.
 */
import { getIndex, getCycle, type Race, type Source, type Party } from "./markets";
import { nameKey } from "./names";
import { slugify } from "./politics";

const GENERIC = /^(democrat|democrats|democratic party|republican|republicans|republican party|independent|other|democratic|party [a-z]|someone else|any other|field)$/i;

export interface CandidateEntry {
	kind: "race" | "pres";
	cycle: number;
	race?: Race;
	market?: "winner" | "nomD" | "nomR";
	/** this candidate's chance on each exchange (their share of the market), and the average */
	k: number | null; p: number | null; chance: number;
	/** 24-hour change in their price, dollars, where an exchange reports it */
	d: number | null;
}
export interface Candidate { slug: string; key: string; name: string; party: Party; state: string | null; entries: CandidateEntry[] }

const PRES_LABEL = { winner: "presidential election", nomD: "Democratic presidential nomination", nomR: "Republican presidential nomination" } as const;
export const entryLabel = (e: CandidateEntry) =>
	e.kind === "pres" ? `${e.cycle} ${PRES_LABEL[e.market!]}` : e.race!.kind === "house" ? `${e.cycle} ${e.race!.label} House race` : `${e.cycle} ${e.race!.state} ${e.race!.kind === "senate" ? "Senate" : "governor"} race`;
export const entryPath = (e: CandidateEntry) => (e.kind === "pres" ? `/${e.cycle}/president/` : e.race!.path);

function share(s: Source | null | undefined, key: string) {
	if (!s?.o?.length) return null;
	const tot = s.o.reduce((a, o) => a + o.p, 0) || 1;
	const hit = s.o.find((o) => nameKey(o.n) === key);
	return hit ? { p: hit.p / tot, d: hit.d } : null;
}

let memo: { t: number; v: Candidate[] } | null = null;

/** Every candidate, most-watched first (their best chance in a race, presidential hopefuls by odds). */
export async function allCandidates(): Promise<Candidate[]> {
	if (memo && Date.now() - memo.t < 60_000) return memo.v;
	const index = await getIndex();
	const by = new Map<string, Candidate>();
	const add = (name: string, party: Party, state: string | null, entry: Omit<CandidateEntry, "k" | "p" | "chance" | "d">, k: Source | null | undefined, p: Source | null | undefined) => {
		const n = name.trim();
		if (!n || GENERIC.test(n) || !/\s/.test(n)) return; // people have a first and last name
		const nk = nameKey(n);
		// two people with one name in different states stay two candidates
		const prev = by.get(nk);
		const key = state && prev?.state && prev.state !== state ? `${nk}|${state}` : nk;
		const ks = share(k, nk), ps = share(p, nk);
		const both = [ks?.p, ps?.p].filter((x): x is number => x != null);
		if (!both.length) return;
		const c = by.get(key) ?? { slug: "", key, name: n, party, state, entries: [] };
		if (n.length > c.name.length && !/\./.test(n)) c.name = n; // prefer the fuller spelling
		c.party ??= party;
		c.state ??= state;
		c.entries.push({ ...entry, k: ks?.p ?? null, p: ps?.p ?? null, chance: both.reduce((a, b) => a + b, 0) / both.length, d: ks?.d ?? ps?.d ?? null });
		by.set(key, c);
	};
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		for (const r of data.races) {
			if (r.kind === "control") continue;
			const seen = new Set<string>();
			for (const s of [r.k, r.p]) for (const o of s?.o ?? []) {
				const key = nameKey(o.n);
				if (seen.has(key)) continue;
				seen.add(key);
				add(o.n, o.pa, r.st, { kind: "race", cycle: r.cycle, race: r }, r.k, r.p);
			}
		}
		for (const m of ["winner", "nomD", "nomR"] as const) {
			const pm = data.pres?.[m];
			if (!pm) continue;
			const seen = new Set<string>();
			for (const s of [pm.k, pm.p]) for (const o of s?.o ?? []) {
				const key = nameKey(o.n);
				if (seen.has(key) || o.p < 0.005) continue; // long shots under half a cent aren't candidates yet
				seen.add(key);
				add(o.n, o.pa ?? (m === "nomD" ? "D" : m === "nomR" ? "R" : null), null, { kind: "pres", cycle: cy.year, market: m }, pm.k, pm.p);
			}
		}
	}
	// slugs: the name, plus the state when two people share it
	const list = [...by.values()];
	const count = new Map<string, number>();
	const nameSlug = (n: string) => slugify(n.replace(/\.\s*/g, (m) => (m.trim() === "." && /\s/.test(m) ? " " : "")));
	for (const c of list) count.set(nameSlug(c.name), (count.get(nameSlug(c.name)) ?? 0) + 1);
	for (const c of list) {
		const base = nameSlug(c.name);
		c.slug = count.get(base)! > 1 && c.state ? `${base}-${c.state.toLowerCase()}` : base;
		c.entries.sort((a, b) => (a.kind === "pres" ? 0 : 1) - (b.kind === "pres" ? 0 : 1) || b.cycle - a.cycle || b.chance - a.chance);
	}
	const weight = (c: Candidate) => Math.max(...c.entries.map((e) => (e.kind === "pres" ? 1 + e.chance : e.chance)));
	list.sort((a, b) => weight(b) - weight(a));
	memo = { t: Date.now(), v: list };
	return list;
}

export const candidatePath = (c: Candidate) => `/candidates/${c.slug}/`;
export async function findCandidate(slug: string) {
	return (await allCandidates()).find((c) => c.slug === slug) ?? null;
}
/** Path for a name in a race (for linking race pages to candidate pages), if that person has a page. */
export async function candidateLinks() {
	const list = await allCandidates();
	const byKey = new Map(list.map((c) => [c.key, candidatePath(c)]));
	return (name: string | null | undefined, state?: string | null) =>
		name ? byKey.get(`${nameKey(name)}|${state ?? ""}`) ?? byKey.get(nameKey(name)) ?? null : null;
}
