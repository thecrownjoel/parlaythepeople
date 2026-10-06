import type { APIRoute } from "astro";
import { currentUser, anonId } from "../../lib/auth";
import { listComments, postComment, hideComment, reportComment, profileName, setProfileName, validName, normalPage, MAX_LEN } from "../../lib/comments";
import { readJson, bad, ok } from "./auth/_json";

/**
 * Reader discussions (lib/comments.ts).
 *   GET  ?page=/2026/senate/maine/        → {comments, me: {signedIn, name, id} }
 *   POST {page, body, parent?, name?}     → post (a first-time commenter sends their display name with it)
 *   POST {action: "name", name}           → change display name
 *   POST {action: "delete" | "report", id}
 */
export const GET: APIRoute = async ({ url, cookies }) => {
	const page = normalPage(url.searchParams.get("page") ?? "");
	if (!page) return bad("page");
	const [comments, user] = await Promise.all([listComments(page), currentUser(cookies)]);
	const name = user ? await profileName(user.id) : null;
	return Response.json({ comments, me: { signedIn: !!user, name, id: user?.id ?? null }, max: MAX_LEN }, { headers: { "cache-control": "private, no-store" } });
};

export const POST: APIRoute = async ({ request, cookies, locals }) => {
	const body = await readJson(request);
	if (!body) return bad("bad_request");
	const user = await currentUser(cookies);
	const moderator = ((locals as any).user?.role ?? 0) >= 40;
	if (body.action === "report") {
		await reportComment(String(body.id ?? ""), user?.id ?? `a:${await anonId(request)}`);
		return ok();
	}
	if (!user) return bad("sign_in", 401);
	if (body.action === "delete") return (await hideComment(String(body.id ?? ""), { userId: user.id, moderator })) ? ok() : bad("not_allowed", 403);
	if (body.action === "name" || body.name) {
		const name = validName(String(body.name ?? ""));
		if (!name) return bad("name");
		await setProfileName(user.id, name);
		if (body.action === "name") return ok({ name });
	}
	const page = normalPage(String(body.page ?? ""));
	if (!page) return bad("page");
	const r = await postComment({ userId: user.id, page, body: String(body.body ?? ""), parent: body.parent ? String(body.parent) : null });
	if (!r.ok) return bad(r.error, r.error === "slow_down" ? 429 : 400);
	return ok({ comment: r.comment, held: r.held });
};
