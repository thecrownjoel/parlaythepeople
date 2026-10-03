import type { APIRoute } from "astro";
import { getIndex, getCycle, consensus, candidate, pct } from "../../../lib/markets";
import { getSocial, pulseIndex, compact } from "../../../lib/social";

/** Compact list of every race page for the site search overlay: title, subtitle, path, search text. */
export const GET: APIRoute = async () => {
	const [index, social] = await Promise.all([getIndex(), getSocial()]);
	const find = pulseIndex(social);
	const items: { t: string; s: string; p: string; k: string; y: number; soc?: number; c?: 1 }[] = [];
	const seenCand = new Set<string>();
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		const office = { senate: "Senate", governor: "Governor", house: "House", control: "Control" } as const;
		for (const r of data.races) {
			const c = consensus(r);
			const d = candidate(r, "D"), rep = candidate(r, "R");
			const t = r.kind === "control" ? `${r.label} ${r.cycle}` : r.kind === "house" ? `${r.label} House ${r.cycle}` : `${r.state} ${office[r.kind]} ${r.cycle}`;
			const s = [d && rep ? `${d} vs. ${rep}` : d || rep, `${c.lead} ${pct(c.lp)}`].filter(Boolean).join(" · ");
			const here = (x: ReturnType<typeof find>) => (x && x.races.includes(r.path) ? x : null);
			const pd = here(find(d)), pr = here(find(rep));
			const buzz = pd && pr ? ` · buzz ${compact(pd.i24)} vs. ${compact(pr.i24)}` : "";
			items.push({ t, s: s + buzz, p: r.path, y: r.cycle, k: [t, r.state, r.st, r.label, d, rep, office[r.kind]].filter(Boolean).join(" ").toLowerCase() });
			// each tracked candidate is searchable by name, with their social pulse
			for (const [name, pulse, party] of [[d, pd, "D"], [rep, pr, "R"]] as const) {
				if (!name || !pulse || seenCand.has(`${name}|${r.path}`)) continue;
				seenCand.add(`${name}|${r.path}`);
				const odds = party === "D" ? c.D : c.R;
				items.push({ t: `${name} (${party})`, c: 1, soc: pulse.i24, p: r.path, y: r.cycle,
					s: `${t} · ${pct(odds)} to win · ${compact(pulse.i24)} social interactions today${pulse.sentiment != null ? `, ${Math.round(pulse.sentiment)}% positive` : ""}`,
					k: `${name} ${t} ${r.state} candidate`.toLowerCase() });
			}
		}
		if (data.pres.party || data.pres.winner) {
			const names = [data.pres.winner, data.pres.nomD, data.pres.nomR].flatMap((m) => [...(m?.k?.o ?? []), ...(m?.p?.o ?? [])].slice(0, 40).map((o) => o.n));
			items.push({ t: `${cy.year} Presidential election`, s: "Winner, party and both nominations", p: `/${cy.year}/president/`, y: cy.year,
				k: `${cy.year} president presidential election nominee white house ${[...new Set(names)].join(" ")}`.toLowerCase() });
		}
	}
	return Response.json(items, { headers: { "cache-control": "public, max-age=600" } });
};
