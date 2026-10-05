import type { APIRoute } from "astro";
import { viewerPlan } from "../../lib/auth";

/** What this viewer's plan opens, for marking locked controls and the header's account link: {plan, signedIn, history, archive}. */
export const GET: APIRoute = async ({ cookies }) => {
	const p = await viewerPlan(cookies);
	return Response.json({ plan: p.id, signedIn: p.id !== "anon", history: p.history, archive: p.archive }, { headers: { "cache-control": "private, no-store" } });
};
