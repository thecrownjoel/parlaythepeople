import type { APIRoute } from "astro";
import { startSession, safeNext } from "../../../../lib/auth";
import { authenticate } from "../../../../lib/passkeys";
import { readJson, bad, ok } from "../_json";

export const POST: APIRoute = async ({ request, url, cookies }) => {
	const body = await readJson(request);
	if (!body?.response) return bad("bad_request");
	let userId: string | null = null;
	try { userId = await authenticate(url, cookies, body.response); } catch (e) { console.error("passkey login", String(e)); }
	if (!userId) return bad("not_verified", 401);
	await startSession(cookies, userId, request);
	return ok({ next: safeNext(body.next) });
};
