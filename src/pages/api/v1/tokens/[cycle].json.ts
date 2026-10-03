import type { APIRoute } from "astro";
import { getCycle } from "../../../../lib/markets";

/**
 * Polymarket contract -> race lookup for the live trade feed on the globe.
 * races:  [state, label, path]
 * tokens: tokenId -> [raceIndex, party, name, isYes]  (both the Yes and the No token of each market)
 * seed:   condition ids of the most-traded markets, used to load recent trades when the page opens
 */
export const GET: APIRoute = async ({ params }) => {
	if (!/^\d{4}$/.test(params.cycle ?? "")) return Response.json({ error: "Use a four-digit year." }, { status: 400 });
	const data = await getCycle(Number(params.cycle));
	if (!data) return Response.json({ error: "No data." }, { status: 404 });
	const races: [string, string, string][] = [];
	const tokens: Record<string, [number, string, string, number]> = {};
	const byVol: { cid: string; v: number }[] = [];
	for (const r of data.races) {
		if (!r.p || r.kind === "control") continue;
		const i = races.push([r.state, r.kind === "house" ? `${r.label} House` : r.label, r.path]) - 1;
		for (const o of r.p.o as any[]) {
			if (o.tok) tokens[o.tok] = [i, o.pa ?? "O", o.n, 1];
			if (o.tokn) tokens[o.tokn] = [i, o.pa ?? "O", o.n, 0];
			if (o.cid) byVol.push({ cid: o.cid, v: o.v ?? 0 });
		}
	}
	const seed = byVol.sort((a, b) => b.v - a.v).slice(0, 120).map((x) => x.cid);
	return Response.json({ races, tokens, seed }, { headers: { "cache-control": "public, max-age=600" } });
};
