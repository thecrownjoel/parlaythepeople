import type { APIRoute } from "astro";
import { getCycle, candidate } from "../../../../lib/markets";
import { raceFinance, financeRows } from "../../../../lib/fec";
import { details, money } from "../../../../lib/finance";
import { viewerPlan } from "../../../../lib/auth";
import { gateHtml } from "../../../../lib/gate";

/**
 * Fundraising report by report for a race's nominees, as an HTML fragment. Pro (Pro gating rules: report-by-report
 * history); everyone else gets the Pro card over a placeholder, never the data.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const PLACEHOLDER = `<svg viewBox="0 0 1000 260" style="width:100%;height:auto;display:block" aria-hidden="true"><path d="M0,240 C200,220 300,180 450,150 S750,60 1000,30" fill="none" stroke="var(--bt-d)" stroke-width="3"/><path d="M0,245 C220,230 350,200 500,170 S780,110 1000,80" fill="none" stroke="var(--bt-r)" stroke-width="3"/></svg>`;

export const GET: APIRoute = async ({ params, url, cookies, request }) => {
	const id = params.id ?? "";
	const m = /^(\d{4})-[a-z0-9-]{3,60}$/.exec(id);
	const data = m ? await getCycle(Number(m[1])) : null;
	const race = data?.races.find((r) => r.id === id);
	if (!race) return new Response("Unknown race.", { status: 404 });
	const plan = await viewerPlan(cookies, request);
	const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" };
	if (plan.history !== "all") return new Response(gateHtml("time", plan, PLACEHOLDER, url.searchParams.get("from") || "/finance/"), { headers });

	const names = [candidate(race, "D"), candidate(race, "R")].filter((n): n is string => !!n);
	const { market } = financeRows(await raceFinance(race), names);
	const det = await details(market.map((x) => x.cand_id), race.cycle);
	const lines = market.map((x) => ({ x, d: det.get(x.cand_id), p: x.party === "REP" ? "r" : "d" })).filter((l) => l.d && l.d.reports.length > 1);
	if (!lines.length) return new Response(`<p class="fx-note">Report-by-report figures for this race load from the FEC within a few days of each filing.</p>`, { headers });
	// cumulative raised by report date
	const series = lines.map((l) => { let sum = 0; return { ...l, pts: l.d!.reports.map(([date, raised, , cash]) => ({ t: Date.parse(date), raised: (sum += raised), cash })) }; });
	const all = series.flatMap((s) => s.pts);
	const t0 = Math.min(...all.map((p) => p.t)), t1 = Math.max(...all.map((p) => p.t)), vmax = Math.max(1, ...all.map((p) => Math.max(p.raised, p.cash)));
	const W = 1000, H = 280, pad = 30;
	const X = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad * 2), Y = (v: number) => H - pad - (v / vmax) * (H - pad * 2);
	const path = (pts: { t: number; v: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
	const grid = [0.25, 0.5, 0.75, 1].map((f) => `<line x1="${pad}" x2="${W - pad}" y1="${Y(vmax * f)}" y2="${Y(vmax * f)}" class="fx-axis" opacity=".5"/><text x="${pad}" y="${Y(vmax * f) - 5}" class="fx-tick">${money(vmax * f)}</text>`).join("");
	const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fundraising by report" style="width:100%;height:auto;display:block;overflow:visible">${grid}`
		+ series.map((s) => `<path d="${path(s.pts.map((p) => ({ t: p.t, v: p.raised })))}" fill="none" stroke="var(--bt-${s.p})" stroke-width="3" data-draw/><path d="${path(s.pts.map((p) => ({ t: p.t, v: p.cash })))}" fill="none" stroke="var(--bt-${s.p})" stroke-width="2" stroke-dasharray="6 5" opacity=".7"/>`).join("")
		+ `<text x="${pad}" y="${H - 6}" class="fx-tick">${new Date(t0).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })}</text><text x="${W - pad}" y="${H - 6}" class="fx-tick" text-anchor="end">${new Date(t1).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}</text></svg>`;
	const legend = `<p class="fx-legend">${series.map((s) => `<span><i style="background:var(--bt-${s.p})"></i>${esc(s.x.name.split(",").reverse().join(" ").trim())}: raised in total (solid), cash on hand (dashed)</span>`).join("")}</p>`;
	return new Response(svg + legend, { headers });
};
