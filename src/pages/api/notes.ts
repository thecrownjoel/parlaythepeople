import type { APIRoute } from "astro";
import { account } from "../../lib/auth";
import { canNote, notesFor, addNote, deleteNote, orgOf } from "../../lib/team";
import { readJson, bad, ok } from "./auth/_json";

/**
 * Race notes for paid members, shared with their team. GET ?race=<id> → {notes, me};
 * POST {race, body} adds one; POST {delete: id} removes one (its author or the team owner).
 */
const RACE = /^\d{4}-[a-z0-9-]{2,60}$/;
export const GET: APIRoute = async ({ cookies, request, url }) => {
	const a = await account(cookies, request);
	if (!canNote(a)) return Response.json({ notes: null }, { headers: { "cache-control": "private, no-store" } });
	const race = url.searchParams.get("race") ?? "";
	const notes = await notesFor(a.subject, RACE.test(race) ? race : undefined);
	const org = await orgOf(a.user);
	return Response.json({ notes, me: a.user!.id, owner: org?.owner_id === a.user!.id, team: org?.name ?? null }, { headers: { "cache-control": "private, no-store" } });
};
export const POST: APIRoute = async ({ cookies, request }) => {
	const body = await readJson(request);
	const a = await account(cookies, request);
	if (!canNote(a)) return bad("pro_only", 403);
	if (body?.delete) {
		const org = await orgOf(a.user);
		return (await deleteNote(a, String(body.delete), org?.owner_id === a.user!.id)) ? ok() : bad("not_found", 404);
	}
	const race = String(body?.race ?? ""), text = String(body?.body ?? "").trim();
	if (!RACE.test(race) || !text) return bad("bad_request");
	if (text.length > 4000) return bad("too_long");
	return ok({ id: await addNote(a, race, text) });
};
