import type { APIRoute } from "astro";
import { getCycle, latestPoint } from "../../../../lib/markets";
import { getSeries, rangeOf, renderChart, describeMove } from "../../../../lib/chart";

/** A race's history chart for one range, as an HTML fragment (used by the range buttons). */
export const GET: APIRoute = async ({ params, url }) => {
	const id = params.id ?? "";
	const m = /^(\d{4})-[a-z0-9-]{3,60}$/.exec(id);
	if (!m) return new Response("Unknown race.", { status: 400 });
	const data = await getCycle(Number(m[1]));
	const latest = data ? latestPoint(data, id) : null;
	if (!data || !latest) return new Response("Unknown race.", { status: 404 });
	const range = rangeOf(url.searchParams.get("range"));
	const party = url.searchParams.get("party") === "R" ? "R" : "D";
	const label = `${party === "R" ? "Republican" : "Democratic"} odds${id.endsWith("-president") ? " to win the presidency" : ""}`;
	const points = await getSeries(id, range, latest);
	const opts = { party, label, range, electionDay: data.meta.election_day } as const;
	const html = `<p class="hc-move">${describeMove(points, opts)}</p>${renderChart(points, opts)}`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
};
