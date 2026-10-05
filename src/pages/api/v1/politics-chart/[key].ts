import type { APIRoute } from "astro";
import { getPolitics, findMarket, marketSeries, marketChart } from "../../../../lib/politics";
import { rangeOf, DEFAULT_RANGE } from "../../../../lib/chart";
import { viewerPlan } from "../../../../lib/auth";
import { rangeGate, gateHtml } from "../../../../lib/gate";
import { PLANS } from "../../../../lib/plans";

/** A politics market's chart for one range, as an HTML fragment (the range buttons on /politics/market/…). */
export const GET: APIRoute = async ({ params, url, cookies }) => {
	const e = findMarket(await getPolitics(), params.key ?? "");
	if (!e) return new Response("Unknown market.", { status: 404 });
	const range = rangeOf(url.searchParams.get("range"));
	const chart = async (r: typeof range) => marketChart(e.o[0].n, e.multi, await marketSeries(e, r.secs), r);
	// 24 hours is free; longer ranges are Pro, with the 24-hour chart blurred behind the card
	const open = rangeGate(PLANS.anon, range.key, DEFAULT_RANGE) === null;
	const plan = open ? null : await viewerPlan(cookies);
	const gate = plan ? rangeGate(plan, range.key, DEFAULT_RANGE) : null;
	const html = gate ? gateHtml(gate, plan!, await chart(rangeOf(DEFAULT_RANGE)), url.searchParams.get("from") || "/politics/") : await chart(range);
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": open ? "public, max-age=300" : "private, no-store" } });
};

