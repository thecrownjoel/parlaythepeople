/**
 * Every Workers AI call goes through Cloudflare AI Gateway (AI_GATEWAY_ID, default "default", which Cloudflare
 * creates on first use), tagged with plan and feature so the gateway's analytics break cost down per plan.
 * Models named "gemini-*" go to Google's OpenAI-compatible endpoint instead (secret GEMINI_API_KEY); it returns the
 * same { choices, usage } shape, tool calls included, so callers don't need to know which provider ran.
 */
import { env } from "cloudflare:workers";

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

export function aiRun(model: string, inputs: object, tag: Record<string, string | number> = {}): Promise<any> {
	if (model.startsWith("gemini-")) return geminiRun(model, inputs);
	const id = (env as unknown as { AI_GATEWAY_ID?: string }).AI_GATEWAY_ID || "default";
	return (env.AI as any).run(model, inputs, { gateway: { id, metadata: tag } });
}

async function geminiRun(model: string, inputs: object): Promise<any> {
	const key = (env as unknown as { GEMINI_API_KEY?: string }).GEMINI_API_KEY;
	if (!key) throw new Error("GEMINI_API_KEY isn't set (wrangler secret put GEMINI_API_KEY).");
	const res = await fetch(GEMINI_URL, {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model, ...inputs }),
	});
	// throw on 429/503 so the caller's step retries instead of saving an empty result
	if (!res.ok) throw new Error(`Gemini ${model} ${res.status}: ${(await res.text()).slice(0, 300)}`);
	return res.json();
}
