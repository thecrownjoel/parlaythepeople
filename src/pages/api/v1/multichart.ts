import type { APIRoute } from "astro";
import { rangeOf, validSpecs, getSpecSeries, renderMulti } from "../../../lib/chart";
import { viewerPlan } from "../../../lib/auth";
import { rangeGate, gateHtml } from "../../../lib/gate";
import { PLANS } from "../../../lib/plans";

/** A multi-line history chart as an HTML fragment (used by the range buttons on MultiChart). */
export const GET: APIRoute = async ({ url, cookies }) => {
	let specs;
	try { specs = validSpecs(JSON.parse(url.searchParams.get("s") ?? "")); } catch { specs = null; }
	if (!specs) return new Response("Bad chart request.", { status: 400 });
	const range = rangeOf(url.searchParams.get("range"));
	const ed = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("ed") ?? "") ? url.searchParams.get("ed")! : undefined;
	const title = (url.searchParams.get("t") ?? "Odds over time").slice(0, 80);
	const draw = async (r: typeof range) => renderMulti(await Promise.all(specs.map(async (spec) => ({ spec, points: await getSpecSeries(spec, r) }))), { range: r, electionDay: ed, title });
	const open = rangeGate(PLANS.anon, range.key) === null;
	const plan = open ? null : await viewerPlan(cookies);
	const gate = plan ? rangeGate(plan, range.key) : null;
	const html = gate ? gateHtml(gate, plan!, await draw(rangeOf("3m")), url.searchParams.get("from") || "/") : await draw(range);
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": open ? "public, max-age=300" : "private, no-store" } });
};
