/**
 * PDF race reports (Pro): a Deep analysis of one race plus its price charts and current numbers, laid out as a
 * print page and rendered to PDF with Browser Rendering. Files are kept in R2 (DATA, reports/<user id>/<id>.pdf).
 */
import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import chartCss from "../styles/charts.css?raw";
import { getSeries, renderChart, describeMove, rangeOf } from "./chart";
import { consensus, shares, candidate, officeTitle, pct, fmtVol, RATING_LABEL, type Race } from "./markets";
import { parlayD } from "./model";
import { mdToHtml } from "./md";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PAGE_CSS = `@page{size:Letter;margin:0.6in 0.65in}
*{box-sizing:border-box}
:root{--bt-d:#2e62d0;--bt-r:#d23f35;--color-border:#e3e6ea;--color-muted:#8a919c;--color-text-secondary:#5b6370;--font-mono:'IBM Plex Mono';--font-body:'IBM Plex Sans'}
body{margin:0;font-family:'IBM Plex Sans',sans-serif;color:#1b1f24;font-size:11pt;line-height:1.5}
.top{display:flex;align-items:center;gap:10px;border-bottom:2px solid #1b1f24;padding-bottom:10px;margin-bottom:18px}
.top img{width:34px;height:34px}.brand{font:800 13pt Montserrat;letter-spacing:.03em;line-height:1}.brand small{display:block;font-size:8.5pt;letter-spacing:.1em}
.top .meta{margin-left:auto;text-align:right;font-size:8.5pt;color:#5b6370}
h1{font:800 22pt/1.1 Montserrat;margin:0 0 6px}
.eyebrow{font:700 8.5pt Montserrat;letter-spacing:.14em;text-transform:uppercase;color:#5b6370;margin:0 0 4px}
.lede{margin:0 0 14px;color:#3b424d}
table{width:100%;border-collapse:collapse;margin:8px 0 14px;font-size:10pt}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e3e6ea}th{font-size:8.5pt;text-transform:uppercase;letter-spacing:.06em;color:#5b6370}
td.n,th.n{text-align:right;font-family:'IBM Plex Mono',monospace}
h2{font:700 13pt Montserrat;margin:18px 0 6px;break-after:avoid}
h3{font:700 11pt Montserrat;margin:14px 0 4px;break-after:avoid}
.charts{display:grid;grid-template-columns:1fr 1fr;gap:16px;break-inside:avoid}
.hc-body .hc-plot{height:150px !important}
.analysis p,.analysis li{orphans:3;widows:3}
a{color:#2e62d0;text-decoration:none}
.foot{margin-top:22px;border-top:1px solid #e3e6ea;padding-top:8px;font-size:8pt;color:#8a919c}`;

export async function reportHtml(r: Race, electionDay: string, analysis: string, origin: string) {
	const c = consensus(r);
	const ks = shares(r.k), ps = shares(r.p);
	const est = r.kind !== "control" ? parlayD(c.D, c.R) : null;
	const [m1, all] = [rangeOf("1m"), rangeOf("all")];
	const [p1, pAll] = await Promise.all([getSeries(r.id, m1), getSeries(r.id, all)]);
	const chart = (pts: typeof p1, range: typeof m1) => `<div class="hc-body"><p class="hc-move">${describeMove(pts, { label: "Democratic odds", range, electionDay })}</p>${renderChart(pts, { label: "Democratic odds", range, electionDay })}</div>`;
	const dName = candidate(r, "D"), rName = candidate(r, "R");
	const generated = new Date().toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });
	return `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=block" rel="stylesheet"><style>${chartCss}${PAGE_CSS}</style></head><body>
<div class="top"><img src="${origin}/brand/mark.png"><div class="brand">PARLAY<small>THE PEOPLE</small></div><div class="meta">Pro race report<br>${esc(generated)}</div></div>
<p class="eyebrow">${r.cycle} · ${esc(RATING_LABEL[c.rating])}</p>
<h1>${esc(officeTitle(r))}</h1>
<p class="lede">${esc([dName && `${dName} (D)`, rName && `${rName} (R)`].filter(Boolean).join(" vs. "))}. Election Day ${esc(electionDay)}. <a href="${origin}${r.path}">${origin.replace(/^https?:\/\//, "")}${esc(r.path)}</a></p>
<table><thead><tr><th>Source</th><th class="n">Democrat</th><th class="n">Republican</th></tr></thead><tbody>
<tr><td>Average of the exchanges</td><td class="n">${pct(c.D, 1)}</td><td class="n">${pct(c.R, 1)}</td></tr>
${ks ? `<tr><td>Kalshi</td><td class="n">${pct(ks.D, 1)}</td><td class="n">${pct(ks.R, 1)}</td></tr>` : ""}
${ps ? `<tr><td>Polymarket</td><td class="n">${pct(ps.D, 1)}</td><td class="n">${pct(ps.R, 1)}</td></tr>` : ""}
${est != null ? `<tr><td>Parlay estimate (our model)</td><td class="n">${pct(est, 1)}</td><td class="n">${pct(1 - est, 1)}</td></tr>` : ""}
<tr><td>Money traded to date</td><td class="n" colspan="2">${fmtVol((r.k?.v ?? 0) + (r.p?.v ?? 0))}</td></tr>
</tbody></table>
<div class="charts"><div><h3>Past month</h3>${chart(p1, m1)}</div><div><h3>Since November 2024</h3>${chart(pAll, all)}</div></div>
<h2>Analysis</h2>
<div class="analysis">${mdToHtml(analysis, origin)}</div>
<p class="foot">Odds are prediction-market prices from Kalshi and Polymarket, read as crowd probabilities. The analysis is written by Parlay the People's AI analyst from our data and may contain errors; check the linked pages. Research, not betting advice. Not affiliated with Kalshi or Polymarket.</p>
</body></html>`;
}

export async function renderPdf(html: string): Promise<Uint8Array<ArrayBuffer>> {
	const browser = await puppeteer.launch(env.BROWSER);
	try {
		const page = await browser.newPage();
		await page.setContent(html, { waitUntil: "networkidle0", timeout: 20000 });
		return (await page.pdf({ format: "letter", printBackground: true, preferCSSPageSize: true })) as Uint8Array<ArrayBuffer>;
	} finally {
		await browser.close();
	}
}
