import type { APIRoute } from "astro";
import { viewerPlan } from "../../../lib/auth";
import { gateHtml } from "../../../lib/gate";
import { getPresident, getHouseSeats, getStateHistory, nationTiles, seatsBar, countyMap, houseTable, duelBar, LATEST_PRES, LATEST_HOUSE, PRES_YEARS, COUNTY_YEARS } from "../../../lib/history";
import { STATES } from "../../../lib/states";

/**
 * Past elections as HTML fragments for the year buttons on /voting/:
 *   ?view=nation&year=Y           every state's presidential margin, the popular vote and House seats
 *   ?view=state&st=ME&year=Y      a state's presidential result and county map, and its House races
 * The latest election is free; earlier years are Pro (Pro gating rules), with the latest year blurred behind the card.
 */
export const GET: APIRoute = async ({ url, cookies, request }) => {
	const view = url.searchParams.get("view"), year = Number(url.searchParams.get("year"));
	const st = (url.searchParams.get("st") ?? "").toUpperCase();
	if (!PRES_YEARS.includes(year) || (view === "state" && !STATES[st])) return new Response("Unknown year or state.", { status: 400 });
	const latest = year === LATEST_PRES;
	const render = async (y: number) => {
		if (view === "nation") {
			const [pres, seats] = await Promise.all([getPresident(), getHouseSeats()]);
			return pres ? nationTiles(pres, y) + (seats ? seatsBar(seats, y) : "") : "";
		}
		const [pres, h] = await Promise.all([getPresident(), getStateHistory(st)]);
		const v = pres?.states[st]?.[y];
		return (v ? duelBar(v, `${y} presidential vote in ${STATES[st]}`) : "")
			+ (h && COUNTY_YEARS.includes(y) ? countyMap(st, h, { year: y }) : `<p class="fx-note">County results start in 2000.</p>`)
			+ (h ? `<h3 class="vx-h3">The House in ${y}</h3>${houseTable(st, h, y)}` : "");
	};
	const plan = latest ? null : await viewerPlan(cookies, request);
	const html = latest || plan!.history === "all" ? await render(year) : gateHtml("time", plan!, await render(LATEST_PRES), url.searchParams.get("from") || "/voting/");
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": latest ? "public, max-age=3600" : "private, no-store" } });
};
