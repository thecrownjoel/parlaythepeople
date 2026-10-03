import { parlayD } from "../lib/model";
import type { APIRoute } from "astro";
import { getIndex, getCycle, consensus, shares, candidate, pct, fmtDate, fmtVol, RATING_LABEL } from "../lib/markets";
import { SITE_NAME } from "../lib/site";

/** Every race with its current odds, one line each, for AI assistants and researchers. */
export const GET: APIRoute = async ({ url }) => {
	const o = url.origin;
	const index = await getIndex();
	const out = [`# ${SITE_NAME}: every tracked race`, ""];
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		out.push(`## ${cy.year} (updated ${fmtDate(data.meta.generated)}; Election Day ${cy.election_day})`, "");
		for (const r of data.races) {
			const c = consensus(r), k = shares(r.k), p = shares(r.p);
			const names = [candidate(r, "D") && `D: ${candidate(r, "D")}`, candidate(r, "R") && `R: ${candidate(r, "R")}`].filter(Boolean).join(", ");
			const est = r.kind !== "control" ? parlayD(c.D, c.R) : null;
			out.push(`- ${r.label}${names ? ` (${names})` : ""}: ${RATING_LABEL[c.rating]}; Dem ${pct(c.D)}, Rep ${pct(c.R)}; Kalshi D ${pct(k?.D)}, Polymarket D ${pct(p?.D)}${est != null ? `; Parlay estimate D ${pct(est)}` : ""}; ${fmtVol((r.k?.v ?? 0) + (r.p?.v ?? 0))} traded. ${o}${r.path}`);
		}
		if (data.pres.party || data.pres.winner) out.push(`- President: see ${o}/${cy.year}/president/`);
		out.push("");
	}
	return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=600" } });
};
