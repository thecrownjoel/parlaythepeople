/**
 * Reader accounts: sign in with a one-time email link or a passkey; a signed-in browser holds a session
 * cookie. Tokens are random; only their SHA-256 hashes are stored (D1 binding ACCOUNTS, ingest/accounts_schema.sql).
 * This is separate from EmDash's own login, which is for the people who run the site.
 */
import type { AstroCookies } from "astro";
import { env } from "cloudflare:workers";
import { sendMail } from "./mail";
import { PLANS, TYPICAL_CENTS, chargeCents, type Plan, type PlanId, type Metered } from "./plans";

const DAY = 86400;
const SESSION_DAYS = 30;
const LINK_MINUTES = 15;
export const SESSION_COOKIE = "ptp_session";

export interface User { id: string; email: string; org_id: string | null }
export interface Account {
	user: User | null;
	plan: Plan;
	/** who is billed: 'u:<id>', 'o:<org id>' or 'a:<hashed ip>' */
	subject: string;
	/** paid plans: AI cents left (monthly allowance left + AI balance); daily plans: questions left today */
	left: number;
	/** paid plans: when the monthly AI allowance resets; daily plans: midnight UTC */
	resets: number | null;
	/** paid plans: the current period's start, the allowance left and the AI balance, all in cents */
	periodStart?: number;
	allowanceLeft?: number;
	balance?: number;
}

const db = () => env.ACCOUNTS;
const now = () => Math.floor(Date.now() / 1000);

export function randomToken(bytes = 32) {
	const b = crypto.getRandomValues(new Uint8Array(bytes));
	return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function sha256(s: string) {
	const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Anonymous visitor id: a hash of the IP, the same scheme the analyst has always used for its free limit. */
export async function anonId(request: Request) {
	return (await sha256(`parlay:${request.headers.get("cf-connecting-ip") ?? "unknown"}`)).slice(0, 24);
}

export const normalEmail = (s: string) => s.trim().toLowerCase();
export const validEmail = (s: string) => /^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}$/i.test(s) && s.length <= 254;
/** Only same-site paths are allowed as a post-sign-in destination. */
export const safeNext = (s: string | null | undefined) => (s && /^\/(?!\/)[^\s\\]*$/.test(s) ? s : "/account/");

// ---- sign-in links ----

/** Create a one-time link for this email. Returns null when the email has asked for too many links. */
export async function createLoginLink(origin: string, email: string, next: string) {
	const recent = await db().prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND expires > ?").bind(email, now() - 45 * 60).first<{ n: number }>();
	if ((recent?.n ?? 0) >= 5) return null;
	const token = randomToken();
	await db().prepare("INSERT INTO login_tokens (hash, email, expires, next) VALUES (?, ?, ?, ?)").bind(await sha256(token), email, now() + LINK_MINUTES * 60, safeNext(next)).run();
	return `${origin}/api/auth/verify?token=${encodeURIComponent(token)}`;
}

/** Use a link: returns the user (created on first sign-in) and where to go, or null if the link is bad, used or expired. */
export async function redeemLoginLink(token: string) {
	const hash = await sha256(token);
	// mark used in the same statement that checks it, so a link can't be redeemed twice in a race
	const row = await db().prepare("UPDATE login_tokens SET used = 1 WHERE hash = ? AND used = 0 AND expires > ? RETURNING email, next").bind(hash, now()).first<{ email: string; next: string | null }>();
	if (!row) return null;
	const user = await userByEmail(row.email, true);
	return { user: user!, next: safeNext(row.next) };
}

export async function userByEmail(email: string, create = false): Promise<User | null> {
	const found = await db().prepare("SELECT id, email, org_id FROM users WHERE email = ?").bind(email).first<User>();
	if (found || !create) return found;
	const id = randomToken(12);
	await db().prepare("INSERT INTO users (id, email, created, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING").bind(id, email, now(), now()).run();
	return db().prepare("SELECT id, email, org_id FROM users WHERE email = ?").bind(email).first<User>();
}

export async function sendLoginEmail(to: string, link: string) {
	await sendMail({
		to,
		from: "signin@parlaythepeople.com",
		subject: "Your sign-in link for Parlay the People",
		text: `Sign in to Parlay the People:\n\n${link}\n\nThe link works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.`,
		html: `<p>Sign in to Parlay the People:</p><p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#a3262a;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Sign in</a></p><p style="color:#666;font-size:13px">The link works once and expires in ${LINK_MINUTES} minutes. If you didn't ask for it, ignore this email.</p>`,
	});
}

// ---- sessions ----

export async function startSession(cookies: AstroCookies, userId: string, request: Request) {
	const token = randomToken();
	await db().prepare("INSERT INTO sessions (hash, user_id, created, expires, ua) VALUES (?, ?, ?, ?, ?)")
		.bind(await sha256(token), userId, now(), now() + SESSION_DAYS * DAY, (request.headers.get("user-agent") ?? "").slice(0, 200)).run();
	await db().prepare("UPDATE users SET last_seen = ? WHERE id = ?").bind(now(), userId).run();
	cookies.set(SESSION_COOKIE, token, { path: "/", httpOnly: true, secure: true, sameSite: "lax", maxAge: SESSION_DAYS * DAY });
}

export async function endSession(cookies: AstroCookies) {
	const token = cookies.get(SESSION_COOKIE)?.value;
	if (token) await db().prepare("DELETE FROM sessions WHERE hash = ?").bind(await sha256(token)).run();
	cookies.delete(SESSION_COOKIE, { path: "/" });
}

export async function currentUser(cookies: AstroCookies): Promise<User | null> {
	const token = cookies.get(SESSION_COOKIE)?.value;
	if (!token) return null;
	try {
		return await db().prepare("SELECT u.id, u.email, u.org_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires > ?")
			.bind(await sha256(token), now()).first<User>();
	} catch {
		return null; // accounts database unavailable: treat as signed out
	}
}

// ---- plans and metering ----

interface Sub { plan: PlanId; status: string; period_start: number; period_end: number; extra_credits: number }

/** The current monthly credit period of a subscription: periods roll forward from period_start in 30-day steps. */
function period(sub: Sub) {
	const len = Math.max(DAY, sub.period_end - sub.period_start);
	const k = Math.max(0, Math.floor((now() - sub.period_start) / len));
	return { start: sub.period_start + k * len, end: sub.period_start + (k + 1) * len };
}

export async function account(cookies: AstroCookies, request: Request): Promise<Account> {
	const user = await currentUser(cookies);
	if (!user) {
		const today = Math.floor(now() / DAY) * DAY;
		const subject = `a:${await anonId(request)}`;
		const used = await usedSince(subject, today);
		return { user: null, plan: PLANS.anon, subject, left: Math.max(0, PLANS.anon.daily! - used.n), resets: today + DAY };
	}
	return accountOf(user);
}

/** A signed-in user's plan and what's left, without a request (briefings and alerts run on a schedule). */
export async function accountForUser(userId: string): Promise<Account | null> {
	const user = await db().prepare("SELECT id, email, org_id FROM users WHERE id = ?").bind(userId).first<User>();
	return user ? accountOf(user) : null;
}

async function accountOf(user: User): Promise<Account> {
	const today = Math.floor(now() / DAY) * DAY;
	const subject = user.org_id ? `o:${user.org_id}` : `u:${user.id}`;
	const sub = await db().prepare("SELECT plan, status, period_start, period_end, extra_credits FROM subscriptions WHERE subject = ?").bind(subject).first<Sub>();
	const plan = sub && (sub.status === "active" || sub.status === "trialing") && PLANS[sub.plan] ? PLANS[sub.plan] : PLANS.free;
	if (plan.aiAllowance == null) {
		const used = await usedSince(subject, today);
		return { user, plan, subject, left: Math.max(0, plan.daily! - used.n), resets: today + DAY };
	}
	const p = period(sub!);
	const used = await usedSince(subject, p.start);
	const allowanceLeft = Math.max(0, plan.aiAllowance - used.credits);
	const balance = Math.max(0, sub!.extra_credits ?? 0);
	return { user, plan, subject, left: allowanceLeft + balance, resets: p.end, periodStart: p.start, allowanceLeft, balance };
}

async function usedSince(subject: string, since: number) {
	const r = await db().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(credits), 0) AS credits FROM usage_events WHERE subject = ? AND ts >= ? AND (ok IS NULL OR ok = 1)").bind(subject, since).first<{ n: number; credits: number }>();
	return { n: r?.n ?? 0, credits: r?.credits ?? 0 };
}

const paid = (a: Account) => a.plan.aiAllowance != null;

/** What an action needs to start: one question on daily plans; its typical price in cents on paid plans. */
export const price = (a: Account, action: Metered) => (paid(a) ? TYPICAL_CENTS[action] : 1);

/** Record an action before running it (holding its typical price, so a burst of parallel requests can't overspend). */
export async function charge(a: Account, action: Metered, model: string) {
	const r = await db().prepare("INSERT INTO usage_events (ts, subject, user_id, action, credits, model, ok) VALUES (?, ?, ?, ?, ?, ?, NULL)")
		.bind(now(), a.subject, a.user?.id ?? null, action, price(a, action), model).run();
	return r.meta.last_row_id;
}

/**
 * Settle an action once it's done. Daily plans: the question counts unless it failed. Paid plans: charge the real
 * model cost × markup in cents (nothing if it failed), from the monthly allowance first and then the AI balance.
 */
export async function settle(a: Account, rowid: number, o: { tin: number; tout: number; cost: number; ok: boolean }): Promise<number> {
	const cents = paid(a) ? (o.ok ? chargeCents(o.cost) : 0) : o.ok ? 1 : 0;
	await db().prepare("UPDATE usage_events SET input_tokens = ?, output_tokens = ?, cost_usd = ?, ok = ?, credits = ? WHERE rowid = ?")
		.bind(o.tin, o.tout, Math.round(o.cost * 1e6) / 1e6, o.ok ? 1 : 0, cents, rowid).run();
	if (!paid(a) || !cents) return cents;
	// how much of this charge the monthly allowance didn't cover comes off the balance
	const before = await db().prepare("SELECT COALESCE(SUM(credits), 0) AS c FROM usage_events WHERE subject = ? AND ts >= ? AND rowid != ? AND (ok IS NULL OR ok = 1)")
		.bind(a.subject, a.periodStart ?? 0, rowid).first<{ c: number }>();
	const allowance = a.plan.aiAllowance ?? 0, used = before?.c ?? 0;
	const overflow = Math.max(0, used + cents - allowance) - Math.max(0, used - allowance);
	if (overflow > 0) await db().prepare("UPDATE subscriptions SET extra_credits = MAX(0, extra_credits - ?), updated = ? WHERE subject = ?").bind(overflow, now(), a.subject).run();
	return cents;
}

/** The viewer's plan only (no usage queries): for gating history, the archive and downloads. An API key
 *  (Authorization: Bearer ptp_…) counts as its plan's member. */
export async function viewerPlan(cookies: AstroCookies, request?: Request): Promise<Plan> {
	if (request?.headers.has("authorization")) {
		const { planFromKey } = await import("./apikeys");
		const p = await planFromKey(request);
		if (p) return p;
	}
	if (!cookies.get(SESSION_COOKIE)) return PLANS.anon;
	const user = await currentUser(cookies);
	if (!user) return PLANS.anon;
	const subject = user.org_id ? `o:${user.org_id}` : `u:${user.id}`;
	try {
		const sub = await db().prepare("SELECT plan, status FROM subscriptions WHERE subject = ?").bind(subject).first<{ plan: PlanId; status: string }>();
		return sub && (sub.status === "active" || sub.status === "trialing") && PLANS[sub.plan] ? PLANS[sub.plan] : PLANS.free;
	} catch {
		return PLANS.free;
	}
}
