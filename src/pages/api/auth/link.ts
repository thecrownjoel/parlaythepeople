import type { APIRoute } from "astro";
import { createLoginLink, sendLoginEmail, normalEmail, validEmail } from "../../../lib/auth";
import { readJson, bad, ok } from "./_json";

/** POST {email, next?} → emails a one-time sign-in link. Same answer whether or not the email has an account. */
export const POST: APIRoute = async ({ request, url }) => {
	const body = await readJson(request);
	const email = normalEmail(String(body?.email ?? ""));
	if (!body || !validEmail(email)) return bad("email");
	const link = await createLoginLink(url.origin, email, String(body.next ?? ""));
	if (!link) return bad("too_many", 429);
	const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	try {
		await sendLoginEmail(email, link);
	} catch (e) {
		if (local) return ok({ dev_link: link }); // no mail binding in local dev: hand the link back
		console.error("sign-in email", String(e));
		return bad("email_failed", 503);
	}
	return ok();
};
