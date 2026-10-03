import type { APIRoute } from "astro";
import { getHistory } from "../../../../lib/markets";

/** Price history for one race: Democratic and Republican odds on each exchange over time. */
export const GET: APIRoute = async ({ params }) => {
	const id = params.id ?? "";
	if (!/^\d{4}-[a-z0-9-]{3,60}$/.test(id)) return Response.json({ error: "Unknown race id." }, { status: 400 });
	const points = await getHistory(id);
	if (!points.length) return Response.json({ error: `No history for ${id}.` }, { status: 404 });
	return Response.json(
		{
			race_id: id,
			fields: { ts: "unix seconds (UTC)", k_d: "Kalshi Democratic odds", k_r: "Kalshi Republican odds", p_d: "Polymarket Democratic odds", p_r: "Polymarket Republican odds" },
			resolution: "every 10 minutes for the last 7 days, hourly before that",
			points,
		},
		{ headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
	);
};
