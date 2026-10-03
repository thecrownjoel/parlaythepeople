import type { APIRoute } from "astro";
import { currentUser } from "../../../../lib/auth";
import { deletePasskey } from "../../../../lib/passkeys";
import { readJson, bad, ok } from "../_json";

export const POST: APIRoute = async ({ request, cookies }) => {
	const body = await readJson(request);
	const user = await currentUser(cookies);
	if (!user) return bad("signed_out", 401);
	if (typeof body?.id !== "string") return bad("bad_request");
	await deletePasskey(user.id, body.id);
	return ok();
};
