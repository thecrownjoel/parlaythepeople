import { defineMiddleware } from "astro:middleware";

/**
 * Redirects http and www to https://parlaythepeople.com, and adds the market data to EmDash's own robots.txt and sitemap index:
 * - robots.txt: explicit welcome for search and AI crawlers, plus our sitemap and llms.txt
 * - sitemap.xml: lists /market-sitemap.xml alongside EmDash's per-collection sitemaps
 */
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
