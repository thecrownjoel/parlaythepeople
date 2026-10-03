/**
 * Tools the AI analyst calls for exact, current numbers (Anthropic tool-use format), plus one that
 * searches the research documents through Cloudflare AI Search. Every tool is read-only.
 */
import { env } from "cloudflare:workers";
import { getIndex, getCycle, consensus, shares, candidate, officeTitle, RATING_LABEL, type Race, type CycleData } from "./markets";
import { racesAt, moversSince, leadChangesSince } from "./trends";
import { moneySince, biggestTrades, raceMoneyByDay } from "./money";
import { getSocial, pulseIndex, type Pulse } from "./social";
import { parlayD, MODEL } from "./model";
import { getSeries, RANGES } from "./chart";
import { merged } from "./home";
import { nameKey } from "./names";

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
		description: "Democratic odds over time for a race on each exchange. days: 1, 7, 30, 90, 365 or 0 for all history (back to Nov 2024).",
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
		name: "search_research",
		description: "Search Parlay the People's research library: race dossiers, every headline the site has carried, the Analysis desk's articles, and notes on methodology and the model. Use for context, news and explanations; use the other tools for exact current numbers.",
		input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	},
] as const;

export type ToolName = (typeof TOOLS)[number]["name"];

export async function runTool(name: string, input: Record<string, any>): Promise<unknown> {
	const now = Math.floor(Date.now() / 1000);
	switch (name) {
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
				model_note: `Parlay estimate: market odds adjusted by a model trained on ${MODEL.trained_on} decided races; competitive races (favorite under 70%) keep the market's odds.`,
			};
		}
		case "odds_history": {
			const days = Number(input.days ?? 30);
			const range = days === 0 ? RANGES.find((x) => x.key === "all")! : days <= 1 ? RANGES[0] : days <= 7 ? RANGES[1] : days <= 30 ? RANGES[2] : days <= 90 ? RANGES[3] : RANGES[4];
			const pts = await getSeries(String(input.race_id), range);
			const step = Math.max(1, Math.ceil(pts.length / 60));
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
