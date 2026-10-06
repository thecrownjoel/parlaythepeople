/**
 * Tools the AI analyst calls for exact, current numbers (Anthropic tool-use format), plus one that
 * searches the research documents through Cloudflare AI Search. Every tool is read-only.
 */
import { env } from "cloudflare:workers";
import { raceFinance, fecName, fecUrl } from "./fec";
import { getIndex, getCycle, consensus, shares, candidate, officeTitle, RATING_LABEL, type Race, type CycleData } from "./markets";
import { racesAt, moversSince, leadChangesSince } from "./trends";
import { moneySince, biggestTrades, raceMoneyByDay } from "./money";
import { getSocial, pulseIndex, type Pulse } from "./social";
import { parlayD, MODEL } from "./model";
import { getSeries, RANGES } from "./chart";
import { merged } from "./home";
import { nameKey } from "./names";
import { aiRun } from "./ai";
import { findAnalogs } from "./analogs";
import { pollsFor, average, marginText, pollAverage } from "./polls";
import { ratingsFor, expertScore, marketScore, scoreWord, FORECASTERS, FORECASTER_KEYS } from "./ratings";

const DAY = 86400;
const r3 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 1000) / 1000);
const usd = (x: number | null | undefined) => (x == null ? null : Math.round(x));

async function allRaces(): Promise<{ data: CycleData; r: Race }[]> {
	const index = await getIndex();
	const out: { data: CycleData; r: Race }[] = [];
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		for (const r of data?.races ?? []) out.push({ data: data!, r });
	}
	return out;
}

function summary(r: Race) {
	const c = consensus(r);
	const est = r.kind !== "control" ? parlayD(c.D, c.R) : null;
	return {
		race_id: r.id, name: officeTitle(r), cycle: r.cycle, url: `https://parlaythepeople.com${r.path}`,
		democrat: candidate(r, "D"), republican: candidate(r, "R"),
		odds: { D: r3(c.D), R: r3(c.R), other: r3(c.O) }, rating: RATING_LABEL[c.rating],
		parlay_estimate_D: r3(est), traded_usd_to_date: usd((r.k?.v ?? 0) + (r.p?.v ?? 0)),
	};
}

export const TOOLS = [
	{
		name: "find_races",
		description: "Find races by state, district (e.g. 'AZ-06'), office or candidate name. Returns matching races with current odds, the Parlay estimate and money traded. Use this first to get a race_id.",
		input_schema: { type: "object", properties: { query: { type: "string", description: "e.g. 'Maine Senate', 'TX-15', 'Susan Collins', 'Georgia governor'" }, limit: { type: "integer", default: 8 } }, required: ["query"] },
	},
	{
		name: "race_detail",
		description: "Everything current about one race: candidates, odds on Kalshi and Polymarket, share prices (bid/ask/last), rating, Parlay estimate, odds moves over 1/7/30 days, money traded in the last 24h/7d/30d, and the candidates' social pulse.",
		input_schema: { type: "object", properties: { race_id: { type: "string" } }, required: ["race_id"] },
	},
	{
		name: "odds_history",
		description: "Democratic odds over time for a race on each exchange. days: 1, 7, 30, 90, 365 or 0 for all history (back to Nov 2024; beyond 90 days is Pro only).",
		input_schema: { type: "object", properties: { race_id: { type: "string" }, days: { type: "integer", default: 30 } }, required: ["race_id"] },
	},
	{
		name: "money",
		description: "Dollars traded over the last N days (trade records begin Sep 30, 2026): totals, the races drawing the most money, and the biggest single trades. Optionally for one race, with a per-day breakdown.",
		input_schema: { type: "object", properties: { days: { type: "number", default: 1 }, race_id: { type: "string" } } },
	},
	{
		name: "movers",
		description: "Races whose Democratic odds moved most over the last N days, and races where the favorite flipped.",
		input_schema: { type: "object", properties: { days: { type: "integer", default: 7 }, cycle: { type: "integer" } } },
	},
	{
		name: "presidential",
		description: "Presidential markets for a cycle (default 2028): which party wins, who wins, and both nominations, with each candidate's odds and money traded.",
		input_schema: { type: "object", properties: { cycle: { type: "integer", default: 2028 } } },
	},
	{
		name: "social_pulse",
		description: "LunarCrush social data for a candidate: 24h interactions, people posting, sentiment (% positive), week-over-week change, 30 days of daily interactions and sentiment, and top posts. Posts are what people are saying, not verified facts.",
		input_schema: { type: "object", properties: { candidate: { type: "string" } }, required: ["candidate"] },
	},
	{
		name: "polls",
		description: "Public polls of a race's general election (from Wikipedia's lists, each citing the pollster's release) and the Parlay polling average: each pollster's latest poll from the last 30 days, weighted by recency and sample, partisan polls halved. Compare with market odds: a 3-point poll lead is not a 60% chance.",
		input_schema: { type: "object", properties: { race_id: { type: "string" }, limit: { type: "integer", default: 12 } }, required: ["race_id"] },
	},
	{
		name: "campaign_finance",
		description: "FEC campaign finance for a House or Senate race: each candidate's money raised, spent, cash on hand and debts through their latest report, where it came from (individuals, PACs, party, self-funding), and outside spending for or against them with the biggest outside spenders. Updated daily. Governors report to their states, so governor races have no FEC data.",
		input_schema: { type: "object", properties: { race_id: { type: "string" } }, required: ["race_id"] },
	},
	{
		name: "expert_ratings",
		description: "Expert race ratings from The Cook Political Report, Sabato's Crystal Ball and Inside Elections (Safe/Likely/Lean/Tilt/Toss-up, as cited on Wikipedia with each forecaster's date), the previous rating if it changed, and the market odds on the same scale for comparison.",
		input_schema: { type: "object", properties: { race_id: { type: "string" } }, required: ["race_id"] },
	},
	{
		name: "search_research",
		description: "Search Parlay the People's research library: race dossiers, every headline the site has carried, the Analysis desk's articles, and notes on methodology and the model. Use for context, news and explanations; use the other tools for exact current numbers.",
		input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	},
] as const;

/** Pro-only tools: who is moving the markets, and where the two exchanges disagree. */
export const PRO_TOOLS = [
	{
		name: "trade_flow",
		description: "Pro. Who is buying which side of one race over the last N days: per candidate, dollars betting FOR them vs AGAINST them on each exchange, the net, trade counts by size (under $100, $100-1k, $1k-10k, $10k+), and the largest Polymarket wallets in the race with their net direction. Trade records begin Sep 30, 2026.",
		input_schema: { type: "object", properties: { race_id: { type: "string" }, days: { type: "number", default: 7 } }, required: ["race_id"] },
	},
	{
		name: "whale_watch",
		description: "Pro. The biggest bets across all races over the last N days (default trades of $5,000+), and Polymarket wallets that put the most money into election markets, with how many races each touched and which side they took. Wallets are public on-chain pseudonyms, not identities.",
		input_schema: { type: "object", properties: { days: { type: "number", default: 7 }, min_usd: { type: "number", default: 5000 } } },
	},
	{
		name: "exchange_divergence",
		description: "Pro. Races where Kalshi and Polymarket disagree most right now on the Democratic chance, with each exchange's odds, the gap, and money traded on each. Large gaps can mean thin markets, different contract rules, or one exchange reacting first.",
		input_schema: { type: "object", properties: { cycle: { type: "integer" }, min_gap: { type: "number", default: 0.03 } } },
	},
	{
		name: "race_analogs",
		description: "Pro. Other races whose Democratic odds followed the closest path over the last 32 days, and what their odds did over the following 32 days: how many kept moving the same way, the median next move, and how often the favorite flipped. Use for 'is this move likely to continue?' questions. A base rate, not a forecast.",
		input_schema: { type: "object", properties: { race_id: { type: "string" } }, required: ["race_id"] },
	},
	{
		name: "deep_research",
		description: "Pro. A deeper search of the research library than search_research: more candidate passages, reranked for relevance to the exact question, with longer excerpts. Use for 'why' questions and background across many races or days.",
		input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	},
] as const;

/** Bullish for the named outcome: Kalshi taker bought Yes; on Polymarket bought the Yes token or sold the No token (the
 *  token is read from the price paid, usd / size, which matches either the Yes price or one minus it). */
const FOR_SQL = "CASE WHEN src = 'k' THEN side = 'yes' ELSE ((ABS(usd / size - yes_price) <= ABS(usd / size - (1 - yes_price))) = (side = 'BUY')) END";

export async function runTool(name: string, input: Record<string, any>, ctx: { pro?: boolean } = {}): Promise<unknown> {
	const now = Math.floor(Date.now() / 1000);
	if (PRO_TOOLS.some((t) => t.name === name) && !ctx.pro) return { error: "This tool is part of Parlay the People Pro." };
	switch (name) {
		case "trade_flow": {
			const days = Math.min(90, Math.max(0.25, Number(input.days ?? 7)));
			const since = now - Math.round(days * DAY);
			const race = String(input.race_id ?? "");
			const [flow, sizes, wallets] = await Promise.all([
				env.TRADES.prepare(`SELECT outcome, src, SUM(CASE WHEN ${FOR_SQL} THEN usd ELSE 0 END) AS for_usd, SUM(CASE WHEN ${FOR_SQL} THEN 0 ELSE usd END) AS against_usd, COUNT(*) AS n FROM trades WHERE race_id = ? AND ts >= ? AND size > 0 GROUP BY outcome, src`).bind(race, since).all<any>(),
				env.TRADES.prepare("SELECT SUM(usd < 100) AS small, SUM(usd >= 100 AND usd < 1000) AS mid, SUM(usd >= 1000 AND usd < 10000) AS large, SUM(usd >= 10000) AS whale, SUM(CASE WHEN usd >= 10000 THEN usd ELSE 0 END) AS whale_usd, SUM(usd) AS usd FROM trades WHERE race_id = ? AND ts >= ?").bind(race, since).first<any>(),
				env.TRADES.prepare(`SELECT wallet, outcome, SUM(usd) AS usd, SUM(CASE WHEN ${FOR_SQL} THEN usd ELSE -usd END) AS net, COUNT(*) AS n FROM trades WHERE race_id = ? AND ts >= ? AND src = 'p' AND wallet IS NOT NULL AND size > 0 GROUP BY wallet, outcome ORDER BY usd DESC LIMIT 10`).bind(race, since).all<any>(),
			]);
			const by = new Map<string, any>();
			for (const r of flow.results ?? []) {
				const x = by.get(r.outcome) ?? { candidate: r.outcome, for_usd: 0, against_usd: 0, trades: 0, kalshi_net: 0, polymarket_net: 0 };
				x.for_usd += r.for_usd ?? 0; x.against_usd += r.against_usd ?? 0; x.trades += r.n ?? 0;
				x[r.src === "k" ? "kalshi_net" : "polymarket_net"] += (r.for_usd ?? 0) - (r.against_usd ?? 0);
				by.set(r.outcome, x);
			}
			return {
				race_id: race, days,
				by_candidate: [...by.values()].map((x) => ({ ...x, for_usd: usd(x.for_usd), against_usd: usd(x.against_usd), net_usd: usd(x.for_usd - x.against_usd), kalshi_net: usd(x.kalshi_net), polymarket_net: usd(x.polymarket_net) })).sort((a, b) => (b.for_usd + b.against_usd) - (a.for_usd + a.against_usd)),
				trade_sizes: { under_100: sizes?.small ?? 0, "100_to_1k": sizes?.mid ?? 0, "1k_to_10k": sizes?.large ?? 0, "10k_plus": sizes?.whale ?? 0, share_of_dollars_in_10k_plus: sizes?.usd ? r3((sizes.whale_usd ?? 0) / sizes.usd) : null },
				top_polymarket_wallets: (wallets.results ?? []).map((w) => ({ wallet: `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}`, candidate: w.outcome, usd: usd(w.usd), net_for_candidate_usd: usd(w.net), trades: w.n })),
				note: "for = betting the candidate wins; against = betting they lose. Kalshi trades are anonymous; Polymarket wallets are public pseudonyms. Trade records begin Sep 30, 2026.",
			};
		}
		case "whale_watch": {
			const days = Math.min(90, Math.max(0.25, Number(input.days ?? 7)));
			const since = now - Math.round(days * DAY);
			const min = Math.max(500, Number(input.min_usd ?? 5000));
			const [big, wallets, races] = await Promise.all([
				env.TRADES.prepare(`SELECT race_id, src, outcome, side, yes_price, usd, ts, wallet, ${FOR_SQL} AS bull FROM trades WHERE ts >= ? AND usd >= ? AND size > 0 ORDER BY usd DESC LIMIT 25`).bind(since, min).all<any>(),
				env.TRADES.prepare("SELECT wallet, SUM(usd) AS usd, COUNT(*) AS n, COUNT(DISTINCT race_id) AS races, MAX(usd) AS biggest FROM trades WHERE ts >= ? AND src = 'p' AND wallet IS NOT NULL GROUP BY wallet ORDER BY usd DESC LIMIT 12").bind(since).all<any>(),
				allRaces(),
			]);
			const name = new Map(races.map(({ r }) => [r.id, officeTitle(r)]));
			const short = (w: string | null) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : null);
			return {
				days, min_usd: min,
				biggest_trades: (big.results ?? []).map((t) => ({ race: name.get(t.race_id) ?? t.race_id, race_id: t.race_id, exchange: t.src === "k" ? "Kalshi" : "Polymarket", candidate: t.outcome, direction: t.bull ? `for ${t.outcome}` : `against ${t.outcome}`, yes_price: t.yes_price, usd: usd(t.usd), when: new Date(t.ts * 1000).toISOString().slice(0, 16), wallet: short(t.wallet) })),
				top_polymarket_wallets: (wallets.results ?? []).map((w) => ({ wallet: short(w.wallet), usd: usd(w.usd), trades: w.n, races: w.races, biggest_trade_usd: usd(w.biggest) })),
				note: "Wallets are public Polymarket pseudonyms, not identities; never guess who is behind one. Trade records begin Sep 30, 2026.",
			};
		}
		case "exchange_divergence": {
			const index = await getIndex();
			const data = await getCycle(Number(input.cycle ?? index?.next));
			if (!data) return { error: "No such cycle" };
			const minGap = Math.max(0, Number(input.min_gap ?? 0.03));
			const rows = data.races.filter((r) => r.k && r.p && r.kind !== "control").map((r) => {
				const k = shares(r.k)!, p = shares(r.p)!;
				const kd = k.D / (k.D + k.R || 1), pd = p.D / (p.D + p.R || 1);
				return { ...summary(r), kalshi_D: r3(kd), polymarket_D: r3(pd), gap: r3(Math.abs(kd - pd)), richer_for_D: kd > pd ? "Kalshi" : "Polymarket", kalshi_traded_usd: usd(r.k?.v), polymarket_traded_usd: usd(r.p?.v) };
			}).filter((x) => (x.gap ?? 0) >= minGap).sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0)).slice(0, 15);
			return { cycle: data.meta.cycle, min_gap: minGap, races: rows, note: "Odds are each exchange's two-party Democratic share. Thin markets (little money traded) often show the widest gaps." };
		}
		case "campaign_finance": {
			const id = String(input.race_id ?? "");
			const m = /^(\d{4})-/.exec(id);
			const race = m ? (await getCycle(Number(m[1])))?.races.find((r) => r.id === id) : null;
			if (!race) return { error: `Unknown race_id ${id}. Use find_races first.` };
			const field = await raceFinance(race);
			if (field === null) return { race_id: id, note: "Governor candidates report to their states, not the FEC; there is no federal finance data for this race." };
			return {
				race_id: id, source: "FEC bulk filings, updated daily",
				candidates: field.filter((c) => c.receipts >= 10_000).slice(0, 8).map((c) => ({
					name: fecName(c.name), party: c.party, status: c.ici === "I" ? "incumbent" : c.ici === "O" ? "open seat" : "challenger",
					through: c.coverage_end, raised_usd: Math.round(c.receipts), spent_usd: Math.round(c.disbursements), cash_on_hand_usd: Math.round(c.cash), debts_usd: Math.round(c.debts),
					from_individuals_usd: Math.round(c.indiv), from_pacs_usd: Math.round(c.pac), from_party_usd: Math.round(c.party_contrib), self_funding_usd: Math.round(c.self_funding),
					outside_for_usd: Math.round(c.support ?? 0), outside_against_usd: Math.round(c.oppose ?? 0),
					top_outside_spenders: c.spenders.map((x) => ({ name: x.name, for_usd: x.support, against_usd: x.oppose })),
					fec_page: fecUrl(c.cand_id),
				})),
			};
		}
		case "polls": {
			const all = await pollsFor(String(input.race_id ?? ""));
			const avg = average(all);
			if (!avg) return { race_id: input.race_id, polls: [], note: "No general-election polls listed for this race yet." };
			const p3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 10);
			return {
				race_id: input.race_id, matchup: `${avg.d_name} (D) vs. ${avg.r_name} (R)`,
				average: { democrat_pct: p3(avg.d), republican_pct: p3(avg.r), margin: marginText(avg), polls_used: avg.used, newest_poll_ended: avg.latest },
				polls: avg.polls.slice(0, Math.min(25, Number(input.limit ?? 12))).map((p) => ({ pollster: p.pollster, fieldwork: `${p.start_date ?? ""} to ${p.end_date}`, sample: p.sample, population: p.pop, democrat_pct: p3(p.d), republican_pct: p3(p.r), undecided_pct: p3(p.undecided) })),
				source: `${avg.source} (Wikipedia, CC BY-SA 4.0)`,
				method: "Each pollster's latest poll ending within 30 days of the newest (or the 3 most recent within 90 days), weighted by recency (14-day half-life) and square root of sample (capped at 2,000); partisan-sponsored polls count half.",
			};
		}
		case "race_analogs": {
			const races = await allRaces();
			return findAnalogs(String(input.race_id ?? ""), new Map(races.map(({ r }) => [r.id, `${officeTitle(r)} ${r.cycle}`])));
		}
		case "deep_research": {
			const query = String(input.query ?? "");
			try {
				const res: any = await (env.AI as any).autorag("parlay").search({ query, max_num_results: 24, rewrite_query: true });
				const docs = (res?.data ?? []).map((d: any) => ({
					document: d.filename, url: d.attributes?.file?.url ?? d.attributes?.url ?? null, title: d.attributes?.file?.title ?? d.attributes?.title ?? null,
					text: (d.content ?? []).map((c: any) => c.text).join("\n").slice(0, 3000),
				}));
				if (!docs.length) return { results: [] };
				const ranked: any = await aiRun("@cf/baai/bge-reranker-base", { query, contexts: docs.map((d: any) => ({ text: d.text.slice(0, 1500) })), top_k: 10 }, { feature: "rerank" });
				const order: { id: number; score: number }[] = ranked?.response ?? [];
				return { results: (order.length ? order : docs.map((_: unknown, i: number) => ({ id: i, score: 0 }))).slice(0, 10).map((o: { id: number; score: number }) => ({ ...docs.at(o.id), relevance: r3(o.score) })) };
			} catch (e) {
				return { error: `Research search unavailable: ${String(e).slice(0, 120)}` };
			}
		}
		case "find_races": {
			const q = String(input.query ?? "").toLowerCase().trim();
			const words = q.split(/[\s,]+/).filter(Boolean);
			const dist = q.match(/\b([a-z]{2})[\s-]?0?(\d{1,2}|al)\b/);
			const scored = (await allRaces()).map(({ r }) => {
				const hay = [r.label, r.state, r.st, r.kind, officeTitle(r), candidate(r, "D"), candidate(r, "R"), String(r.cycle)].filter(Boolean).join(" ").toLowerCase();
				let s = words.reduce((a, w) => a + (hay.includes(w) ? 1 : 0), 0);
				if (dist && r.kind === "house" && r.st.toLowerCase() === dist[1] && (r.label.toLowerCase().endsWith(`-${dist[2].padStart(2, "0")}`) || r.label.toLowerCase().endsWith(`-${dist[2]}`))) s += 5;
				if (r.cycle === (new Date().getUTCFullYear())) s += 0.1;
				return { r, s };
			}).filter((x) => x.s >= Math.max(1, words.length * 0.6)).sort((a, b) => b.s - a.s).slice(0, Math.min(20, input.limit ?? 8));
			return { matches: scored.map(({ r }) => summary(r)) };
		}
		case "race_detail": {
			const hit = (await allRaces()).find(({ r }) => r.id === input.race_id);
			if (!hit) return { error: `No race with id ${input.race_id}. Use find_races.` };
			const { r, data } = hit;
			const [a1, a7, a30, m1, m7, m30, social] = await Promise.all([
				racesAt(now - DAY), racesAt(now - 7 * DAY), racesAt(now - 30 * DAY),
				moneySince(now - DAY), moneySince(now - 7 * DAY), moneySince(now - 30 * DAY), getSocial(),
			]);
			const c = consensus(r);
			const find = pulseIndex(social);
			const pulse = (n: string | null) => { const p = n ? find(n) : null; return p && p.races.includes(r.path) ? pulseBrief(p) : null; };
			const contract = (s: Race["k"] | Race["p"], x: "k" | "p") => (s?.o ?? []).map((o: any) => ({ exchange: x === "k" ? "Kalshi" : "Polymarket", name: o.n, party: o.pa, price: o.p, bid: o.q?.[0] ?? null, ask: o.q?.[1] ?? null, last: o.q?.[2] ?? null, volume: o.v ?? null, volume_24h: o.m?.v24 ?? null }));
			return {
				...summary(r), election_day: data.meta.election_day,
				kalshi: shares(r.k) && { D: r3(shares(r.k)!.D), R: r3(shares(r.k)!.R) }, polymarket: shares(r.p) && { D: r3(shares(r.p)!.D), R: r3(shares(r.p)!.R) },
				contracts: [...contract(r.k, "k"), ...contract(r.p, "p")],
				democratic_odds_change: { "1d": r3(a1.has(r.id) ? c.D - a1.get(r.id)!.D : null), "7d": r3(a7.has(r.id) ? c.D - a7.get(r.id)!.D : null), "30d": r3(a30.has(r.id) ? c.D - a30.get(r.id)!.D : null) },
				money_usd: { "24h": usd(m1.get(r.id)?.usd), "7d": usd(m7.get(r.id)?.usd), "30d": usd(m30.get(r.id)?.usd), note: "trade records begin Sep 30, 2026" },
				social: { democrat: pulse(candidate(r, "D")), republican: pulse(candidate(r, "R")) },
				poll_average: await pollAverage(r.id).then((a) => a && { margin: marginText(a), democrat_pct: Math.round(a.d * 1000) / 10, republican_pct: Math.round(a.r * 1000) / 10, polls_used: a.used, newest_poll_ended: a.latest }).catch(() => null),
				model_note: `Parlay estimate: market odds adjusted by a model trained on ${MODEL.trained_on} decided races; competitive races (favorite under 70%) keep the market's odds.`,
			};
		}
		case "odds_history": {
			// history beyond 90 days is part of Pro
			const days = ctx.pro ? Number(input.days ?? 30) : Math.min(90, Number(input.days ?? 30) || 90);
			const range = days === 0 ? RANGES.find((x) => x.key === "all")! : days <= 1 ? RANGES[0] : days <= 7 ? RANGES[1] : days <= 30 ? RANGES[2] : days <= 90 ? RANGES[3] : RANGES[4];
			const pts = await getSeries(String(input.race_id), range);
			const step = Math.max(1, Math.ceil(pts.length / (ctx.pro ? 400 : 60)));
			return { race_id: input.race_id, range: range.words, points: pts.filter((_, i) => i % step === 0 || i === pts.length - 1).map((p) => ({ t: new Date(p.ts * 1000).toISOString().slice(0, 16), kalshi_D: r3(p.k_d), polymarket_D: r3(p.p_d) })) };
		}
		case "money": {
			const days = Number(input.days ?? 1);
			const since = now - days * DAY;
			if (input.race_id) {
				const [m, byDay] = await Promise.all([moneySince(since), raceMoneyByDay(String(input.race_id), Math.min(60, Math.ceil(days)))]);
				const x = m.get(String(input.race_id));
				return { race_id: input.race_id, days, usd: usd(x?.usd), trades: x?.n ?? 0, kalshi_usd: usd(x?.k), polymarket_usd: usd(x?.p), by_day: byDay.map((d) => ({ day: new Date(d.day * DAY * 1000).toISOString().slice(0, 10), usd: usd(d.k + d.p), trades: d.n, biggest: usd(d.big) })), note: "trade records begin Sep 30, 2026" };
			}
			const [m, big, races] = await Promise.all([moneySince(since), biggestTrades(since, 10), allRaces()]);
			const name = new Map(races.map(({ r }) => [r.id, officeTitle(r)]));
			let tot = 0, n = 0;
			for (const x of m.values()) { tot += x.usd; n += x.n; }
			return {
				days, total_usd: usd(tot), trades: n,
				top_races: [...m].sort((a, b) => b[1].usd - a[1].usd).slice(0, 12).map(([id, x]) => ({ race_id: id, name: name.get(id) ?? id, usd: usd(x.usd), trades: x.n })),
				biggest_trades: big.map((t) => ({ race_id: t.race_id, name: name.get(t.race_id) ?? t.race_id, exchange: t.src === "k" ? "Kalshi" : "Polymarket", contract: t.outcome, side: t.side, yes_price: t.yes_price, usd: usd(t.usd), when: new Date(t.ts * 1000).toISOString().slice(0, 16) })),
				note: "trade records begin Sep 30, 2026",
			};
		}
		case "movers": {
			const days = Number(input.days ?? 7);
			const index = await getIndex();
			const data = await getCycle(Number(input.cycle ?? index?.next));
			if (!data) return { error: "No such cycle" };
			const [mv, flips] = await Promise.all([moversSince(data, now - days * DAY, 10), leadChangesSince(data, now - days * DAY, 8)]);
			return {
				days, cycle: data.meta.cycle,
				biggest_moves: mv.map((m) => ({ ...summary(m.race), D_from: r3(m.from), D_to: r3(m.to), change: r3(m.delta) })),
				lead_changes: flips.map((f) => ({ ...summary(f.race), now_leads: f.nowLeader, was_D: r3(f.from), now_D: r3(f.to) })),
			};
		}
		case "presidential": {
			const data = await getCycle(Number(input.cycle ?? 2028));
			const pres = data?.pres;
			if (!pres) return { error: "No presidential markets for that cycle" };
			const rows = (m: any) => merged(m, 15).map((x) => ({ name: x.n, party: x.pa, odds: r3(x.v), traded_usd: usd(x.vol) }));
			// the exchanges name the parties differently ("Democrats" / "Democratic party"): one row per party
			const parties = (m: any) => {
				const by = new Map<string, { party: string; odds: number[]; traded_usd: number }>();
				for (const x of ["k", "p"] as const) {
					const s_ = m?.[x];
					if (!s_) continue;
					const tot = s_.o.reduce((a: number, o: any) => a + o.p, 0) || 1;
					for (const o of s_.o) {
						const pa = o.pa ?? "Other";
						const row = by.get(pa) ?? { party: pa, odds: [] as number[], traded_usd: 0 };
						row.odds.push(o.p / tot);
						row.traded_usd += o.v ?? 0;
						by.set(pa, row);
					}
				}
				return [...by.values()].map((p) => ({ party: p.party, odds: r3(p.odds.reduce((a, b) => a + b, 0) / p.odds.length), traded_usd: usd(p.traded_usd) }));
			};
			return { cycle: data!.meta.cycle, url: `https://parlaythepeople.com/${data!.meta.cycle}/president/`, party: parties(pres.party), winner: rows(pres.winner), democratic_nomination: rows(pres.nomD), republican_nomination: rows(pres.nomR) };
		}
		case "social_pulse": {
			const social = await getSocial();
			const key = nameKey(String(input.candidate ?? ""));
			const p = Object.values(social?.topics ?? {}).filter((x) => x.key === key).sort((a, b) => b.i24 - a.i24)[0];
			if (!p) return { error: `No social data for ${input.candidate}. Social data covers candidates in races the site tracks.` };
			return { ...pulseBrief(p), daily: p.series.map(([t, i, s]) => ({ day: new Date(t * 1000).toISOString().slice(0, 10), interactions: i, sentiment: s })), source: "LunarCrush" };
		}
		case "expert_ratings": {
			const all = (await allRaces()).find((x) => x.r.id === input.race_id);
			if (!all) return { error: `No race ${input.race_id}. Use find_races first.` };
			const r = await ratingsFor(all.r.id);
			const c = consensus(all.r);
			const pD = c.D / Math.max(0.01, c.D + c.R);
			const exp = expertScore(r);
			return {
				race: officeTitle(all.r), url: `https://parlaythepeople.com${all.r.path}`,
				ratings: FORECASTER_KEYS.filter((f) => r[f]).map((f) => ({ forecaster: FORECASTERS[f].name, rating: r[f]!.rating, as_of: r[f]!.as_of, previous: r[f]!.previous, link: FORECASTERS[f].url })),
				experts_average: exp == null ? null : scoreWord(Math.round(exp)),
				market_on_same_scale: scoreWord(marketScore(pD)), market_D_two_party: r3(pD),
				note: "Ratings are the forecasters' own; credit them by name. Scale: Safe/Solid, Likely, Lean, Tilt, Toss-up.",
			};
		}
		case "search_research": {
			try {
				const res: any = await (env.AI as any).autorag("parlay").search({ query: String(input.query ?? ""), max_num_results: 8, rewrite_query: false });
				return {
					results: (res?.data ?? []).map((d: any) => ({
						document: d.filename, score: r3(d.score), url: d.attributes?.file?.url ?? d.attributes?.url ?? null,
						title: d.attributes?.file?.title ?? d.attributes?.title ?? null,
						text: (d.content ?? []).map((c: any) => c.text).join("\n").slice(0, 1800),
					})),
				};
			} catch (e) {
				return { error: `Research search unavailable: ${String(e).slice(0, 120)}` };
			}
		}
	}
	return { error: `Unknown tool ${name}` };
}

function pulseBrief(p: Pulse) {
	return {
		name: p.name, interactions_24h: p.i24, people_posting: p.contributors, posts_24h: p.posts24, sentiment_pct_positive: p.sentiment,
		week_over_week: p.wow, trend: p.trend, races: p.races,
		top_posts: (p.top ?? []).slice(0, 5).map((t) => ({ text: t.t.slice(0, 280), by: t.by, network: t.net, interactions: t.i, url: t.u })),
	};
}
