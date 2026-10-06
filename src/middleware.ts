import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

/**
 * Redirects http and www to https://parlaythepeople.com, and adds the market data to EmDash's own robots.txt and sitemap index:
 * - robots.txt: explicit welcome for search and AI crawlers, plus our sitemap and llms.txt
 * - sitemap.xml: lists /market-sitemap.xml alongside EmDash's per-collection sitemaps
 */
// Maintenance mode (MAINTENANCE = "1" in wrangler.jsonc): the public gets a 503 "back soon" page; the EmDash admin keeps working.
const MAINTENANCE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Parlay the People</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:Inter,system-ui,sans-serif;background:#fff;color:#111}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}}main{padding:16px;text-align:center}h1{font-size:1.75rem;margin:0 0 8px}p{color:#666;margin:0}</style></head>
<body><main><h1>Parlay the People</h1><p>We're making some changes. Back soon.</p></main></body></html>`;

const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot"];

export const onRequest = defineMiddleware(async (ctx, next) => {
	// One canonical address: https, no www (http://www.… goes straight to https://… in one hop)
	const local = ctx.url.hostname === "localhost" || ctx.url.hostname === "127.0.0.1";
	if (!local && (ctx.url.hostname.startsWith("www.") || ctx.url.protocol === "http:")) {
		const to = new URL(ctx.url);
		to.protocol = "https:";
		if (to.hostname.startsWith("www.")) to.hostname = to.hostname.slice(4);
		return Response.redirect(to.toString(), 301);
	}
	if ((env as any).MAINTENANCE === "1" && !ctx.url.pathname.startsWith("/_emdash")) {
		return new Response(MAINTENANCE_PAGE, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "3600", "cache-control": "no-store" } });
	}
	const res = await next();
	const path = ctx.url.pathname;
	if (path !== "/robots.txt" && path !== "/sitemap.xml") return res;
	if (!res.ok) return res;
	const o = ctx.url.origin;
	const text = await res.text();
	let body = text;
	if (path === "/robots.txt") {
		const extra = [
			"",
			"# Search engines and AI assistants are welcome to read and cite Parlay the People.",
			...AI_CRAWLERS.flatMap((ua) => [`User-agent: ${ua}`, "Allow: /", "Disallow: /_emdash/", ""]),
			`Sitemap: ${o}/market-sitemap.xml`,
			`# AI-readable summary: ${o}/llms.txt`,
			"",
		].join("\n");
		body = text.trimEnd() + "\n" + extra;
	} else if (text.includes("</sitemapindex>")) {
		body = text.replace("</sitemapindex>", `<sitemap><loc>${o}/market-sitemap.xml</loc></sitemap>\n</sitemapindex>`);
	}
	const headers = new Headers(res.headers);
	headers.delete("content-length");
	return new Response(body, { status: res.status, headers });
});
