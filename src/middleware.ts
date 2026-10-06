import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

/**
 * Redirects http and www to https://parlaythepeople.com, and adds the market data to EmDash's own robots.txt and sitemap index:
 * - robots.txt: explicit welcome for search and AI crawlers, plus our sitemap and llms.txt
 * - sitemap.xml: lists /market-sitemap.xml alongside EmDash's per-collection sitemaps
 */
// Maintenance mode (MAINTENANCE = "1" in wrangler.jsonc): the public gets a blank black page (503); the EmDash admin keeps working.
const MAINTENANCE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="dark"><title>Parlay the People</title><style>html,body{margin:0;height:100%;background:#000}</style></head><body></body></html>`;

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
