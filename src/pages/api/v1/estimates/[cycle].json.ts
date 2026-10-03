import type { APIRoute } from "astro";
import { getCycle, consensus } from "../../../../lib/markets";
import { parlayD, MODEL } from "../../../../lib/model";

/** The Parlay estimate for every race in a cycle, beside the market's two-party Democratic odds. */
export const GET: APIRoute = async ({ params }) => {
	const data = /^\d{4}$/.test(params.cycle ?? "") ? await getCycle(Number(params.cycle)) : null;
	if (!data) return Response.json({ error: "Unknown cycle" }, { status: 404 });
	const races = data.races.filter((r) => r.kind !== "control").map((r) => {
		const c = consensus(r);
		const e = parlayD(c.D, c.R);
		return { race_id: r.id, label: r.label, url: `https://parlaythepeople.com${r.path}`, market_D: Math.round((c.D / (c.D + c.R || 1)) * 1000) / 1000, parlay_D: e == null ? null : Math.round(e * 1000) / 1000 };
	});
	return Response.json({
		cycle: data.meta.cycle, generated: data.meta.generated,
		model: { trained_on: MODEL.trained_on, blend: MODEL.blend, held_out: MODEL.cv, about: "https://parlaythepeople.com/model/" },
		races,
	}, { headers: { "cache-control": "public, max-age=600", "access-control-allow-origin": "*" } });
};
