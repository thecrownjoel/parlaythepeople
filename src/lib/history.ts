/**
 * Past elections (/voting/): MEDSL official results (President, Senate, House 1976-2024; counties 2000-2024) and
 * OpenElections 2022 county results, from R2 history/ (ingest/history.py). Each view renders HTML, so the page shows
 * the free latest year and /api/v1/past renders earlier years for Pro (Pro gating rules).
 */
import { r2json } from "./markets";
import { STATES, statePath } from "./states";
import { countyPaths, marginFill } from "./usmap";
import { slugify } from "./politics";

export interface Vote { D: number; R: number; T: number; dn?: string | null; rn?: string | null; w?: string | null }
export interface PresData { national: Record<string, Vote>; states: Record<string, Record<string, Vote>> }
export interface SenateRace extends Vote { year: number; special: boolean }
export interface StateHistory { house: Record<string, Record<string, Vote>>; counties: Record<string, { n: string; y: Record<string, [number, number, number]> }>; mid2022: Record<string, Record<string, [number, number, number]>> | null }

export const getPresident = () => r2json<PresData>("history/president.json");
export const getSenateHistory = () => r2json<Record<string, SenateRace[]>>("history/senate.json");
export const getHouseSeats = () => r2json<Record<string, Record<string, [number, number, number]>>>("history/house-seats.json");
export const getStateHistory = (st: string) => r2json<StateHistory>(`history/states/${st}.json`);

export const PRES_YEARS = [1976, 1980, 1984, 1988, 1992, 1996, 2000, 2004, 2008, 2012, 2016, 2020, 2024];
export const COUNTY_YEARS = [2000, 2004, 2008, 2012, 2016, 2020, 2024];
export const LATEST_PRES = 2024, LATEST_HOUSE = 2024;
export const votingPath = (st: string) => `/voting/${slugify(STATES[st] ?? st)}/`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const n = (x: number) => x.toLocaleString("en-US");
/** "Harris, Kamala D." → "Kamala D. Harris"; "Rob Bresnahan, Jr." stays "Rob Bresnahan Jr." */
export const person = (s?: string | null) => {
	if (!s) return "";
	const [a, b] = s.split(",").map((x) => x.trim());
	if (!b) return s;
	return /^(jr|sr|ii|iii|iv)\.?$/i.test(b) ? `${a} ${b}` : `${b} ${a}`;
};
export const margin = (v: Vote) => (v.D - v.R) / ((v.D + v.R) || 1);
export const marginWords = (v: Vote) => {
	const m = margin(v);
	return `${m >= 0 ? "D" : "R"}+${Math.abs(m * 100).toFixed(1)}`;
};

/** Head-to-head bar: the two parties' shares of all votes cast, the rest gray, with names and totals. */
export function duelBar(v: Vote, label: string) {
	const d = v.D / (v.T || 1), r = v.R / (v.T || 1), o = Math.max(0, 1 - d - r);
	return `<div class="vx-duel"><p class="vx-duel-h"><b>${esc(label)}</b><span>${marginWords(v)}</span></p>`
		+ `<div class="vx-bar"><i class="d" data-grow style="width:${(d * 100).toFixed(2)}%"></i><i class="o" style="width:${(o * 100).toFixed(2)}%"></i><i class="r" data-grow style="width:${(r * 100).toFixed(2)}%"></i></div>`
		+ `<p class="vx-duel-n"><span><b class="d">${esc(person(v.dn) || "Democrat")}</b> ${pct(d)} · ${n(v.D)}</span><span><b class="r">${esc(person(v.rn) || "Republican")}</b> ${pct(r)} · ${n(v.R)}</span></p></div>`;
}

const GRID: Record<string, [number, number]> = {
	AK: [0, 0], ME: [11, 0], VT: [10, 1], NH: [11, 1],
	WA: [1, 2], ID: [2, 2], MT: [3, 2], ND: [4, 2], MN: [5, 2], IL: [6, 2], WI: [7, 2], MI: [8, 2], NY: [9, 2], RI: [10, 2], MA: [11, 2],
	OR: [1, 3], NV: [2, 3], WY: [3, 3], SD: [4, 3], IA: [5, 3], IN: [6, 3], OH: [7, 3], PA: [8, 3], NJ: [9, 3], CT: [10, 3],
	CA: [1, 4], UT: [2, 4], CO: [3, 4], NE: [4, 4], MO: [5, 4], KY: [6, 4], WV: [7, 4], VA: [8, 4], MD: [9, 4], DE: [10, 4],
	AZ: [2, 5], NM: [3, 5], KS: [4, 5], AR: [5, 5], TN: [6, 5], NC: [7, 5], SC: [8, 5], DC: [9, 5],
	OK: [4, 6], LA: [5, 6], MS: [6, 6], AL: [7, 6], GA: [8, 6],
	HI: [0, 7], TX: [4, 7], FL: [9, 7],
};

/** Every state as a tile, colored by the presidential margin that year, linking to its voting page. */
export function nationTiles(pres: PresData, year: number) {
	const tiles = Object.entries(GRID).map(([st, [x, y]]) => {
		const v = pres.states[st]?.[year];
		const fill = v ? marginFill(margin(v)) : "rgb(127 127 127 / .15)";
		const title = v ? `${STATES[st]}: ${marginWords(v)} (${person(v.dn)} ${pct(v.D / (v.T || 1))}, ${person(v.rn)} ${pct(v.R / (v.T || 1))})` : STATES[st];
		return `<a href="${votingPath(st)}" class="vx-tile" style="grid-column:${x + 1};grid-row:${y + 1};background:${fill}" title="${esc(title)}"><b>${st}</b>${v ? `<small>${marginWords(v)}</small>` : ""}</a>`;
	}).join("");
	const v = pres.national[year];
	return `<div class="vx-tiles" data-pop>${tiles}</div>${v ? duelBar(v, `${year} popular vote`) : ""}`;
}

/** House seats won by each party that year, as a row of seats. */
export function seatsBar(seats: Record<string, Record<string, [number, number, number]>>, year: number) {
	const y = seats[year];
	if (!y) return "";
	const [d, r, o] = [0, 1, 2].map((i) => Object.values(y).reduce((a, v) => a + v[i], 0));
	const dots = [...Array(d).fill("d"), ...Array(o).fill("o"), ...Array(r).fill("r")].map((c) => `<i class="${c}"></i>`).join("");
	return `<div class="vx-seats"><p class="vx-duel-h"><b>House seats won in ${year}</b><span>${d > r ? "D" : "R"} majority</span></p><div class="vx-dots" data-pop>${dots}</div>`
		+ `<p class="vx-duel-n"><span><b class="d">Democrats</b> ${d}</span>${o ? `<span>Other ${o}</span>` : ""}<span><b class="r">Republicans</b> ${r}</span></p></div>`;
}

/** One state's counties, colored by margin, for a presidential year (MEDSL) or a 2022 office (OpenElections). */
export function countyMap(st: string, h: StateHistory, pick: { year: number } | { mid: "senate" | "governor" }) {
	const { counties, viewBox } = countyPaths(st);
	// 2022 county names come from each state's files ("Mckean", "Adams County"): match them loosely
	const norm = (s: string) => s.toLowerCase().replace(/\s+(county|parish|borough|city)$/, "").replace(/[^a-z]/g, "");
	const mid = "mid" in pick ? new Map(Object.entries(h.mid2022?.[pick.mid] ?? {}).map(([k, v]) => [norm(k), v])) : null;
	let tot = { D: 0, R: 0, T: 0 };
	const paths = counties.map((c) => {
		let v: [number, number, number] | undefined;
		if ("year" in pick) v = h.counties[c.fips]?.y[pick.year];
		else v = mid!.get(norm(c.name));
		if (v) { tot.D += v[0]; tot.R += v[1]; tot.T += v[2]; }
		const m = v ? (v[0] - v[1]) / ((v[0] + v[1]) || 1) : null;
		const label = v ? `${c.name}: ${m! >= 0 ? "D" : "R"}+${Math.abs(m! * 100).toFixed(1)} (${n(v[0])} D, ${n(v[1])} R)` : `${c.name}: no data`;
		return `<path d="${c.d}" style="fill:${m == null ? "rgb(127 127 127 / .15)" : marginFill(m)}"><title>${esc(label)}</title></path>`;
	}).join("");
	if (!tot.T) return `<p class="fx-note">No county results for this election.</p>`;
	return `<figure class="fx-map vx-map"><svg viewBox="${viewBox}" role="img" aria-label="County results in ${esc(STATES[st])}"><g data-pop>${paths}</g></svg></figure>`;
}

/** A state's House races in one year: district, winner, margin. */
export function houseTable(st: string, h: StateHistory, year: number) {
	const y = h.house[year];
	if (!y) return `<p class="fx-note">No House results for ${year}.</p>`;
	const rows = Object.entries(y).sort((a, b) => Number(a[0]) - Number(b[0])).map(([dist, v]) => {
		const w = v.w === "D" ? `<b class="d">${esc(person(v.dn))}</b>` : v.w === "R" ? `<b class="r">${esc(person(v.rn))}</b>` : "Other";
		return `<tr><th scope="row">${dist === "0" ? "At large" : `${st}-${dist.padStart(2, "0")}`}</th><td>${w}</td><td>${v.D && v.R ? marginWords(v) : "Unopposed"}</td></tr>`;
	}).join("");
	const won = Object.values(y);
	return `<p class="vx-duel-h"><b>${year}: ${won.filter((v) => v.w === "D").length} D, ${won.filter((v) => v.w === "R").length} R</b></p><div class="fin-scroll"><table class="vx-t"><thead><tr><th scope="col">District</th><th scope="col">Winner</th><th scope="col">Margin</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

/** A state's Senate races, newest first (all of them for Pro; the latest only otherwise). */
export function senateList(races: SenateRace[], all: boolean) {
	const list = [...races].reverse().slice(0, all ? 99 : 1);
	return `<ul class="vx-sen">${list.map((r) => `<li><span class="vx-yr">${r.year}${r.special ? " special" : ""}</span>${duelBar(r, "")}</li>`).join("")}</ul>`;
}

export const stateLink = (st: string) => statePath(st);
