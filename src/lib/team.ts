/**
 * Teams (orgs in ingest/accounts_schema.sql): one plan, one AI balance, shared notes and a shared view of everyone's
 * followed races. The owner invites and removes members, up to the plan's seats.
 */
import { env } from "cloudflare:workers";
import { randomToken, type Account, type User } from "./auth";

const db = () => env.ACCOUNTS;
const now = () => Math.floor(Date.now() / 1000);

export interface Org { id: string; name: string; owner_id: string; seats: number; created: number }
export interface Member { id: string; email: string; created: number; last_seen: number | null }

export async function orgOf(user: User | null): Promise<Org | null> {
	if (!user?.org_id) return null;
	return db().prepare("SELECT id, name, owner_id, seats, created FROM orgs WHERE id = ?").bind(user.org_id).first<Org>();
}
export async function members(orgId: string): Promise<Member[]> {
	return (await db().prepare("SELECT id, email, created, last_seen FROM users WHERE org_id = ? ORDER BY created").bind(orgId).all<Member>()).results ?? [];
}

/** Add someone to the team by email (creating their account if needed). Returns an error code or null. */
export async function invite(org: Org, email: string): Promise<string | null> {
	if ((await members(org.id)).length >= org.seats) return "seats_full";
	await db().prepare("INSERT INTO users (id, email, created, last_seen) VALUES (?, ?, ?, NULL) ON CONFLICT(email) DO NOTHING").bind(randomToken(12), email, now()).run();
	const u = await db().prepare("SELECT id, org_id FROM users WHERE email = ?").bind(email).first<{ id: string; org_id: string | null }>();
	if (!u) return "failed";
	if (u.org_id === org.id) return "already_member";
	if (u.org_id) return "other_team";
	await db().prepare("UPDATE users SET org_id = ? WHERE id = ?").bind(org.id, u.id).run();
	return null;
}
export async function removeMember(org: Org, userId: string): Promise<string | null> {
	if (userId === org.owner_id) return "owner";
	const r = await db().prepare("UPDATE users SET org_id = NULL WHERE id = ? AND org_id = ?").bind(userId, org.id).run();
	return r.meta.changes ? null : "not_member";
}

/** Every race anyone on the team follows, with who follows it. */
export async function teamWatchlist(orgId: string) {
	const { results } = await db().prepare("SELECT w.race_id, MAX(w.name) AS name, GROUP_CONCAT(u.email, ', ') AS who, COUNT(*) AS n FROM watchlist w JOIN users u ON u.id = w.user_id WHERE u.org_id = ? GROUP BY w.race_id ORDER BY n DESC, MAX(w.added) DESC")
		.bind(orgId).all<{ race_id: string; name: string | null; who: string; n: number }>();
	return results ?? [];
}

// ---- notes ----
export interface Note { id: string; race_id: string; user_id: string; email: string; body: string; ts: number }
/** Notes are for paid plans: the team's shared notes, or a solo member's own. */
export const canNote = (a: Account) => !!a.user && !!a.plan.proTools;
export async function notesFor(subject: string, raceId?: string, limit = 50): Promise<Note[]> {
	const q = raceId
		? db().prepare("SELECT n.id, n.race_id, n.user_id, u.email, n.body, n.ts FROM race_notes n JOIN users u ON u.id = n.user_id WHERE n.subject = ? AND n.race_id = ? ORDER BY n.ts DESC LIMIT ?").bind(subject, raceId, limit)
		: db().prepare("SELECT n.id, n.race_id, n.user_id, u.email, n.body, n.ts FROM race_notes n JOIN users u ON u.id = n.user_id WHERE n.subject = ? ORDER BY n.ts DESC LIMIT ?").bind(subject, limit);
	return (await q.all<Note>()).results ?? [];
}
export async function addNote(a: Account, raceId: string, body: string) {
	const id = randomToken(9);
	await db().prepare("INSERT INTO race_notes (id, subject, race_id, user_id, body, ts) VALUES (?, ?, ?, ?, ?, ?)").bind(id, a.subject, raceId, a.user!.id, body, now()).run();
	return id;
}
/** Delete a note: its author, or the team owner. */
export async function deleteNote(a: Account, id: string, isOwner: boolean) {
	const r = isOwner
		? await db().prepare("DELETE FROM race_notes WHERE id = ? AND subject = ?").bind(id, a.subject).run()
		: await db().prepare("DELETE FROM race_notes WHERE id = ? AND subject = ? AND user_id = ?").bind(id, a.subject, a.user!.id).run();
	return r.meta.changes > 0;
}
