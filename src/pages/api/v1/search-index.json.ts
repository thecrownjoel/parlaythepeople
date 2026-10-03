import type { APIRoute } from "astro";
import { getIndex, getCycle, consensus, candidate, pct } from "../../../lib/markets";

/** Compact list of every race page for the site search overlay: title, subtitle, path, search text. */
export const GET: APIRoute = async () => {
	const index = await getIndex();
	const items: { t: string; s: string; p: string; k: string; y: number }[] = [];
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		const office = { senate: "Senate", governor: "Governor", house: "House", control: "Control" } as const;
		for (const r of data.races) {
			const c = consensus(r);
			const d = candidate(r, "D"), rep = candidate(r, "R");
			const t = r.kind === "control" ? `${r.label} ${r.cycle}` : r.kind === "house" ? `${r.label} House ${r.cycle}` : `${r.state} ${office[r.kind]} ${r.cycle}`;
			const s = [d && rep ? `${d} vs. ${rep}` : d || rep, `${c.lead} ${pct(c.lp)}`].filter(Boolean).join(" · ");
			items.push({ t, s, p: r.path, y: r.cycle, k: [t, r.state, r.st, r.label, d, rep, office[r.kind]].filter(Boolean).join(" ").toLowerCase() });
		}
		if (data.pres.party || data.pres.winner) {
			const names = [data.pres.winner, data.pres.nomD, data.pres.nomR].flatMap((m) => [...(m?.k?.o ?? []), ...(m?.p?.o ?? [])].slice(0, 40).map((o) => o.n));
			items.push({ t: `${cy.year} Presidential election`, s: "Winner, party and both nominations", p: `/${cy.year}/president/`, y: cy.year,
				k: `${cy.year} president presidential election nominee white house ${[...new Set(names)].join(" ")}`.toLowerCase() });
		}
	}
	return Response.json(items, { headers: { "cache-control": "public, max-age=600" } });
};
