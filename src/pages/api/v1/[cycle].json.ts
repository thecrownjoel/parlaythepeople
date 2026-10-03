import type { APIRoute } from "astro";
import { getCycle } from "../../../lib/markets";

/** Everything Parlay the People has for one cycle: races, big-picture markets, presidency, ballot measures. */
export const GET: APIRoute = async ({ params }) => {
	if (!/^\d{4}$/.test(params.cycle ?? "")) return Response.json({ error: "Use a four-digit year, e.g. /api/v1/2026.json" }, { status: 400 });
	const data = await getCycle(Number(params.cycle));
	if (!data) return Response.json({ error: `No data for ${params.cycle}.` }, { status: 404 });
	return Response.json(data, { headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } });
};
