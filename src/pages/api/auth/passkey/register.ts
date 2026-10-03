import type { APIRoute } from "astro";
import { currentUser } from "../../../../lib/auth";
import { register } from "../../../../lib/passkeys";
import { readJson, bad, ok } from "../_json";

export const POST: APIRoute = async ({ request, url, cookies }) => {
	const body = await readJson(request);
	if (!body?.response) return bad("bad_request");
	const user = await currentUser(cookies);
	if (!user) return bad("signed_out", 401);
	try {
		const r = await register(url, cookies, user, body.response, String(body.name ?? ""));
		return r.ok ? ok() : bad(r.error!);
	} catch (e) {
		console.error("passkey register", String(e));
		return bad("not_verified");
	}
};
