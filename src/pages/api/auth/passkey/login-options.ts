import type { APIRoute } from "astro";
import { authenticationOptions } from "../../../../lib/passkeys";
import { readJson, bad } from "../_json";

export const POST: APIRoute = async ({ request, url, cookies }) => {
	if (!(await readJson(request))) return bad("bad_request");
	return Response.json(await authenticationOptions(url, cookies), { headers: { "cache-control": "no-store" } });
};
