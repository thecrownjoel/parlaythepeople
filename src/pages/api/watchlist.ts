import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { currentUser } from "../../lib/auth";
import { readJson, bad, ok } from "./auth/_json";

/**
 * Followed races for a signed-in reader, so the follow star works across browsers and drives briefings and alerts.
 * GET → {signed_in, races: [{race_id, name}]}. POST {races: [{race_id, name}], on: boolean} adds or removes.
 */
const RACE = /^\d{4}-[a-z0-9-]{2,60}$/;

export const GET: APIRoute = async ({ cookies }) => {
	const user = cookies.get("ptp_session") ? await currentUser(cookies) : null;
	if (!user) return Response.json({ signed_in: false, races: [] }, { headers: { "cache-control": "no-store" } });
	const { results } = await env.ACCOUNTS.prepare("SELECT race_id, name FROM watchlist WHERE user_id = ? ORDER BY added").bind(user.id).all();
	return Response.json({ signed_in: true, races: results ?? [] }, { headers: { "cache-control": "no-store" } });
};

export const POST: APIRoute = async ({ request, cookies }) => {
	const body = await readJson(request);
	const user = await currentUser(cookies);
	if (!user) return bad("signed_out", 401);
	const races = (Array.isArray(body?.races) ? body!.races : []).filter((r: any) => typeof r?.race_id === "string" && RACE.test(r.race_id)).slice(0, 100);
	if (!races.length) return bad("bad_request");
	const t = Math.floor(Date.now() / 1000);
	const stmts = races.map((r: any) => body!.on === false
		? env.ACCOUNTS.prepare("DELETE FROM watchlist WHERE user_id = ? AND race_id = ?").bind(user.id, r.race_id)
		: env.ACCOUNTS.prepare("INSERT INTO watchlist (user_id, race_id, added, name) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, race_id) DO UPDATE SET name = COALESCE(excluded.name, name)").bind(user.id, r.race_id, t, String(r.name ?? "").slice(0, 120) || null));
	await env.ACCOUNTS.batch(stmts);
	return ok();
};
