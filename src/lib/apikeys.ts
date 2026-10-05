/** Data API keys for paid plans: "Authorization: Bearer ptp_…" opens the same data a signed-in member gets. */
import { env } from "cloudflare:workers";
import { randomToken, sha256, type Account } from "./auth";
import { PLANS, type Plan, type PlanId } from "./plans";

const db = () => env.ACCOUNTS;
const now = () => Math.floor(Date.now() / 1000);
export interface ApiKey { id: string; name: string | null; created: number; last_used: number | null; email: string }

export async function createKey(a: Account, name: string) {
	const key = `ptp_${randomToken(24)}`, id = randomToken(6);
	await db().prepare("INSERT INTO api_keys (hash, id, subject, user_id, name, created) VALUES (?, ?, ?, ?, ?, ?)").bind(await sha256(key), id, a.subject, a.user!.id, name.slice(0, 60) || null, now()).run();
	return { key, id };
}
export async function listKeys(subject: string): Promise<ApiKey[]> {
	return (await db().prepare("SELECT k.id, k.name, k.created, k.last_used, u.email FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.subject = ? AND k.revoked = 0 ORDER BY k.created DESC").bind(subject).all<ApiKey>()).results ?? [];
}
export async function revokeKey(subject: string, id: string) {
	return (await db().prepare("UPDATE api_keys SET revoked = 1 WHERE subject = ? AND id = ?").bind(subject, id).run()).meta.changes > 0;
}

/** The plan a request's API key opens, or null when there's no key (a bad or revoked key is the free plan). */
export async function planFromKey(request: Request): Promise<Plan | null> {
	const m = /^Bearer\s+(ptp_[A-Za-z0-9_-]{20,})$/.exec(request.headers.get("authorization") ?? "");
	if (!m) return null;
	try {
		const hash = await sha256(m[1]);
		const k = await db().prepare("SELECT subject, last_used FROM api_keys WHERE hash = ? AND revoked = 0").bind(hash).first<{ subject: string; last_used: number | null }>();
		if (!k) return PLANS.free;
		if (!k.last_used || now() - k.last_used > 3600) await db().prepare("UPDATE api_keys SET last_used = ? WHERE hash = ?").bind(now(), hash).run();
		const sub = await db().prepare("SELECT plan, status FROM subscriptions WHERE subject = ?").bind(k.subject).first<{ plan: PlanId; status: string }>();
		return sub && (sub.status === "active" || sub.status === "trialing") && PLANS[sub.plan] ? PLANS[sub.plan] : PLANS.free;
	} catch {
		return PLANS.free;
	}
}
