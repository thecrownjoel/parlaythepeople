/**
 * US maps drawn on the server as SVG: states and counties from us-atlas (already projected, Albers USA, 975×610),
 * so there's no projection work here and nothing for the browser to compute.
 */
import { geoPath } from "d3-geo";
import { feature } from "topojson-client";
import statesTopo from "us-atlas/states-albers-10m.json";
import countiesTopo from "us-atlas/counties-albers-10m.json";

export const FIPS: Record<string, string> = {
	"01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID",
	"17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO",
	"30": "MT", "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA",
	"44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
};
export const ST_FIPS = Object.fromEntries(Object.entries(FIPS).map(([f, s]) => [s, f]));
const path = geoPath();

let statesMemo: { st: string; name: string; d: string }[] | null = null;
/** Every state's outline as an SVG path (viewBox 0 0 975 610). */
export function statePaths() {
	if (statesMemo) return statesMemo;
	const fc = feature(statesTopo as any, (statesTopo as any).objects.states) as any;
	statesMemo = fc.features.map((f: any) => ({ st: FIPS[String(f.id).padStart(2, "0")] ?? "", name: f.properties.name, d: path(f) ?? "" })).filter((s: any) => s.st);
	return statesMemo!;
}

const countyMemo = new Map<string, { fips: string; name: string; d: string }[]>();
let countyFc: any = null;
/** One state's counties as SVG paths, with the viewBox that frames them. */
export function countyPaths(st: string) {
	const sf = ST_FIPS[st];
	if (!sf) return { counties: [], viewBox: "0 0 975 610" };
	if (!countyMemo.has(st)) {
		countyFc ??= feature(countiesTopo as any, (countiesTopo as any).objects.counties) as any;
		countyMemo.set(st, countyFc.features.filter((f: any) => String(f.id).padStart(5, "0").startsWith(sf)).map((f: any) => ({ fips: String(f.id).padStart(5, "0"), name: f.properties.name, d: path(f) ?? "" })));
	}
	const counties = countyMemo.get(st)!;
	const fc = { type: "FeatureCollection", features: countyFc.features.filter((f: any) => String(f.id).padStart(5, "0").startsWith(sf)) };
	const [[x0, y0], [x1, y1]] = path.bounds(fc as any);
	const pad = 6;
	return { counties, viewBox: `${(x0 - pad).toFixed(1)} ${(y0 - pad).toFixed(1)} ${(x1 - x0 + pad * 2).toFixed(1)} ${(y1 - y0 + pad * 2).toFixed(1)}` };
}

/** A diverging color for a two-party margin (-1 R … +1 D), from the site's party colors. */
export function marginFill(m: number) {
	const a = Math.min(1, Math.abs(m) / 0.4);
	const pct = Math.round(18 + a * 72);
	return m >= 0 ? `color-mix(in srgb, var(--bt-d) ${pct}%, var(--color-surface))` : `color-mix(in srgb, var(--bt-r) ${pct}%, var(--color-surface))`;
}
