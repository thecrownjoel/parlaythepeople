import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { currentUser } from "../../lib/auth";
import { validWebhook, postWebhook } from "../../lib/briefing";
import { readJson, bad, ok } from "./auth/_json";

/** POST {briefing, alerts, move_pts, whale_usd, webhook} → saves a reader's briefing and alert settings. POST {test_webhook: url} sends a test. */
export const POST: APIRoute = async ({ request, cookies }) => {
	const body = await readJson(request);
	const user = await currentUser(cookies);
	if (!user) return bad("signed_out", 401);
	if (!body) return bad("bad_request");
	if (body.test_webhook) {
		const url = String(body.test_webhook).trim();
		if (!validWebhook(url)) return bad("webhook");
		try { await postWebhook(url, "Parlay the People is connected", ["Alerts on the races you follow will appear here."]); } catch { return bad("webhook_failed", 502); }
		return ok();
	}
	const hook = String(body.webhook ?? "").trim();
	if (hook && !validWebhook(hook)) return bad("webhook");
	const move = Math.min(50, Math.max(1, Number(body.move_pts) || 5));
	const whale = Math.min(1_000_000, Math.max(1000, Number(body.whale_usd) || 10000));
	await env.ACCOUNTS.prepare("INSERT INTO alert_prefs (user_id, briefing, alerts, move_pts, whale_usd, webhook, updated) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET briefing = excluded.briefing, alerts = excluded.alerts, move_pts = excluded.move_pts, whale_usd = excluded.whale_usd, webhook = excluded.webhook, updated = excluded.updated")
		.bind(user.id, body.briefing ? 1 : 0, body.alerts ? 1 : 0, move, whale, hook || null, Math.floor(Date.now() / 1000)).run();
	return ok();
};
