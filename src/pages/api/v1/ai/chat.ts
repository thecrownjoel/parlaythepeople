import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { TOOLS, PRO_TOOLS, runTool } from "../../../../lib/ai-tools";
import { getIndex, daysUntil } from "../../../../lib/markets";
import { account, charge, settle, price, type Account } from "../../../../lib/auth";
import { costUsd, type Action } from "../../../../lib/plans";

/**
 * The AI analyst. POST {messages: [{role: "user"|"assistant", content: string}], mode?: "ask"|"deep"} → a
 * text/event-stream of {type:"status", text} progress events, then {type:"answer", text, left} (or {type:"error", text}).
 * Runs on Cloudflare Workers AI with the read-only tools in lib/ai-tools.ts. The reader's plan (lib/plans.ts)
 * sets the model, how many tool rounds it may take, whether Pro tools and Deep mode are on, and the limit:
 * questions per day for the public and free accounts, credits per month for Pro, Team and Organization.
 * With AI_GATEWAY_ID set, calls go through Cloudflare AI Gateway tagged with the plan, for per-plan analytics.
 */
type Env = { AI_GATEWAY_ID?: string; AI_GLOBAL_DAILY?: string };
const E = env as unknown as Env;

const STATUS: Record<string, (i: any) => string> = {
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
};

async function system(a: Account, mode: Action) {
	const index = await getIndex();
	const next = index?.cycles.find((c) => c.year === index.next);
	const today = new Date().toISOString().slice(0, 10);
	const pro = a.plan.proTools
		? `\n\nThis reader has ${a.plan.name}. Use the Pro tools when they help: trade_flow (who is buying which side of a race), whale_watch (biggest bets, most active wallets), exchange_divergence (where Kalshi and Polymarket disagree) and deep_research (reranked research). Readers are campaign staff, consultants, reporters and traders: be specific about money, direction and timing.`
		: "";
	const deep = mode === "deep"
		? `\n\nThis is a Deep analysis. Investigate thoroughly with several tools before answering: current odds, how they moved, trade flow, whether the exchanges agree, and the news behind it. Answer in up to about 700 words under these short headings: Bottom line, What's driving it, The money, Where the markets disagree, What to watch.`
		: "";
	return `You are the analyst at Parlay the People (parlaythepeople.com), an independent election research site that tracks Kalshi and Polymarket prediction markets for every U.S. Senate, House, governor and presidential race, with social data from LunarCrush and its own forecasting model, the Parlay estimate.

Today is ${today}.${next ? ` The next general election is ${next.election_day} (${daysUntil(next.election_day)} days away).` : ""}

How to answer:
- Get every number from the tools; never state a figure from memory. Start with find_races when the user names a race or candidate, then race_detail. Use search_research for headlines, articles and context.
- Lead with the answer in a sentence or two, then the evidence. Keep it under about 250 words unless asked for more. Use short paragraphs or bullets, plain words, and markdown links.
- Market odds are crowd probabilities: "traders give Collins a 41% chance". Say when Kalshi and Polymarket disagree. Give the Parlay estimate where it differs from the market and say it is our model's adjustment (clear favorites are nudged up; competitive races keep market odds).
- Link race pages and articles you rely on (the url fields), e.g. [Maine Senate](https://parlaythepeople.com/2026/senate/maine/).
- Social posts are what people are saying, not verified facts: attribute them ("a widely shared post claims…"). Social buzz has not predicted winners in our testing; treat it as context for why a market moves.
- Money figures from trade records begin Sep 30, 2026; say so when it matters. Polymarket wallets are pseudonyms: never guess who owns one.
- Be factual and even-handed about both parties.
- This is research, not betting advice. You may analyze where the markets could be mispriced and why, but never tell someone to buy, sell or how much to bet. If asked, explain you provide research and they make their own decisions.
- If the data can't answer the question, say so plainly.${pro}${deep}`;
}

/** One OpenAI-format round on Workers AI; returns the assistant message. */
async function callWorkers(model: string, messages: any[], tools: readonly any[], maxTokens: number, usage: { tin: number; tout: number }, tag: Record<string, string>) {
	const fns = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
	const opts = E.AI_GATEWAY_ID ? { gateway: { id: E.AI_GATEWAY_ID, metadata: tag } } : undefined;
	const res: any = await (env.AI as any).run(model, { messages, tools: fns, max_tokens: maxTokens, temperature: 0.3 }, opts);
	usage.tin += res?.usage?.prompt_tokens ?? 0; usage.tout += res?.usage?.completion_tokens ?? 0;
	const msg = res?.choices?.[0]?.message ?? { content: res?.response ?? "", tool_calls: res?.tool_calls };
	return msg as { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string | object } }[] };
}

export const GET: APIRoute = async ({ cookies, request }) => {
	const a = await account(cookies, request);
	return Response.json({
		configured: true, engine: "workers-ai", plan: a.plan.id, plan_name: a.plan.name, signed_in: !!a.user,
		left: a.left, unit: a.plan.credits ? "credits" : "questions", resets: a.resets, deep: a.plan.deep, deep_cost: price(a, "deep"),
	}, { headers: { "cache-control": "no-store" } });
};

export const POST: APIRoute = async ({ request, cookies }) => {
	let input: { messages?: { role: string; content: string }[]; mode?: string };
	try { input = await request.json(); } catch { return Response.json({ error: "bad_request" }, { status: 400 }); }
	const messages = (input.messages ?? [])
		.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
		.slice(-10)
		.map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
	if (!messages.length || messages[messages.length - 1].role !== "user") return Response.json({ error: "bad_request" }, { status: 400 });

	const a = await account(cookies, request);
	const mode: Action = input.mode === "deep" ? "deep" : "ask";
	if (mode === "deep" && !a.plan.deep) return Response.json({ error: "pro_only" }, { status: 403 });
	if (a.left < price(a, mode)) return Response.json({ error: "limit", plan: a.plan.id, signed_in: !!a.user }, { status: 429 });
	if (!a.plan.credits) {
		// a ceiling on free questions across the whole site, so a traffic spike can't run up the AI bill
		const day = Math.floor(Date.now() / 86_400_000);
		const all = await env.MARKETS.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM ai_usage WHERE day = ?").bind(day).first<{ n: number }>();
		if ((all?.n ?? 0) >= Number(E.AI_GLOBAL_DAILY ?? 200)) return Response.json({ error: "busy" }, { status: 429 });
		await env.MARKETS.prepare("INSERT INTO ai_usage (who, day, n) VALUES (?, ?, 1) ON CONFLICT(who, day) DO UPDATE SET n = n + 1").bind(a.subject, day).run();
	}
	const model = a.plan.model[mode];
	const event = await charge(a, mode, model);
	const tools = a.plan.proTools ? [...TOOLS, ...PRO_TOOLS] : TOOLS;
	const rounds = a.plan.rounds[mode];
	const tag = { plan: a.plan.id, mode, subject: a.subject.slice(0, 2) === "a:" ? "anon" : a.subject };

	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(ctrl) {
			const send = (o: object) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
			const t0 = Date.now();
			const used: string[] = [];
			const usage = { tin: 0, tout: 0 };
			let ok = 0;
			try {
				const convo: any[] = [{ role: "system", content: await system(a, mode) }, ...messages];
				for (let round = 0; round < rounds; round++) {
					const msg = await callWorkers(model, convo, tools, a.plan.maxTokens[mode], usage, tag);
					const calls = msg.tool_calls ?? [];
					if (!calls.length) {
						const text = String(msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
						send({ type: "answer", text: text || "I couldn't find an answer to that. Try asking about a specific race or candidate.", left: a.left - price(a, mode) });
						ok = 1;
						break;
					}
					convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
					for (const c of calls) {
						const name = c.function.name;
						let args: any = {};
						try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments ?? {}; } catch { args = {}; }
						used.push(name);
						send({ type: "status", text: (STATUS[name] ?? (() => "Looking it up"))(args) });
						const out = await runTool(name, args, { pro: a.plan.proTools });
						convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, mode === "deep" ? 30000 : 20000) });
					}
					if (round === rounds - 1) send({ type: "answer", text: "I gathered a lot of data but ran out of steps to finish the answer. Try a narrower question.", left: a.left });
				}
			} catch (e) {
				send({ type: "error", text: "The analyst is unavailable right now. Please try again in a minute." });
				console.error("ai chat", String(e));
			} finally {
				try { await settle(event, { tin: usage.tin, tout: usage.tout, cost: costUsd(model, usage.tin, usage.tout), ok: !!ok }); } catch (e) { console.error("ai settle", String(e)); }
				try {
					await env.MARKETS.prepare("INSERT INTO ai_log (ts, who, question, tools, ms, input_tokens, output_tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
						.bind(Math.floor(Date.now() / 1000), `${a.plan.id}:${mode}`, messages[messages.length - 1].content.slice(0, 500), used.join(","), Date.now() - t0, usage.tin, usage.tout, ok).run();
				} catch { /* logging never breaks an answer */ }
				ctrl.close();
			}
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};
