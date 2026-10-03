import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { buildAnalogs } from "../../../lib/analogs";

/** Rebuild the race analogs index now. Site admins (EmDash login) or the KNOWLEDGE_TOKEN bearer. */
export const POST: APIRoute = async ({ request, locals }) => {
	const token = (env as unknown as { KNOWLEDGE_TOKEN?: string }).KNOWLEDGE_TOKEN;
	const admin = ((locals as any).user?.role ?? 0) >= 50;
	if (!admin && !(token && request.headers.get("authorization") === `Bearer ${token}`)) return new Response("Forbidden", { status: 403 });
	return Response.json(await buildAnalogs());
};
