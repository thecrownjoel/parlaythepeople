import type { APIRoute } from "astro";
import { getPolitics } from "../../../lib/politics";

/** Every other politics market on Kalshi and Polymarket (the /politics/ board): current odds and money, by topic. */
export const GET: APIRoute = async () => {
	const board = await getPolitics();
	if (!board) return Response.json({ error: "The politics board isn't available yet." }, { status: 503 });
	return Response.json(board, { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
};
