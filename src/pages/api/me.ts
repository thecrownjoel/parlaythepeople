import type { APIRoute } from "astro";
import { viewerPlan } from "../../lib/auth";

/** What this viewer's plan opens, for marking locked controls in the page: {plan, history, archive}. */
export const GET: APIRoute = async ({ cookies }) => {
	const p = await viewerPlan(cookies);
	return Response.json({ plan: p.id, history: p.history, archive: p.archive }, { headers: { "cache-control": "private, no-store" } });
};
