import type { APIRoute } from "astro";
import { getCycle, latestPoint } from "../../../../lib/markets";
import { getSeries, rangeOf, renderChart, describeMove, DEFAULT_RANGE } from "../../../../lib/chart";
import { viewerPlan } from "../../../../lib/auth";
import { rangeGate, gateHtml } from "../../../../lib/gate";
import { PLANS } from "../../../../lib/plans";

/** A race's history chart for one range, as an HTML fragment (used by the range buttons). */
export const GET: APIRoute = async ({ params, url, cookies }) => {
	const id = params.id ?? "";
	const m = /^(\d{4})-[a-z0-9-]{3,60}$/.exec(id);
	if (!m) return new Response("Unknown race.", { status: 400 });
	const data = await getCycle(Number(m[1]));
	const latest = data ? latestPoint(data, id) : null;
	if (!data || !latest) return new Response("Unknown race.", { status: 404 });
	const range = rangeOf(url.searchParams.get("range"));
	const party = url.searchParams.get("party") === "R" ? "R" : "D";
	const label = `${party === "R" ? "Republican" : "Democratic"} odds${id.endsWith("-president") ? " to win the presidency" : ""}`;
	const chart = async (r: typeof range) => {
		const points = await getSeries(id, r, latest);
		const opts = { party, label, range: r, electionDay: data.meta.election_day } as const;
		return `<p class="hc-move">${describeMove(points, opts)}</p>${renderChart(points, opts)}`;
	};
	// only the default range (3M) is free; other ranges and dates are Pro. The preview is the default chart, blurred
	const open = rangeGate(PLANS.anon, range.key, DEFAULT_RANGE) === null;
	const plan = open ? null : await viewerPlan(cookies);
	const gate = plan ? rangeGate(plan, range.key, DEFAULT_RANGE) : null;
	const html = gate ? gateHtml(gate, plan!, await chart(rangeOf(DEFAULT_RANGE)), url.searchParams.get("from") || "/") : await chart(range);
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": open ? "public, max-age=300" : "private, no-store" } });
};
