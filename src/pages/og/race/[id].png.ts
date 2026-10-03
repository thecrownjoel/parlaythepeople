import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";
import { getCycle, consensus, candidate, pct, fmtVol, officeTitle, RATING_LABEL } from "../../../lib/markets";
import { parlayD } from "../../../lib/model";

/**
 * Share image for a race (1200x630): current odds, money and the Parlay estimate. Drawn with Browser
 * Rendering and cached in R2 for twelve hours, so social crawlers get a fresh card without a render per share.
 */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const GET: APIRoute = async ({ params, url }) => {
	const id = (params.id ?? "").replace(/\.png$/, "");
	const m = /^(\d{4})-[a-z0-9-]{3,60}$/.exec(id);
	const data = m ? await getCycle(Number(m[1])) : null;
	const r = data?.races.find((x) => x.id === id);
	if (!r) return Response.redirect(`${url.origin}/brand/og.jpg`, 302);

	const slot = Math.floor(Date.now() / 43_200_000); // twelve-hour window (557 races; keeps Browser Rendering time low)
	const key = `og/race/${id}/${slot}-v2.png`;
	const hit = await env.DATA.get(key);
	const headers = { "content-type": "image/png", "cache-control": "public, max-age=3600, s-maxage=43200" };
	if (hit) return new Response(hit.body, { headers });

	const c = consensus(r);
	const d = candidate(r, "D") ?? "Democrats", rep = candidate(r, "R") ?? "Republicans";
	const est = r.kind !== "control" ? parlayD(c.D, c.R) : null;
	const traded = fmtVol((r.k?.v ?? 0) + (r.p?.v ?? 0));
	const updated = new Date(data!.meta.generated).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
	const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=IBM+Plex+Sans:wght@500;600&display=block" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;background:#0e1218;color:#e8ebf0;font-family:'IBM Plex Sans',sans-serif;padding:56px 64px;display:flex;flex-direction:column;position:relative;overflow:hidden}
body:before{content:"";position:absolute;inset:-30% -10% auto auto;width:70%;height:140%;background:radial-gradient(closest-side,rgba(163,38,42,.28),transparent)}
.top{display:flex;align-items:center;gap:16px;position:relative}.top img{width:56px;height:56px}.brand{font:800 26px Montserrat;letter-spacing:.02em;line-height:1}.brand small{display:block;font-size:17px;letter-spacing:.08em}
.eyebrow{margin-top:40px;font:700 20px Montserrat;letter-spacing:.14em;text-transform:uppercase;color:#a9b0bc;position:relative}
h1{font:800 60px/1.05 Montserrat;margin-top:10px;position:relative;max-width:1080px}
.duel{display:flex;justify-content:space-between;align-items:flex-end;margin-top:auto;position:relative}
.side b{display:block;font:800 96px/1 Montserrat}.side span{font-size:28px;font-weight:600}.d b{color:#5e92ee}.r{text-align:right}.r b{color:#e85a4c}
.bar{display:flex;height:18px;border-radius:9px;overflow:hidden;gap:3px;margin-top:22px;position:relative}.bar i{display:block}
.foot{display:flex;justify-content:space-between;margin-top:22px;font-size:22px;color:#a9b0bc;position:relative}.foot b{color:#e0b44f}
</style></head><body>
<div class="top"><img src="${url.origin}/brand/mark.png"><div class="brand">PARLAY<small>THE PEOPLE</small></div></div>
<div class="eyebrow">${r.cycle} · ${esc(RATING_LABEL[c.rating])}${est != null && Math.abs(est - c.D / (c.D + c.R || 1)) >= 0.005 ? ` · Parlay estimate ${est >= 0.5 ? "D" : "R"} ${pct(Math.max(est, 1 - est))}` : ""}</div>
<h1>${esc(officeTitle(r))}</h1>
<div class="duel"><div class="side d"><b>${pct(c.D)}</b><span>${esc(d)}${candidate(r, "D") ? " (D)" : ""}</span></div><div class="side r"><b>${pct(c.R)}</b><span>${esc(rep)}${candidate(r, "R") ? " (R)" : ""}</span></div></div>
<div class="bar"><i style="width:${(c.D * 100).toFixed(1)}%;background:#5e92ee"></i>${c.O > 0.01 ? `<i style="width:${(c.O * 100).toFixed(1)}%;background:#c9cdd5"></i>` : ""}<i style="flex:1;background:#e85a4c"></i></div>
<div class="foot"><span>Kalshi + Polymarket odds · <b>${traded} traded</b> · ${updated}</span><span>parlaythepeople.com</span></div>
</body></html>`;

	let png: Uint8Array;
	try {
		const browser = await puppeteer.launch(env.BROWSER);
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 1200, height: 630 });
			await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });
			png = (await page.screenshot({ type: "png" })) as Uint8Array;
		} finally {
			await browser.close();
		}
	} catch (e) {
		console.error("og render", String(e));
		return Response.redirect(`${url.origin}/brand/og.jpg`, 302);
	}
	await env.DATA.put(key, png, { httpMetadata: { contentType: "image/png" } });
	return new Response(png, { headers });
};
