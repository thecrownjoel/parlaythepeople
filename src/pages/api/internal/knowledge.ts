import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { publishKnowledge } from "../../../lib/knowledge";

/** Rebuilds the AI analyst's research documents in R2. Called by the collector a few times a day. */
export const POST: APIRoute = async ({ request, url }) => {
	const token = (env as unknown as { KNOWLEDGE_TOKEN?: string }).KNOWLEDGE_TOKEN;
	if (!token || request.headers.get("authorization") !== `Bearer ${token}`) return new Response("Forbidden", { status: 403 });
	const result = await publishKnowledge(url.origin);
	return Response.json(result);
};
