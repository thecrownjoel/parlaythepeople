import type { APIRoute } from "astro";
import { getIndex } from "../../../lib/markets";

/** Which cycles exist, which one is next, and where each cycle's data lives. */
export const GET: APIRoute = async ({ url }) => {
	const index = await getIndex();
	if (!index) return Response.json({ error: "Data not available yet." }, { status: 503 });
	const body = {
		...index,
		cycles: index.cycles.map((c) => ({ ...c, json: `${url.origin}/api/v1/${c.year}.json`, csv: `${url.origin}/api/v1/${c.year}/races.csv`, page: `${url.origin}/${c.year}/` })),
		license: "Free to use with attribution to Parlay the People and a link to the page you used.",
	};
	return Response.json(body, { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });
};
