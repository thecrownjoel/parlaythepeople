import type { APIRoute } from "astro";
import { account, normalEmail, validEmail, createLoginLink, sendLoginEmail } from "../../../lib/auth";
import { orgOf, invite, removeMember } from "../../../lib/team";
import { readJson, bad, ok } from "../auth/_json";
import { sendMail, emailHtml } from "../../../lib/mail";

/** Team owner: POST {email} adds a member (and emails them a sign-in link); POST {remove: user id} removes one. */
export const POST: APIRoute = async ({ request, cookies, url }) => {
	const body = await readJson(request);
	const a = await account(cookies, request);
	const org = await orgOf(a.user);
	if (!a.user || !org) return bad("no_team", 403);
	if (org.owner_id !== a.user.id) return bad("owner_only", 403);
	if (body?.remove) {
		const err = await removeMember(org, String(body.remove));
		return err ? bad(err) : ok();
	}
	const email = normalEmail(String(body?.email ?? ""));
	if (!validEmail(email)) return bad("email");
	const err = await invite(org, email);
	if (err) return bad(err);
	const link = await createLoginLink(url.origin, email, "/account/team/");
	if (link) {
		await sendMail({
			to: email, from: "signin@parlaythepeople.com", subject: `${a.user.email} added you to ${org.name} on Parlay the People`,
			text: `${a.user.email} added you to the ${org.name} team on Parlay the People.\n\nSign in here: ${link}\n\nThe link works once and expires in 15 minutes; after that, sign in at ${url.origin}/account/ with this email.`,
			html: emailHtml(`<p><b>${a.user.email}</b> added you to the <b>${org.name}</b> team on Parlay the People: shared notes, followed races and the AI analyst.</p><p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#a3262a;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Join the team</a></p><p style="color:#666;font-size:13px">The link works once and expires in 15 minutes. After that, sign in at ${url.origin}/account/ with this email.</p>`, url.origin),
		}).catch(() => sendLoginEmail(email, link).catch(() => {}));
	}
	return ok();
};
