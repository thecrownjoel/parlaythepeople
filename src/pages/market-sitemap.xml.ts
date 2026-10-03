import type { APIRoute } from "astro";
import { getIndex, getCycle } from "../lib/markets";

/** Sitemap for the data pages (cycles, races, presidency). EmDash's /sitemap.xml covers posts and pages. */
export const GET: APIRoute = async ({ url }) => {
	const o = url.origin;
	const index = await getIndex();
	const urls: [string, string][] = [[`${o}/`, index?.generated ?? ""], [`${o}/elections/`, ""], [`${o}/methodology/`, ""], [`${o}/data/`, ""]];
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		urls.push([`${o}/${cy.year}/`, data.meta.generated]);
		if (data.pres.party || data.pres.winner) urls.push([`${o}/${cy.year}/president/`, data.meta.generated]);
		for (const r of data.races) urls.push([`${o}${r.path}`, data.meta.generated]);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
		.map(([loc, mod]) => `<url><loc>${loc}</loc>${mod ? `<lastmod>${mod}</lastmod>` : ""}</url>`)
		.join("\n")}\n</urlset>\n`;
	return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" } });
};
