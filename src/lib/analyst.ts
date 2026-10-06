/**
 * The AI analyst's loop, shared by the chat (/api/v1/ai/chat), PDF race reports and daily briefings.
 * Every model call goes through lib/ai.ts (Workers AI via AI Gateway).
 */
import { TOOLS, PRO_TOOLS, runTool } from "./ai-tools";
import { getIndex, daysUntil } from "./markets";
import type { Account } from "./auth";
import type { Action } from "./plans";
import { aiRun } from "./ai";

export const STATUS: Record<string, (i: any) => string> = {
	find_races: (i) => `Finding races matching “${i.query}”`,
	race_detail: (i) => `Reading the ${String(i.race_id).replace(/^\d{4}-/, "").replace(/-/g, " ")} race`,
	odds_history: () => "Pulling the price history",
	money: (i) => `Adding up the money${i.race_id ? " on this race" : ""}`,
	movers: () => "Checking the biggest moves",
	presidential: () => "Reading the presidential markets",
	social_pulse: (i) => `Checking social buzz for ${i.candidate}`,
	search_research: (i) => `Searching headlines and analysis for “${i.query}”`,
	trade_flow: () => "Tracing who is buying which side",
	whale_watch: () => "Finding the biggest bets and wallets",
	exchange_divergence: () => "Comparing Kalshi and Polymarket",
	deep_research: (i) => `Reading deeper on “${i.query}”`,
	race_analogs: () => "Finding races that moved like this one",
	polls: () => "Reading the polls",
	campaign_finance: () => "Checking the FEC filings",
	expert_ratings: () => "Checking the Cook, Sabato and Inside Elections ratings",
};

export async function systemPrompt(a: Account, mode: Action) {
	const index = await getIndex();
	const next = index?.cycles.find((c) => c.year === index.next);
	const today = new Date().toISOString().slice(0, 10);
	const pro = a.plan.proTools
		? `\n\nThis reader has ${a.plan.name}. Use the Pro tools when they help: trade_flow (who is buying which side of a race), whale_watch (biggest bets, most active wallets), exchange_divergence (where Kalshi and Polymarket disagree), race_analogs (past races whose odds moved the same way, and what happened next) and deep_research (reranked research). Readers are campaign staff, consultants, reporters and traders: be specific about money, direction and timing.`
		: "";
	const deep = mode === "deep"
		? `\n\nThis is a Deep analysis. Investigate thoroughly with several tools before answering: current odds, how they moved, trade flow, whether the exchanges agree, races that moved like this one, and the news behind it. Answer in up to about 700 words under these short headings: Bottom line, What's driving it, The money, Where the markets disagree, What to watch.`
		: "";
	return `You are the analyst at Parlay the People (parlaythepeople.com), an independent election research site that tracks Kalshi and Polymarket prediction markets for every U.S. Senate, House, governor and presidential race, with social data from LunarCrush and its own forecasting model, the Parlay estimate.

Today is ${today}.${next ? ` The next general election is ${next.election_day} (${daysUntil(next.election_day)} days away).` : ""}

How to answer:
- Get every number from the tools; never state a figure from memory. Start with find_races when the user names a race or candidate, then race_detail. Use search_research for headlines, articles and context, polls for public polling (cite pollster and dates; polls and market odds measure different things), expert_ratings for what Cook, Sabato and Inside Elections rate the race (credit them by name), and campaign_finance for fundraising, cash on hand and outside spending (FEC; say the report date).
- Lead with the answer in a sentence or two, then the evidence. Keep it under about 250 words unless asked for more. Use short paragraphs or bullets, plain words, and markdown links.
- Market odds are crowd probabilities: "traders give Collins a 41% chance". Say when Kalshi and Polymarket disagree. Give the Parlay estimate where it differs from the market and say it is our model's adjustment (clear favorites are nudged up; competitive races keep market odds).
- Link race pages and articles you rely on (the url fields), e.g. [Maine Senate](https://parlaythepeople.com/2026/senate/maine/).
- Social posts are what people are saying, not verified facts: attribute them ("a widely shared post claims…"). Social buzz has not predicted winners in our testing; treat it as context for why a market moves.
- Money figures from trade records begin Sep 30, 2026; say so when it matters. Polymarket wallets are pseudonyms: never guess who owns one.
- Be factual and even-handed about both parties.
- This is research, not betting advice. You may analyze where the markets could be mispriced and why, but never tell someone to buy, sell or how much to bet. If asked, explain you provide research and they make their own decisions.
- If the data can't answer the question, say so plainly.${pro}${deep}`;
}

export interface AnalystResult { text: string; ok: boolean; tin: number; tout: number; used: string[] }

/** The tool loop: model → tools → model … until it answers or runs out of rounds. */
export async function runAnalyst(o: {
	account: Account; messages: { role: string; content: string }[]; mode: Action; feature: string;
	onStatus?: (text: string) => void; extraSystem?: string;
}): Promise<AnalystResult> {
	const { account: a, mode } = o;
	const model = a.plan.model[mode];
	const tools = (a.plan.proTools ? [...TOOLS, ...PRO_TOOLS] : TOOLS).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
	const rounds = a.plan.rounds[mode];
	const tag = { plan: a.plan.id, mode, feature: o.feature, subject: a.subject.startsWith("a:") ? "anon" : a.subject };
	const used: string[] = [];
	let tin = 0, tout = 0;
	const convo: any[] = [{ role: "system", content: (await systemPrompt(a, mode)) + (o.extraSystem ? `\n\n${o.extraSystem}` : "") }, ...o.messages];
	for (let round = 0; round < rounds; round++) {
		const res: any = await aiRun(model, { messages: convo, tools, max_tokens: a.plan.maxTokens[mode], temperature: 0.3 }, tag);
		tin += res?.usage?.prompt_tokens ?? 0; tout += res?.usage?.completion_tokens ?? 0;
		const msg = (res?.choices?.[0]?.message ?? { content: res?.response ?? "", tool_calls: res?.tool_calls }) as { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string | object } }[] };
		const calls = msg.tool_calls ?? [];
		if (!calls.length) {
			const text = String(msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
			return { text: text || "I couldn't find an answer to that. Try asking about a specific race or candidate.", ok: true, tin, tout, used };
		}
		convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
		for (const c of calls) {
			const name = c.function.name;
			let args: any = {};
			try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments ?? {}; } catch { args = {}; }
			used.push(name);
			o.onStatus?.((STATUS[name] ?? (() => "Looking it up"))(args));
			const out = await runTool(name, args, { pro: a.plan.proTools });
			convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, mode === "deep" ? 30000 : 20000) });
		}
	}
	return { text: "I gathered a lot of data but ran out of steps to finish the answer. Try a narrower question.", ok: false, tin, tout, used };
}
