import type { APIRoute } from "astro";
import { getIndex, getCycle, consensus, pct, fmtDate, PARTY_PLURAL } from "../lib/markets";
import { SITE_NAME, SITE_DESCRIPTION } from "../lib/site";
import { TOPIC_SLUG } from "../lib/politics";

/** llms.txt: a plain-text map of the site for AI assistants, with the current headline numbers. */
export const GET: APIRoute = async ({ url }) => {
	const o = url.origin;
	const index = await getIndex();
	const lines = [`# ${SITE_NAME}`, "", `> ${SITE_DESCRIPTION}`, ""];
	if (index) {
		const next = await getCycle(index.next);
		if (next) {
			lines.push(`## Current headline odds (${fmtDate(next.meta.generated)})`, "");
			for (const r of next.races.filter((x) => x.kind === "control")) {
				const c = consensus(r);
				lines.push(`- ${next.meta.cycle} ${r.label}: ${PARTY_PLURAL[c.lead as "D" | "R"]} ${pct(c.lp)} (average of Kalshi and Polymarket): ${o}${r.path}`);
			}
			lines.push("");
		}
		lines.push("## Elections", "");
		for (const c of index.cycles) lines.push(`- [${c.year} elections](${o}/${c.year}/): ${c.races} races; offices: ${c.offices.join(", ")}`);
		lines.push("");
	}
	lines.push(
		"## Key pages", "",
		`- [Methodology](${o}/methodology/): how prices become probabilities, ratings, update schedule`,
		`- [The Parlay estimate](${o}/model/): our own probability per race (market odds adjusted by a model trained on decided races), how it was tested, and where it differs from the markets`,
		`- [Guide](${o}/guide/): every feature explained, including date selectors and The Pulse (LunarCrush social data)`,
		`- [Data & API](${o}/data/): free JSON and CSV feeds`,
		`- [Analysis](${o}/posts): articles about the markets`,
		`- [Politics markets](${o}/politics/): every other politics market on Kalshi and Polymarket, by topic: ${Object.values(TOPIC_SLUG).map((s) => `${o}/politics/${s}/`).join(", ")}`,
		`- [Money](${o}/finance/): ${new Date().getUTCFullYear()} campaign finance from the FEC: totals, party committees, outside spending by week, the most expensive races, top spenders and fundraisers; one money page per House and Senate race (${o}/finance/race/2026-senate-maine/)`,
		`- [Voting](${o}/voting/): how to vote in each state (official election offices) and past results: presidential margins by state 1976-2024, county maps, House and Senate results (MIT Election Data and Science Lab, OpenElections); one page per state (${o}/voting/maine/)`,
		`- [Candidates](${o}/candidates/), [States](${o}/states/), [Track record](${o}/track-record/), [Calendar](${o}/calendar/), [Election night](${o}/results/2026/)`,
		`- Polls: every race page lists the public polls and our polling average next to the market odds`,
		`- [Full race list as text](${o}/llms-full.txt): every race, its poll average and every politics market`, "",
		"## Data feeds", "",
		`- ${o}/api/v1/index.json: cycles and links`,
		`- ${o}/api/v1/{year}.json: every race in a cycle with each exchange's prices`,
		`- ${o}/api/v1/{year}/races.csv: one row per race`,
		`- ${o}/api/v1/history/{race_id}.json: price history, last 90 days (race ids like 2026-senate-maine)`,
		`- ${o}/api/v1/politics.json: every other politics market on Kalshi and Polymarket (cabinet, courts, world leaders, mayors…), by topic; page: ${o}/politics/`, "",
		"## How to cite", "",
		`Cite "${SITE_NAME}" with a link to the race page. Probabilities are prediction-market prices from Kalshi and Polymarket, normalized to sum to 100%, refreshed every 10 minutes. They are crowd forecasts, not certainties.`, "",
	);
	return new Response(lines.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=600" } });
};
