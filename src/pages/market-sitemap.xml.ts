import { TOPIC_SLUG, getPolitics, marketPath } from "../lib/politics";
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { getIndex, getCycle } from "../lib/markets";
import { authorPath } from "../lib/site";

/** Sitemap for the data pages (cycles, races, presidency) and author pages. EmDash's /sitemap.xml covers posts and pages. */
export const GET: APIRoute = async ({ url }) => {
	const o = url.origin;
	const index = await getIndex();
	const urls: [string, string][] = [[`${o}/`, index?.generated ?? ""], [`${o}/elections/`, ""], [`${o}/methodology/`, ""], [`${o}/guide/`, ""], [`${o}/data/`, ""], [`${o}/posts/`, ""], [`${o}/model/`, ""]];
	// daily market reports since money and headlines began, plus the archive page
	urls.push([`${o}/daily/`, ""], [`${o}/politics/`, index?.generated ?? ""]);
	for (const slug of Object.values(TOPIC_SLUG)) urls.push([`${o}/politics/${slug}/`, index?.generated ?? ""]);
	// one page per politics market
	const board = await getPolitics();
	for (const e of board?.events ?? []) urls.push([`${o}${marketPath(e)}`, board!.generated]);
	for (let t = Date.parse("2026-09-30T00:00:00Z"); t < Date.now() - 86_400_000; t += 86_400_000) {
		const d = new Date(t).toISOString().slice(0, 10);
		urls.push([`${o}/daily/${d}/`, new Date(t + 86_400_000).toISOString().slice(0, 10)]);
	}
	try {
		const { results } = await env.DB.prepare("SELECT slug, MAX(updated_at) AS mod FROM _emdash_bylines GROUP BY slug").all<{ slug: string; mod: string }>();
		for (const b of results ?? []) urls.push([`${o}${authorPath(b.slug)}`, b.mod ?? ""]);
	} catch { /* bylines table unavailable: skip author pages */ }
	// each race's last real price change (history is written only when odds move), so lastmod means something
	const changed = new Map<string, string>();
	try {
		const { results } = await env.MARKETS.prepare("SELECT race_id, MAX(ts) AS t FROM race_history GROUP BY race_id").all<{ race_id: string; t: number }>();
		for (const r of results ?? []) changed.set(r.race_id, new Date(r.t * 1000).toISOString().replace(/\.\d{3}Z$/, "+00:00"));
	} catch { /* fall back to the cycle's generation time */ }
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		urls.push([`${o}/${cy.year}/`, data.meta.generated]);
		if (data.pres.party || data.pres.winner) urls.push([`${o}/${cy.year}/president/`, data.meta.generated]);
		for (const r of data.races) urls.push([`${o}${r.path}`, changed.get(r.id) ?? data.meta.generated]);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
		.map(([loc, mod]) => `<url><loc>${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`)
		.join("\n")}\n</urlset>\n`;
	return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" } });
};
