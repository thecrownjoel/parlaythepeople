import type { APIRoute } from "astro";
import { getCycle, consensus, candidate, officeTitle, RATING_LABEL } from "../../../lib/markets";
import { racesAt } from "../../../lib/trends";
import { moneySince } from "../../../lib/money";
import { parlayD } from "../../../lib/model";

/** A few races by id (?ids=2026-senate-maine,2026-house-tx-15): odds, Parlay estimate, 24h change and money. For "Your races". */
export const GET: APIRoute = async ({ url }) => {
	const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => /^\d{4}-[a-z0-9-]{3,60}$/.test(s)).slice(0, 24);
	if (!ids.length) return Response.json({ races: [] });
	const now = Math.floor(Date.now() / 1000);
	const [ago, money] = await Promise.all([racesAt(now - 86400), moneySince(now - 86400)]);
	const years = [...new Set(ids.map((i) => Number(i.slice(0, 4))))];
	const cycles = await Promise.all(years.map((y) => getCycle(y)));
	const out = [];
	for (const id of ids) {
		const r = cycles.find((c) => c?.meta.cycle === Number(id.slice(0, 4)))?.races.find((x) => x.id === id);
		if (!r) continue;
		const c = consensus(r);
		const then = ago.get(id)?.D;
		out.push({
			id, name: officeTitle(r), path: r.path, D: c.D, R: c.R, rating: RATING_LABEL[c.rating],
			dName: candidate(r, "D"), rName: candidate(r, "R"),
			parlayD: r.kind !== "control" ? parlayD(c.D, c.R) : null,
			change24h: then != null ? c.D - then : null, usd24h: money.get(id)?.usd ?? 0,
		});
	}
	return Response.json({ races: out }, { headers: { "cache-control": "public, max-age=120" } });
};
