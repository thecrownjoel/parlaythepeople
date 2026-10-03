import type { APIRoute } from "astro";
import { getCycle, consensus, shares, RATING_LABEL, candidate } from "../../../../lib/markets";

const q = (v: unknown) => {
	const s = v == null ? "" : String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per race: consensus and per-exchange odds. */
export const GET: APIRoute = async ({ params, url }) => {
	if (!/^\d{4}$/.test(params.cycle ?? "")) return new Response("Use a four-digit year.", { status: 400 });
	const data = await getCycle(Number(params.cycle));
	if (!data) return new Response(`No data for ${params.cycle}.`, { status: 404 });
	const head = ["race_id", "cycle", "office", "state", "district", "label", "dem_candidate", "rep_candidate", "dem_prob", "rep_prob",
		"rating", "kalshi_dem", "kalshi_rep", "polymarket_dem", "polymarket_rep", "updated", "page"];
	const lines = [head.join(",")];
	for (const r of data.races) {
		const c = consensus(r), k = shares(r.k), p = shares(r.p);
		lines.push([r.id, r.cycle, r.kind, r.state, r.dist, r.label, candidate(r, "D"), candidate(r, "R"),
			c.D.toFixed(4), c.R.toFixed(4), RATING_LABEL[c.rating], k?.D.toFixed(4), k?.R.toFixed(4), p?.D.toFixed(4), p?.R.toFixed(4),
			data.meta.generated, `${url.origin}${r.path}`].map(q).join(","));
	}
	return new Response(lines.join("\n") + "\n", {
		headers: {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `inline; filename="ballottape-${params.cycle}-races.csv"`,
			"cache-control": "public, max-age=60",
			"access-control-allow-origin": "*",
		},
	});
};
