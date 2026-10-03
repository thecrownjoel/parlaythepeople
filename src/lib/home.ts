/**
 * Shared data for the homepage sections. Each section renders on the page and again, alone, from
 * /partials/home/<section>?p=<period> when a reader changes its date picker.
 */
import { getIndex, getCycle, shares, type Race, type PresMarket, type Source } from "./markets";
import { getSocial } from "./social";
import { nameKey } from "./names";

export async function homeData() {
	const index = await getIndex();
	const nextYear = index?.next;
	const presYear = index?.cycles.find((c) => c.offices.includes("president") && c.year >= (nextYear ?? 0))?.year;
	const [next, presCycle, social] = await Promise.all([
		nextYear ? getCycle(nextYear) : Promise.resolve(null),
		presYear ? getCycle(presYear) : Promise.resolve(null),
		getSocial(),
	]);
	const races = next?.races ?? [];
	const byId = (id: string) => races.find((r) => r.id === id);
	return {
		index, nextYear, presYear, next, presCycle, social, races,
		senC: nextYear ? byId(`${nextYear}-senate-control`) : undefined,
		houseC: nextYear ? byId(`${nextYear}-house-control`) : undefined,
	};
}
export type HomeData = Awaited<ReturnType<typeof homeData>>;

/** Short race name for lists. */
export const raceName = (r: Race) => (r.kind === "house" ? `${r.label} (${r.state})` : `${r.state} ${r.kind === "senate" ? "Senate" : "Governor"}`);

/** Money traded on a race across both exchanges (Kalshi $1 contracts + Polymarket dollars). */
export const traded$ = (r: Race) => (r.k?.v ?? 0) + (r.p?.v ?? 0);

export const partyColor = (pa: string | null) => (pa === "D" ? "var(--bt-d)" : pa === "R" ? "var(--bt-r)" : "var(--bt-oth)");

/** Signed change in points, e.g. "▲ 2.1" / "▼ 0.4". */
export const pts = (d: number) => `${d >= 0 ? "▲" : "▼"} ${Math.abs(d * 100).toFixed(1)}`;

/** Average party shares across both exchanges for a presidential market. */
export function avgShares(m?: PresMarket) {
	const arr = (["k", "p"] as const).map((x) => m?.[x]).filter(Boolean).map((s) => shares(s as Source)!);
	return arr.length ? { D: arr.reduce((a, s) => a + s.D, 0) / arr.length, R: arr.reduce((a, s) => a + s.R, 0) / arr.length } : null;
}

/** One row per candidate across both exchanges: average share and combined money traded. */
export function merged(m?: PresMarket, limit = 6) {
	if (!m) return [];
	const rows = new Map<string, { key: string; n: string; pa: string | null; vals: number[]; vol: number }>();
	for (const x of ["k", "p"] as const) {
		const s = m[x];
		if (!s) continue;
		const tot = s.o.reduce((a, o) => a + o.p, 0) || 1;
		for (const o of s.o) {
			const key = nameKey(o.n);
			const row = rows.get(key) ?? { key, n: o.n, pa: o.pa, vals: [], vol: 0 };
			row.vals.push(o.p / tot);
			row.vol += o.v ?? 0;
			row.pa = row.pa ?? o.pa;
			rows.set(key, row);
		}
	}
	return [...rows.values()].map((r) => ({ ...r, v: r.vals.reduce((a, b) => a + b, 0) / r.vals.length })).sort((a, b) => b.v - a.v).slice(0, limit);
}

/** Each homepage section with a date picker: its default period, and whether it reads the period as "as of". */
export const SECTIONS = {
	snapshot: { def: "7d", asOf: false, presets: ["24h", "7d", "30d", "60d"] },
	big: { def: "30d", asOf: false, presets: ["24h", "7d", "30d", "60d"] },
	moving: { def: "30d", asOf: false, presets: ["24h", "7d", "30d", "60d"] },
	pulse: { def: "24h", asOf: false, presets: ["24h", "7d", "30d"] },
	map: { def: "now", asOf: true, presets: ["24h", "7d", "30d", "60d"] },
	movers: { def: "7d", asOf: false, presets: ["24h", "7d", "30d", "60d"] },
	closest: { def: "now", asOf: true, presets: ["24h", "7d", "30d", "60d"] },
	gaps: { def: "now", asOf: true, presets: ["24h", "7d", "30d", "60d"] },
	leaders: { def: "30d", asOf: false, presets: ["24h", "7d", "30d", "60d"] },
} as const;
export type SectionKey = keyof typeof SECTIONS;
