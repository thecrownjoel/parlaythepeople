/** Shared renderer for share images: HTML card → PNG via Browser Rendering, cached in R2 for six hours. */
import { env } from "cloudflare:workers";
import puppeteer from "@cloudflare/puppeteer";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const CARD_CSS = `*{box-sizing:border-box;margin:0}body{width:1200px;height:630px;background:#0e1218;color:#e8ebf0;font-family:'IBM Plex Sans',sans-serif;padding:56px 64px;display:flex;flex-direction:column;position:relative;overflow:hidden}
body:before{content:"";position:absolute;inset:-30% -10% auto auto;width:70%;height:140%;background:radial-gradient(closest-side,rgba(163,38,42,.28),transparent)}
.top{display:flex;align-items:center;gap:16px;position:relative}.top img{width:56px;height:56px}.brand{font:800 26px Montserrat;letter-spacing:.02em;line-height:1}.brand small{display:block;font-size:17px;letter-spacing:.08em}
.eyebrow{font:700 20px Montserrat;letter-spacing:.14em;text-transform:uppercase;color:#a9b0bc;position:relative}
h1{font:800 56px/1.05 Montserrat;position:relative}
.foot{display:flex;justify-content:space-between;font-size:22px;color:#a9b0bc;position:relative}.foot b{color:#4cc38a}`;

export function cardHtml(origin: string, body: string, css = "") {
	return `<!doctype html><html><head><meta charset="utf-8"><link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800&family=IBM+Plex+Sans:wght@500;600&display=block" rel="stylesheet"><style>${CARD_CSS}${css}</style></head><body><div class="top"><img src="${origin}/brand/mark.png"><div class="brand">PARLAY<small>THE PEOPLE</small></div></div>${body}</body></html>`;
}

/** Return the cached PNG for `key`, or render `html` and cache it. Falls back to the static brand image. */
export async function renderCard(key: string, html: string, origin: string): Promise<Response> {
	const slot = Math.floor(Date.now() / 21_600_000);
	const k = `og/${key}/${slot}.png`;
	const headers = { "content-type": "image/png", "cache-control": "public, max-age=3600, s-maxage=21600" };
	const hit = await env.DATA.get(k);
	if (hit) return new Response(hit.body, { headers });
	try {
		const browser = await puppeteer.launch(env.BROWSER);
		try {
			const page = await browser.newPage();
			await page.setViewport({ width: 1200, height: 630 });
			await page.setContent(html, { waitUntil: "networkidle0", timeout: 15000 });
			const png = (await page.screenshot({ type: "png" })) as Uint8Array<ArrayBuffer>;
			await env.DATA.put(k, png, { httpMetadata: { contentType: "image/png" } });
			return new Response(png, { headers });
		} finally {
			await browser.close();
		}
	} catch (e) {
		console.error("og render", key, String(e));
		return Response.redirect(`${origin}/brand/og.jpg`, 302);
	}
}
