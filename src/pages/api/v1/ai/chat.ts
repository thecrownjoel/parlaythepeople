import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { TOOLS, runTool } from "../../../../lib/ai-tools";
import { getIndex, daysUntil } from "../../../../lib/markets";

/**
 * The AI analyst. POST {messages: [{role: "user"|"assistant", content: string}]} → a text/event-stream of
 * {type:"status", text} progress events, then {type:"answer", text} (or {type:"error", text}).
 * Uses Claude through the Anthropic API when the secret ANTHROPIC_API_KEY is set (optional AI_GATEWAY_ID routes it
 * through Cloudflare AI Gateway; AI_MODEL overrides the model); otherwise a Workers AI model (AI_WORKERS_MODEL).
 * Either way it answers with the read-only tools in lib/ai-tools.ts.
 */
type Env = { ANTHROPIC_API_KEY?: string; AI_GATEWAY_ID?: string; AI_MODEL?: string; AI_DAILY_LIMIT?: string; AI_WORKERS_MODEL?: string; AI_GLOBAL_DAILY?: string };
/** Without an Anthropic key the analyst runs on Cloudflare Workers AI (same tools, same instructions). */
const WORKERS_MODEL = "@cf/zai-org/glm-5.3";
const E = env as unknown as Env;
const ACCOUNT = "ece401f47370ecab76cbc85bf2a7054c";
const MAX_ROUNDS = 6;

const STATUS: Record<string, (i: any) => string> = {
	find_races: (i) => `Finding races matching “${i.query}”`,
	race_detail: (i) => `Reading the ${String(i.race_id).replace(/^\d{4}-/, "").replace(/-/g, " ")} race`,
	odds_history: () => "Pulling the price history",
	money: (i) => `Adding up the money${i.race_id ? " on this race" : ""}`,
	movers: () => "Checking the biggest moves",
	presidential: () => "Reading the presidential markets",
	social_pulse: (i) => `Checking social buzz for ${i.candidate}`,
	search_research: (i) => `Searching headlines and analysis for “${i.query}”`,
};

async function system() {
	const index = await getIndex();
	const next = index?.cycles.find((c) => c.year === index.next);
	const today = new Date().toISOString().slice(0, 10);
	return `You are the analyst at Parlay the People (parlaythepeople.com), an independent election research site that tracks Kalshi and Polymarket prediction markets for every U.S. Senate, House, governor and presidential race, with social data from LunarCrush and its own forecasting model, the Parlay estimate.

Today is ${today}.${next ? ` The next general election is ${next.election_day} (${daysUntil(next.election_day)} days away).` : ""}

How to answer:
- Get every number from the tools; never state a figure from memory. Start with find_races when the user names a race or candidate, then race_detail. Use search_research for headlines, articles and context.
- Lead with the answer in a sentence or two, then the evidence. Keep it under about 250 words unless asked for more. Use short paragraphs or bullets, plain words, and markdown links.
- Market odds are crowd probabilities: "traders give Collins a 41% chance". Say when Kalshi and Polymarket disagree. Give the Parlay estimate where it differs from the market and say it is our model's adjustment (clear favorites are nudged up; competitive races keep market odds).
- Link race pages and articles you rely on (the url fields), e.g. [Maine Senate](https://parlaythepeople.com/2026/senate/maine/).
- Social posts are what people are saying, not verified facts: attribute them ("a widely shared post claims…"). Social buzz has not predicted winners in our testing; treat it as context for why a market moves.
- Money figures from trade records begin Sep 30, 2026; say so when it matters.
- Be factual and even-handed about both parties.
- This is research, not betting advice. You may analyze where the markets could be mispriced and why, but never tell someone to buy, sell or how much to bet. If asked, explain you provide research and they make their own decisions.
- If the data can't answer the question, say so plainly.`;
}

async function callClaude(body: object) {
	const url = E.AI_GATEWAY_ID
		? `https://gateway.ai.cloudflare.com/v1/${ACCOUNT}/${E.AI_GATEWAY_ID}/anthropic/v1/messages`
		: "https://api.anthropic.com/v1/messages";
	const r = await fetch(url, {
		method: "POST",
		headers: { "x-api-key": E.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
	return (await r.json()) as { content: any[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } };
}

/** One OpenAI-format round on Workers AI; returns the assistant message. */
async function callWorkers(messages: any[], usage: { tin: number; tout: number }) {
	const tools = TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
	const res: any = await (env.AI as any).run(E.AI_WORKERS_MODEL || WORKERS_MODEL, { messages, tools, max_tokens: 1500, temperature: 0.3 });
	usage.tin += res?.usage?.prompt_tokens ?? 0; usage.tout += res?.usage?.completion_tokens ?? 0;
	const msg = res?.choices?.[0]?.message ?? { content: res?.response ?? "", tool_calls: res?.tool_calls };
	return msg as { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string | object } }[] };
}

async function who(request: Request) {
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`parlay:${ip}`));
	return Array.from(new Uint8Array(h)).slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const GET: APIRoute = async () => Response.json({ configured: true, engine: E.ANTHROPIC_API_KEY ? "claude" : "workers-ai", daily_limit: Number(E.AI_DAILY_LIMIT ?? 10) });

export const POST: APIRoute = async ({ request }) => {
	let input: { messages?: { role: string; content: string }[] };
	try { input = await request.json(); } catch { return Response.json({ error: "bad_request" }, { status: 400 }); }
	const messages = (input.messages ?? [])
		.filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
		.slice(-10)
		.map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
	if (!messages.length || messages[messages.length - 1].role !== "user") return Response.json({ error: "bad_request" }, { status: 400 });

	const id = await who(request);
	const day = Math.floor(Date.now() / 86_400_000);
	const limit = Number(E.AI_DAILY_LIMIT ?? 10);
	const used = await env.MARKETS.prepare("SELECT n FROM ai_usage WHERE who = ? AND day = ?").bind(id, day).first<{ n: number }>();
	if ((used?.n ?? 0) >= limit) return Response.json({ error: "limit", limit }, { status: 429 });
	// a ceiling for the whole site, so a traffic spike can't run up the AI bill
	const all = await env.MARKETS.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM ai_usage WHERE day = ?").bind(day).first<{ n: number }>();
	if ((all?.n ?? 0) >= Number(E.AI_GLOBAL_DAILY ?? 500)) return Response.json({ error: "busy" }, { status: 429 });
	await env.MARKETS.prepare("INSERT INTO ai_usage (who, day, n) VALUES (?, ?, 1) ON CONFLICT(who, day) DO UPDATE SET n = n + 1").bind(id, day).run();

	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(ctrl) {
			const send = (o: object) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
			const t0 = Date.now();
			const used: string[] = [];
			let tin = 0, tout = 0, ok = 0;
			try {
				const sys = await system();
				if (E.ANTHROPIC_API_KEY) {
					const convo: any[] = [...messages];
					for (let round = 0; round < MAX_ROUNDS; round++) {
						const res = await callClaude({ model: E.AI_MODEL || "claude-sonnet-5-5", max_tokens: 1500, system: sys, tools: TOOLS, messages: convo });
						tin += res.usage?.input_tokens ?? 0; tout += res.usage?.output_tokens ?? 0;
						const calls = res.content.filter((c) => c.type === "tool_use");
						if (res.stop_reason !== "tool_use" || !calls.length) {
							send({ type: "answer", text: res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n").trim() });
							ok = 1;
							break;
						}
						convo.push({ role: "assistant", content: res.content });
						const results = [];
						for (const c of calls) {
							used.push(c.name);
							send({ type: "status", text: (STATUS[c.name] ?? (() => "Looking it up"))(c.input ?? {}) });
							const out = await runTool(c.name, c.input ?? {});
							results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(out).slice(0, 20000) });
						}
						convo.push({ role: "user", content: results });
						if (round === MAX_ROUNDS - 1) send({ type: "answer", text: "I gathered a lot of data but ran out of steps to finish the answer. Try a narrower question." });
					}
				} else {
					const usage = { tin: 0, tout: 0 };
					const convo: any[] = [{ role: "system", content: sys }, ...messages];
					for (let round = 0; round < MAX_ROUNDS; round++) {
						const msg = await callWorkers(convo, usage);
						const calls = msg.tool_calls ?? [];
						if (!calls.length) {
							send({ type: "answer", text: String(msg.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim() || "I couldn't find an answer to that. Try asking about a specific race or candidate." });
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
							const out = await runTool(name, args);
							convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 20000) });
						}
						if (round === MAX_ROUNDS - 1) send({ type: "answer", text: "I gathered a lot of data but ran out of steps to finish the answer. Try a narrower question." });
					}
					tin = usage.tin; tout = usage.tout;
				}
			} catch (e) {
				send({ type: "error", text: "The analyst is unavailable right now. Please try again in a minute." });
				console.error("ai chat", String(e));
			} finally {
				try {
					await env.MARKETS.prepare("INSERT INTO ai_log (ts, who, question, tools, ms, input_tokens, output_tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
						.bind(Math.floor(Date.now() / 1000), id, messages[messages.length - 1].content.slice(0, 500), used.join(","), Date.now() - t0, tin, tout, ok).run();
				} catch { /* logging never breaks an answer */ }
				ctrl.close();
			}
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};
