import type { APIRoute } from "astro";
import { getHistory } from "../../../../lib/markets";
import { getSeries, RANGES } from "../../../../lib/chart";

/**
 * Price history for one race: Democratic and Republican odds on each exchange over time.
 * ?range=1d|1w|1m|3m|1y|all returns that window thinned for charting; without it, every stored point.
 */
export const GET: APIRoute = async ({ params, url }) => {
	const id = params.id ?? "";
	if (!/^\d{4}-[a-z0-9-]{3,60}$/.test(id)) return Response.json({ error: "Unknown race id." }, { status: 400 });
	const rangeKey = url.searchParams.get("range");
	const range = RANGES.find((r) => r.key === rangeKey);
	const points = range ? await getSeries(id, range) : await getHistory(id);
	if (!points.length) return Response.json({ error: `No history for ${id}${range ? ` in range ${range.key}` : ""}.` }, { status: 404 });
	return Response.json(
		{
			race_id: id,
			range: range?.key ?? "all-raw",
			fields: { ts: "unix seconds (UTC)", k_d: "Kalshi Democratic odds", k_r: "Kalshi Republican odds", p_d: "Polymarket Democratic odds", p_r: "Polymarket Republican odds" },
			resolution: "every 10 minutes for the last 7 days, hourly to 90 days, daily before that (daily history back to Nov 2024 comes from the exchanges' own price history); election weeks are kept at full detail",
			points,
		},
		{ headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } },
	);
};
