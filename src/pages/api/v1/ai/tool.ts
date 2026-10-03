import type { APIRoute } from "astro";
import { runTool, TOOLS } from "../../../../lib/ai-tools";

/** Runs one analyst tool directly: /api/v1/ai/tool?name=race_detail&args={"race_id":"2026-senate-maine"}. Read-only. */
export const GET: APIRoute = async ({ url }) => {
	const name = url.searchParams.get("name") ?? "";
	if (!TOOLS.some((t) => t.name === name)) return Response.json({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description })) });
	let args: Record<string, unknown> = {};
	try { args = JSON.parse(url.searchParams.get("args") || "{}"); } catch { return Response.json({ error: "args must be JSON" }, { status: 400 }); }
	const out = await runTool(name, args);
	return Response.json(out, { headers: { "cache-control": "public, max-age=120", "x-robots-tag": "noindex" } });
};
