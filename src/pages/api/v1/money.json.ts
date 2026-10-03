import type { APIRoute } from "astro";
import { runTool } from "../../../lib/ai-tools";

/** Money traded over the last N days (?days=1|7|30, default 1): totals, top races and biggest trades. */
export const GET: APIRoute = async ({ url }) => {
	const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 1) || 1));
	const out = await runTool("money", { days });
	return Response.json(out, { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
};
