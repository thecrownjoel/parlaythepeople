import type { APIRoute } from "astro";
import { account } from "../../lib/auth";
import { createKey, listKeys, revokeKey } from "../../lib/apikeys";
import { readJson, bad, ok } from "./auth/_json";

/** Data API keys for paid members. GET → {keys}; POST {name} → {key} (shown once); POST {revoke: id}. */
export const GET: APIRoute = async ({ cookies, request }) => {
	const a = await account(cookies, request);
	if (!a.user || !a.plan.proTools) return bad("pro_only", 403);
	return Response.json({ keys: await listKeys(a.subject) }, { headers: { "cache-control": "private, no-store" } });
};
export const POST: APIRoute = async ({ cookies, request }) => {
	const body = await readJson(request);
	const a = await account(cookies, request);
	if (!a.user || !a.plan.proTools) return bad("pro_only", 403);
	if (body?.revoke) return (await revokeKey(a.subject, String(body.revoke))) ? ok() : bad("not_found", 404);
	if ((await listKeys(a.subject)).length >= 10) return bad("too_many");
	return ok(await createKey(a, String(body?.name ?? "")));
};
