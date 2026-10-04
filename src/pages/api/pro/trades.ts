import type { APIRoute } from "astro";
import { viewerPlan } from "../../../lib/auth";
import { biggestTrades, raceBigTrades } from "../../../lib/money";
import { homeData } from "../../../lib/home";
import { FREE_TRADES, homeTradeRow, raceTradeRow } from "../../../lib/tradeRows";

/**
 * The big trades past the free top 3, as HTML rows, for Pro readers: ?race=<race id> (race page) or ?since=<unix
 * seconds> (homepage "Where the money went"). Anyone else gets 403 and keeps seeing the gate.
 */
export const GET: APIRoute = async ({ url, cookies }) => {
	const plan = await viewerPlan(cookies);
	const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" };
	if (!plan.archive) return new Response("", { status: 403, headers });
	const race = url.searchParams.get("race");
	if (race) {
		if (!/^\d{4}-[a-z0-9-]{3,60}$/.test(race)) return new Response("", { status: 400, headers });
		return new Response((await raceBigTrades(race, 20)).slice(FREE_TRADES).map(raceTradeRow).join(""), { headers });
	}
	const since = Number(url.searchParams.get("since"));
	if (!Number.isFinite(since) || since <= 0) return new Response("", { status: 400, headers });
	const d = await homeData();
	const byId = new Map(d.races.map((r) => [r.id, r]));
	return new Response((await biggestTrades(since, 15)).slice(FREE_TRADES).map((t) => homeTradeRow(t, byId)).join(""), { headers });
};
