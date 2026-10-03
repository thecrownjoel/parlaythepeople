/**
 * Price-history charts: range definitions, downsampling and SVG rendering.
 * Rendered on the server (race pages, /api/v1/chart/…) so every range is real HTML.
 */
import { env } from "cloudflare:workers";
import type { HistoryPoint } from "./markets";

export interface Range { key: string; label: string; words: string; secs: number | null; bucket: number }
export const RANGES: Range[] = [
	{ key: "1d", label: "24H", words: "the past 24 hours", secs: 86400, bucket: 0 },
	{ key: "1w", label: "1W", words: "the past week", secs: 7 * 86400, bucket: 3600 },
	{ key: "1m", label: "1M", words: "the past 30 days", secs: 30 * 86400, bucket: 6 * 3600 },
	{ key: "3m", label: "3M", words: "the past 3 months", secs: 90 * 86400, bucket: 86400 },
	{ key: "1y", label: "1Y", words: "the past year", secs: 365 * 86400, bucket: 86400 },
	{ key: "all", label: "All", words: "all recorded history", secs: null, bucket: 86400 },
];
export const DEFAULT_RANGE = "3m";
export const rangeOf = (key?: string | null) => RANGES.find((r) => r.key === key) ?? RANGES.find((r) => r.key === DEFAULT_RANGE)!;

/** History for one race within a range, thinned to the last point per bucket, ending at `latest` if given. */
export async function getSeries(raceId: string, range: Range, latest?: HistoryPoint | null): Promise<HistoryPoint[]> {
	const now = latest?.ts ?? Math.floor(Date.now() / 1000);
	const since = range.secs ? now - range.secs : 0;
	let rows: HistoryPoint[] = [];
	try {
		const { results } = await env.MARKETS.prepare(
			"SELECT ts, k_d, k_r, p_d, p_r FROM race_history WHERE race_id = ? AND ts >= ? ORDER BY ts",
		).bind(raceId, since).all<HistoryPoint>();
		rows = results ?? [];
	} catch {
		rows = [];
	}
	if (range.bucket) {
		const byBucket = new Map<number, HistoryPoint>();
		for (const r of rows) byBucket.set(Math.floor(r.ts / range.bucket), r); // last point in each bucket wins
		rows = [...byBucket.values()];
	}
	if (latest && (!rows.length || latest.ts > rows[rows.length - 1].ts)) rows.push(latest);
	return rows;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface ChartOptions { party?: "D" | "R"; label: string; range: Range; electionDay?: string }

/** One sentence describing the move over the range, using the average of the exchanges. */
export function describeMove(points: HistoryPoint[], o: ChartOptions) {
	const f = o.party === "R" ? (["k_r", "p_r"] as const) : (["k_d", "p_d"] as const);
	const avg = (p: HistoryPoint) => {
		const v = [p[f[0]], p[f[1]]].filter((x) => x != null) as number[];
		return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
	};
	const first = points.find((p) => avg(p) != null), last = [...points].reverse().find((p) => avg(p) != null);
	if (!first || !last || first === last) return `Not enough recorded prices yet for ${o.range.words}.`;
	const a = avg(first)!, b = avg(last)!, d = (b - a) * 100;
	const who = o.party === "R" ? "Republican" : "Democratic";
	if (Math.abs(d) < 0.5) return `${who} odds are essentially unchanged over ${o.range.words}, at ${Math.round(b * 100)}%.`;
	return `${who} odds ${d > 0 ? "rose" : "fell"} ${Math.abs(d).toFixed(1)} points over ${o.range.words}, from ${Math.round(a * 100)}% to ${Math.round(b * 100)}%.`;
}

/**
 * Line chart: Kalshi solid, Polymarket dashed, in the party's color, 0–100% scale.
 * The lines are an SVG stretched to the box (strokes stay crisp); labels are HTML so they stay
 * readable at any width.
 */
export function renderChart(points: HistoryPoint[], o: ChartOptions): string {
	const f = o.party === "R" ? (["k_r", "p_r"] as const) : (["k_d", "p_d"] as const);
	const pts = points.filter((p) => p[f[0]] != null || p[f[1]] != null);
	if (pts.length < 2) {
		return `<p class="hc-empty">Not enough recorded prices for ${esc(o.range.words)} yet. Prices are recorded every 10 minutes; try a longer range.</p>`;
	}
	const t1 = pts[pts.length - 1].ts;
	const t0 = o.range.secs ? Math.min(pts[0].ts, t1 - o.range.secs) : pts[0].ts;
	const span = Math.max(1, t1 - t0);
	const xp = (t: number) => ((t - t0) / span) * 100; // percent across
	const path = (k: (typeof f)[number]) => {
		let d = "", pen = false;
		for (const p of pts) {
			const v = p[k];
			if (v == null) { pen = false; continue; }
			d += `${pen ? "L" : "M"}${(xp(p.ts) * 10).toFixed(1)},${((1 - v) * 100).toFixed(2)}`;
			pen = true;
		}
		return d;
	};
	const fmt = (t: number) => new Date(t * 1000).toLocaleString("en-US", span <= 2 * 86400
		? { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }
		: span <= 120 * 86400 ? { month: "short", day: "numeric", timeZone: "America/New_York" }
		: { month: "short", year: "numeric", timeZone: "America/New_York" });
	const color = o.party === "R" ? "var(--bt-r)" : "var(--bt-d)";
	const ns = 'vector-effect="non-scaling-stroke"';
	const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="0" x2="1000" y1="${100 - v}" y2="${100 - v}" class="${v === 50 ? "hc-mid" : "hc-grid"}" ${ns}/>`).join("");
	const ylab = [0, 25, 50, 75, 100].map((v) => `<span class="hc-y" style="top:${100 - v}%">${v}%</span>`).join("");
	const xlab = [0, 50, 100].map((p, i) => `<span class="hc-x hc-x${i}" style="left:${p}%">${esc(fmt(t0 + (span * p) / 100))}</span>`).join("");
	let marker = "", markerLab = "";
	if (o.electionDay) {
		const ed = Math.floor(new Date(`${o.electionDay}T19:00:00-05:00`).getTime() / 1000); // polls closing
		if (ed > t0 && ed < t1) {
			const ex = xp(ed);
			marker = `<line x1="${(ex * 10).toFixed(1)}" x2="${(ex * 10).toFixed(1)}" y1="0" y2="100" class="hc-ed" ${ns}/>`;
			markerLab = `<span class="hc-edl${ex > 75 ? " hc-edl-r" : ""}" style="left:${ex.toFixed(2)}%">Election Day</span>`;
		}
	}
	const last = pts[pts.length - 1];
	const lastTxt = (k: (typeof f)[number]) => (last[k] != null ? `${Math.round(last[k]! * 100)}%` : "n/a");
	return `<figure class="hc"><div class="hc-plot">`
		+ `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="${esc(`${o.label}, ${o.range.words}: Kalshi ${lastTxt(f[0])}, Polymarket ${lastTxt(f[1])} most recently`)}">${grid}${marker}`
		+ `<path d="${path(f[1])}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="5 4" opacity="0.85" ${ns}/>`
		+ `<path d="${path(f[0])}" fill="none" stroke="${color}" stroke-width="2" ${ns}/></svg>`
		+ `${ylab}${xlab}${markerLab}</div>`
		+ `<figcaption class="hc-legend"><span><i class="hc-solid" style="border-color:${color}"></i>Kalshi</span><span><i class="hc-dash" style="border-color:${color}"></i>Polymarket</span><span>${esc(o.label)}, ${esc(fmt(t0))} – ${esc(fmt(t1))}</span></figcaption></figure>`;
}

// ---------------------------------------------------------------- multi-line charts
/** One line on a multi-line chart: a race's party odds, or one outcome of a non-race market. */
export interface SeriesSpec { kind: "race" | "out"; id: string; key: string; label: string; color: string; dash?: boolean }
const SPEC_ID = /^[0-9]{4}-[a-z0-9-]{2,60}$/;
export function validSpecs(x: unknown): SeriesSpec[] | null {
	if (!Array.isArray(x) || !x.length || x.length > 8) return null;
	const ok = x.every((s) => s && (s.kind === "race" || s.kind === "out") && SPEC_ID.test(s.id) && typeof s.key === "string" && s.key.length <= 80
		&& typeof s.label === "string" && s.label.length <= 60 && typeof s.color === "string" && /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i.test(s.color));
	return ok ? (x as SeriesSpec[]) : null;
}

/** Average of both exchanges for one line, thinned to the range's bucket size. */
export async function getSpecSeries(spec: SeriesSpec, range: Range): Promise<{ ts: number; v: number }[]> {
	const now = Math.floor(Date.now() / 1000);
	const since = range.secs ? now - range.secs : 0;
	let rows: { ts: number; a: number | null; b: number | null }[] = [];
	try {
		if (spec.kind === "race") {
			const [a, b] = spec.key === "R" ? ["k_r", "p_r"] : ["k_d", "p_d"];
			rows = (await env.MARKETS.prepare(`SELECT ts, ${a} AS a, ${b} AS b FROM race_history WHERE race_id = ? AND ts >= ? ORDER BY ts`)
				.bind(spec.id, since).all<{ ts: number; a: number | null; b: number | null }>()).results ?? [];
		} else {
			rows = (await env.MARKETS.prepare("SELECT ts, k AS a, p AS b FROM outcome_history WHERE group_id = ? AND outcome = ? AND ts >= ? ORDER BY ts")
				.bind(spec.id, spec.key, since).all<{ ts: number; a: number | null; b: number | null }>()).results ?? [];
		}
	} catch {
		rows = [];
	}
	const pts = rows.map((r) => {
		const v = [r.a, r.b].filter((x): x is number => x != null);
		return v.length ? { ts: r.ts, v: v.reduce((x, y) => x + y, 0) / v.length } : null;
	}).filter((p): p is { ts: number; v: number } => p != null);
	if (!range.bucket) return pts;
	const by = new Map<number, { ts: number; v: number }>();
	for (const p of pts) by.set(Math.floor(p.ts / range.bucket), p);
	return [...by.values()];
}

/** Several lines on one 0–100% chart, each labeled at its right end (labels nudged apart). */
export function renderMulti(series: { spec: SeriesSpec; points: { ts: number; v: number }[] }[], o: { range: Range; electionDay?: string; title: string }): string {
	const live = series.filter((s) => s.points.length > 1);
	if (!live.length) return `<p class="hc-empty">Not enough recorded prices for ${esc(o.range.words)} yet; try a longer range.</p>`;
	const t1 = Math.max(...live.map((s) => s.points[s.points.length - 1].ts));
	const first = Math.min(...live.map((s) => s.points[0].ts));
	const t0 = o.range.secs ? Math.min(first, t1 - o.range.secs) : first;
	const span = Math.max(1, t1 - t0);
	const xp = (t: number) => ((t - t0) / span) * 100;
	const ns = 'vector-effect="non-scaling-stroke"';
	const fmt = (t: number) => new Date(t * 1000).toLocaleString("en-US", span <= 2 * 86400
		? { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }
		: span <= 120 * 86400 ? { month: "short", day: "numeric", timeZone: "America/New_York" }
		: { month: "short", year: "numeric", timeZone: "America/New_York" });
	const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="0" x2="1000" y1="${100 - v}" y2="${100 - v}" class="${v === 50 ? "hc-mid" : "hc-grid"}" ${ns}/>`).join("");
	const ylab = [0, 25, 50, 75, 100].map((v) => `<span class="hc-y" style="top:${100 - v}%">${v}%</span>`).join("");
	const xlab = [0, 50, 100].map((p, i) => `<span class="hc-x hc-x${i}" style="left:${p}%">${esc(fmt(t0 + (span * p) / 100))}</span>`).join("");
	let marker = "", markerLab = "";
	if (o.electionDay) {
		const ed = Math.floor(new Date(`${o.electionDay}T19:00:00-05:00`).getTime() / 1000);
		if (ed > t0 && ed < t1) {
			const ex = xp(ed);
			marker = `<line x1="${(ex * 10).toFixed(1)}" x2="${(ex * 10).toFixed(1)}" y1="0" y2="100" class="hc-ed" ${ns}/>`;
			markerLab = `<span class="hc-edl${ex > 75 ? " hc-edl-r" : ""}" style="left:${ex.toFixed(2)}%">Election Day</span>`;
		}
	}
	const paths = live.map((s) => {
		const d = s.points.map((p, i) => `${i ? "L" : "M"}${(xp(p.ts) * 10).toFixed(1)},${((1 - p.v) * 100).toFixed(2)}`).join("");
		return `<path d="${d}" fill="none" stroke="${s.spec.color}" stroke-width="2.2" ${s.spec.dash ? 'stroke-dasharray="6 4"' : ""} stroke-linejoin="round" ${ns}/>`;
	}).join("");
	// end labels, pushed apart so they don't overlap (in % of plot height)
	const ends = live.map((s) => ({ s, y: (1 - s.points[s.points.length - 1].v) * 100, v: s.points[s.points.length - 1].v })).sort((a, b) => a.y - b.y);
	// keep labels at least 8% apart and inside the plot (4%–96%)
	for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 8) ends[i].y = ends[i - 1].y + 8;
	const over = ends.length ? ends[ends.length - 1].y - 96 : 0;
	if (over > 0) for (const e of ends) e.y -= over;
	for (let i = ends.length - 2; i >= 0; i--) if (ends[i + 1].y - ends[i].y < 8) ends[i].y = ends[i + 1].y - 8;
	for (const e of ends) e.y = Math.max(4, e.y);
	const labels = ends.map((e) => `<span class="hc-end" style="top:${e.y.toFixed(1)}%;color:${e.s.spec.color}" title="${esc(e.s.spec.label)}"><b>${Math.round(e.v * 100)}%</b> ${esc(e.s.spec.label)}</span>`).join("");
	const aria = `${o.title}, ${o.range.words}: ` + ends.map((e) => `${e.s.spec.label} ${Math.round(e.v * 100)}%`).join(", ");
	return `<figure class="hc hc-multi"><div class="hc-plot">`
		+ `<svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label="${esc(aria)}">${grid}${marker}${paths}</svg>`
		+ `${ylab}${xlab}${markerLab}${labels}</div></figure>`;
}
