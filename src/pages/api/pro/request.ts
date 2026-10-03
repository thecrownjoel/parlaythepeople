import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { currentUser } from "../../../lib/auth";
import { PLANS, type PlanId } from "../../../lib/plans";
import { readJson, bad, ok } from "../auth/_json";

/** POST {plan, org?, note?} from a signed-in reader → recorded in pro_requests for a plan to be granted by hand (no billing yet). */
export const POST: APIRoute = async ({ request, cookies }) => {
	const body = await readJson(request);
	const user = await currentUser(cookies);
	if (!user) return bad("signed_out", 401);
	const plan = String(body?.plan ?? "") as PlanId;
	if (!body || !["pro", "team", "enterprise"].includes(plan) || !PLANS[plan]) return bad("plan");
	const recent = await env.ACCOUNTS.prepare("SELECT COUNT(*) AS n FROM pro_requests WHERE user_id = ? AND ts > ?").bind(user.id, Math.floor(Date.now() / 1000) - 86400).first<{ n: number }>();
	if ((recent?.n ?? 0) >= 3) return ok(); // already asked today
	await env.ACCOUNTS.prepare("INSERT INTO pro_requests (ts, user_id, email, plan, org, note) VALUES (?, ?, ?, ?, ?, ?)")
		.bind(Math.floor(Date.now() / 1000), user.id, user.email, plan, String(body.org ?? "").slice(0, 120) || null, String(body.note ?? "").slice(0, 1000) || null).run();
	return ok();
};
