import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { runAnalyst } from "../../../../lib/analyst";
import { account, charge, settle, price } from "../../../../lib/auth";
import { costUsd, type Action } from "../../../../lib/plans";

/**
 * The AI analyst. POST {messages: [{role: "user"|"assistant", content: string}], mode?: "ask"|"deep"} → a
 * text/event-stream of {type:"status", text} progress events, then {type:"answer", text, left} (or {type:"error", text}).
 * The loop itself is in lib/analyst.ts. The analyst is part of Pro: a signed-in paid plan, charged per answer
 * (model cost × AI_MARKUP) from the monthly allowance, then the AI balance (lib/plans.ts, lib/auth.ts).
 */

export const GET: APIRoute = async ({ cookies, request }) => {
	const a = await account(cookies, request);
	return Response.json({
		configured: true, engine: "workers-ai", plan: a.plan.id, plan_name: a.plan.name, signed_in: !!a.user,
		left: a.left, unit: a.plan.aiAllowance != null ? "cents" : "questions", resets: a.resets, deep: a.plan.deep, deep_cost: price(a, "deep"), ask_cost: price(a, "ask"),
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
	// the AI analyst is part of Pro (a signed-in paid plan)
	if (!a.plan.proTools) return Response.json({ error: "pro_only", signed_in: !!a.user }, { status: 403 });
	if (a.left < price(a, mode)) return Response.json({ error: "limit", plan: a.plan.id, signed_in: !!a.user }, { status: 429 });
	const model = a.plan.model[mode];
	const event = await charge(a, mode, model);

	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(ctrl) {
			const send = (o: object) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
			const t0 = Date.now();
			let r = { text: "", ok: false, tin: 0, tout: 0, used: [] as string[] };
			let settled = false;
			try {
				r = await runAnalyst({ account: a, messages, mode, feature: "chat", onStatus: (text) => send({ type: "status", text }) });
				const charged = await settle(a, event, { tin: r.tin, tout: r.tout, cost: costUsd(model, r.tin, r.tout), ok: r.ok });
				settled = true;
				send({ type: "answer", text: r.text, left: Math.max(0, a.left - charged), charged });
			} catch (e) {
				send({ type: "error", text: "The analyst is unavailable right now. Please try again in a minute." });
				console.error("ai chat", String(e));
			} finally {
				if (!settled) try { await settle(a, event, { tin: r.tin, tout: r.tout, cost: costUsd(model, r.tin, r.tout), ok: false }); } catch (e) { console.error("ai settle", String(e)); }
				try {
					await env.MARKETS.prepare("INSERT INTO ai_log (ts, who, question, tools, ms, input_tokens, output_tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
						.bind(Math.floor(Date.now() / 1000), `${a.plan.id}:${mode}`, messages[messages.length - 1].content.slice(0, 500), r.used.join(","), Date.now() - t0, r.tin, r.tout, r.ok ? 1 : 0).run();
				} catch { /* logging never breaks an answer */ }
				ctrl.close();
			}
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};
