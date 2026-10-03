import type { APIRoute } from "astro";
import { rangeOf, validSpecs, getSpecSeries, renderMulti } from "../../../lib/chart";

/** A multi-line history chart as an HTML fragment (used by the range buttons on MultiChart). */
export const GET: APIRoute = async ({ url }) => {
	let specs;
	try { specs = validSpecs(JSON.parse(url.searchParams.get("s") ?? "")); } catch { specs = null; }
	if (!specs) return new Response("Bad chart request.", { status: 400 });
	const range = rangeOf(url.searchParams.get("range"));
	const ed = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("ed") ?? "") ? url.searchParams.get("ed")! : undefined;
	const title = (url.searchParams.get("t") ?? "Odds over time").slice(0, 80);
	const series = await Promise.all(specs.map(async (spec) => ({ spec, points: await getSpecSeries(spec, range) })));
	return new Response(renderMulti(series, { range, electionDay: ed, title }), {
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
	});
};
