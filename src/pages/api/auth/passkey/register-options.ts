import type { APIRoute } from "astro";
import { currentUser } from "../../../../lib/auth";
import { registrationOptions } from "../../../../lib/passkeys";
import { readJson, bad } from "../_json";

export const POST: APIRoute = async ({ request, url, cookies }) => {
	if (!(await readJson(request))) return bad("bad_request");
	const user = await currentUser(cookies);
	if (!user) return bad("signed_out", 401);
	return Response.json(await registrationOptions(url, cookies, user), { headers: { "cache-control": "no-store" } });
};
