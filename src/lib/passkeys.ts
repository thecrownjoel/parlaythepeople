/**
 * Passkeys (WebAuthn) for reader accounts, via @simplewebauthn/server. A signed-in reader adds a passkey on
 * /account/; afterwards "Sign in with a passkey" works without email. Challenges live in D1 for 5 minutes,
 * keyed by a random id held in a short-lived cookie.
 */
import type { AstroCookies } from "astro";
import { env } from "cloudflare:workers";
import {
	generateRegistrationOptions, verifyRegistrationResponse,
	generateAuthenticationOptions, verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { randomToken, type User } from "./auth";

const CHALLENGE_COOKIE = "ptp_webauthn";
const db = () => env.ACCOUNTS;
const now = () => Math.floor(Date.now() / 1000);

async function saveChallenge(cookies: AstroCookies, challenge: string, userId: string | null) {
	const id = randomToken(16);
	await db().prepare("DELETE FROM challenges WHERE expires < ?").bind(now()).run();
	await db().prepare("INSERT INTO challenges (id, challenge, user_id, expires) VALUES (?, ?, ?, ?)").bind(id, challenge, userId, now() + 300).run();
	cookies.set(CHALLENGE_COOKIE, id, { path: "/api/auth/", httpOnly: true, secure: true, sameSite: "strict", maxAge: 300 });
}

/** Take (and delete) the challenge this browser was given. */
async function takeChallenge(cookies: AstroCookies) {
	const id = cookies.get(CHALLENGE_COOKIE)?.value;
	cookies.delete(CHALLENGE_COOKIE, { path: "/api/auth/" });
	if (!id) return null;
	return db().prepare("DELETE FROM challenges WHERE id = ? AND expires > ? RETURNING challenge, user_id").bind(id, now()).first<{ challenge: string; user_id: string | null }>();
}

export async function registrationOptions(url: URL, cookies: AstroCookies, user: User) {
	const { results: existing } = await db().prepare("SELECT id, transports FROM passkeys WHERE user_id = ?").bind(user.id).all<{ id: string; transports: string | null }>();
	const options = await generateRegistrationOptions({
		rpName: "Parlay the People",
		rpID: url.hostname,
		userName: user.email,
		userID: new TextEncoder().encode(user.id),
		attestationType: "none",
		excludeCredentials: (existing ?? []).map((p) => ({ id: p.id, transports: (p.transports?.split(",").filter(Boolean) ?? []) as any })),
		authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
	});
	await saveChallenge(cookies, options.challenge, user.id);
	return options;
}

export async function register(url: URL, cookies: AstroCookies, user: User, response: any, name: string) {
	const ch = await takeChallenge(cookies);
	if (!ch || ch.user_id !== user.id) return { ok: false, error: "expired" };
	const v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: url.origin, expectedRPID: url.hostname, requireUserVerification: false });
	if (!v.verified || !v.registrationInfo) return { ok: false, error: "not_verified" };
	const c = v.registrationInfo.credential;
	await db().prepare("INSERT INTO passkeys (id, user_id, public_key, counter, transports, name, created) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.bind(c.id, user.id, isoBase64URL.fromBuffer(c.publicKey), c.counter, (c.transports ?? []).join(","), name.slice(0, 60) || "Passkey", now()).run();
	return { ok: true };
}

export async function authenticationOptions(url: URL, cookies: AstroCookies) {
	// no allowCredentials: the browser offers whichever passkey it holds for this site
	const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "preferred" });
	await saveChallenge(cookies, options.challenge, null);
	return options;
}

/** Verify a passkey sign-in; returns the user id on success. */
export async function authenticate(url: URL, cookies: AstroCookies, response: any): Promise<string | null> {
	const ch = await takeChallenge(cookies);
	if (!ch || typeof response?.id !== "string") return null;
	const pk = await db().prepare("SELECT id, user_id, public_key, counter, transports FROM passkeys WHERE id = ?").bind(response.id).first<{ id: string; user_id: string; public_key: string; counter: number; transports: string | null }>();
	if (!pk) return null;
	const v = await verifyAuthenticationResponse({
		response, expectedChallenge: ch.challenge, expectedOrigin: url.origin, expectedRPID: url.hostname, requireUserVerification: false,
		credential: { id: pk.id, publicKey: isoBase64URL.toBuffer(pk.public_key), counter: pk.counter, transports: (pk.transports?.split(",").filter(Boolean) ?? []) as any },
	});
	if (!v.verified) return null;
	await db().prepare("UPDATE passkeys SET counter = ?, last_used = ? WHERE id = ?").bind(v.authenticationInfo.newCounter, now(), pk.id).run();
	return pk.user_id;
}

export async function listPasskeys(userId: string) {
	const { results } = await db().prepare("SELECT id, name, created, last_used FROM passkeys WHERE user_id = ? ORDER BY created").bind(userId).all<{ id: string; name: string; created: number; last_used: number | null }>();
	return results ?? [];
}

export async function deletePasskey(userId: string, id: string) {
	await db().prepare("DELETE FROM passkeys WHERE user_id = ? AND id = ?").bind(userId, id).run();
}
