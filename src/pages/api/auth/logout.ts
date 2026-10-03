import type { APIRoute } from "astro";
import { endSession } from "../../../lib/auth";
import { readJson, bad, ok } from "./_json";

export const POST: APIRoute = async ({ request, cookies }) => {
	if (!(await readJson(request))) return bad("bad_request");
	await endSession(cookies);
	return ok();
};
