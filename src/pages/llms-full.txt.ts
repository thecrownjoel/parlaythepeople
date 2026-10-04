import { parlayD } from "../lib/model";
import type { APIRoute } from "astro";
import { getIndex, getCycle, consensus, shares, candidate, pct, fmtDate, fmtVol, RATING_LABEL } from "../lib/markets";
import { SITE_NAME } from "../lib/site";
import { pollBoard, marginText } from "../lib/polls";
import { getPolitics, money, TOPIC_SLUG } from "../lib/politics";

/** Every race with its current odds, one line each, for AI assistants and researchers. */
export const GET: APIRoute = async ({ url }) => {
	const o = url.origin;
	const index = await getIndex();
	const out = [`# ${SITE_NAME}: every tracked race, poll average and politics market`, ""];
	const polls = await pollBoard();
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		out.push(`## ${cy.year} (updated ${fmtDate(data.meta.generated)}; Election Day ${cy.election_day})`, "");
		for (const r of data.races) {
			const c = consensus(r), k = shares(r.k), p = shares(r.p);
			const names = [candidate(r, "D") && `D: ${candidate(r, "D")}`, candidate(r, "R") && `R: ${candidate(r, "R")}`].filter(Boolean).join(", ");
			const est = r.kind !== "control" ? parlayD(c.D, c.R) : null;
			out.push(`- ${r.label}${names ? ` (${names})` : ""}: ${RATING_LABEL[c.rating]}; Dem ${pct(c.D)}, Rep ${pct(c.R)}; Kalshi D ${pct(k?.D)}, Polymarket D ${pct(p?.D)}${est != null ? `; Parlay estimate D ${pct(est)}` : ""}; ${fmtVol((r.k?.v ?? 0) + (r.p?.v ?? 0))} traded${polls.averages.get(r.id) ? `; polls ${marginText(polls.averages.get(r.id)!)} (${polls.averages.get(r.id)!.used} polls)` : ""}. ${o}${r.path}`);
		}
		if (data.pres.party || data.pres.winner) out.push(`- President: see ${o}/${cy.year}/president/`);
		out.push("");
	}
	// every other politics market, by topic
	const board = await getPolitics();
	if (board) {
		out.push(`# Other politics markets (${board.totals.events}, updated ${fmtDate(board.generated)})`, "", `Every Kalshi and Polymarket politics market not tied to a race above. Page: ${o}/politics/`, "");
		for (const t of board.topics) {
			out.push(`## ${t.name} (${o}/politics/${TOPIC_SLUG[t.key] ?? t.key}/)`, "");
			for (const e of board.events.filter((x) => x.topic === t.key).slice(0, 40)) {
				const odds = e.o.slice(0, 3).map((x) => `${e.multi ? x.n : "Yes"} ${Math.round(x.p * 100)}%`).join(", ");
				out.push(`- ${e.title}: ${odds} (${e.src === "k" ? "Kalshi" : "Polymarket"}; ${money(e.vol24)} today, ${money(e.vol)} total). ${e.url}`);
			}
			out.push("");
		}
	}
	return new Response(out.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=600" } });
};
