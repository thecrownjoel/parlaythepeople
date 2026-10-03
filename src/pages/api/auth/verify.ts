import type { APIRoute } from "astro";
import { redeemLoginLink, startSession } from "../../../lib/auth";

/** GET ?token= → the link from the sign-in email: starts a session and goes on to where the reader was headed. */
export const GET: APIRoute = async ({ url, cookies, request, redirect }) => {
	const token = url.searchParams.get("token") ?? "";
	const hit = token ? await redeemLoginLink(token) : null;
	if (!hit) return redirect("/account/?error=link", 303);
	await startSession(cookies, hit.user.id, request);
	return redirect(hit.next, 303);
};
