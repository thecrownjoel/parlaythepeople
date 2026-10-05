/**
 * Daily briefings and alerts for paid plans, on the races a reader follows (watchlist, synced from the follow button).
 *
 * - Briefing: every morning (11:00 UTC, 7am Eastern) the scheduled handler starts one BriefingWorkflow per eligible
 *   reader. The workflow gathers each followed race's numbers, trade flow and headlines, has the analyst model write a
 *   short brief (one call, no tool loop), emails it and keeps a copy. Charged as AI usage (model cost × AI_MARKUP).
 * - Alerts: every 10 minutes, followed races whose Democratic odds moved at least the reader's threshold in 24 hours,
 *   and single trades of at least their whale size, go out in one email. No model call; free on paid plans.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { accountForUser, charge, settle, price } from "./auth";
import { runTool } from "./ai-tools";
import { aiRun } from "./ai";
import { costUsd, STANDARD_MODEL } from "./plans";
import { racesAt } from "./trends";
import { sendMail, emailHtml } from "./mail";
import { mdToHtml } from "./md";

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const db = () => env.ACCOUNTS;
const ORIGIN = "https://parlaythepeople.com";
const MAX_RACES = 12;

export interface Prefs { briefing: number; alerts: number; move_pts: number; whale_usd: number; webhook?: string | null }
export const DEFAULT_PREFS: Prefs = { briefing: 1, alerts: 1, move_pts: 5, whale_usd: 10000, webhook: null };

export async function prefsFor(userId: string): Promise<Prefs> {
	const q = (cols: string) => db().prepare(`SELECT ${cols} FROM alert_prefs WHERE user_id = ?`).bind(userId).first<Prefs>();
	return (await q("briefing, alerts, move_pts, whale_usd, webhook").catch(() => q("briefing, alerts, move_pts, whale_usd"))) ?? DEFAULT_PREFS;
}

/** A webhook address readers may use: https, and Slack, Discord or any other host that takes a JSON post. */
export const validWebhook = (u: string) => /^https:\/\/[^\s/]+\.[^\s]+$/.test(u) && u.length <= 500;

/** Post alert lines (markdown, **bold**) to a reader's webhook: Slack's format, which Discord also takes at …/slack. */
export async function postWebhook(url: string, title: string, lines: string[]) {
	const discord = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url);
	const target = discord && !url.endsWith("/slack") ? `${url}/slack` : url;
	const text = `*${title}*\n${lines.map((l) => `• ${l.replace(/\*\*(.+?)\*\*/g, "*$1*")}`).join("\n")}\n<${ORIGIN}/account/|Your races on Parlay the People>`;
	const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, alerts: lines.map((l) => l.replace(/\*\*/g, "")) }) });
	if (!res.ok) throw new Error(`webhook ${res.status}`);
}

export async function watchlistFor(userId: string) {
	const { results } = await db().prepare("SELECT race_id, name FROM watchlist WHERE user_id = ? ORDER BY added").bind(userId).all<{ race_id: string; name: string | null }>();
	return results ?? [];
}

/** Readers who follow at least one race and haven't turned `kind` off (plan is checked per reader afterwards). */
async function candidates(kind: "briefing" | "alerts") {
	const { results } = await db().prepare(
		`SELECT DISTINCT w.user_id FROM watchlist w LEFT JOIN alert_prefs p ON p.user_id = w.user_id WHERE COALESCE(p.${kind}, 1) = 1`,
	).all<{ user_id: string }>();
	return (results ?? []).map((r) => r.user_id);
}

// ---- briefing ----

/** Everything the brief is written from, kept small: the model gets numbers, not raw tool dumps. */
async function gather(userId: string) {
	const races = (await watchlistFor(userId)).slice(0, MAX_RACES);
	const since = now() - 36 * 3600;
	const items = [];
	for (const w of races) {
		const d: any = await runTool("race_detail", { race_id: w.race_id }, { pro: true });
		if (d?.error) continue;
		const flow: any = await runTool("trade_flow", { race_id: w.race_id, days: 1 }, { pro: true });
		const names = [d.democrat, d.republican].filter(Boolean).map((n: string) => n.split(/\s+/).pop()!.toLowerCase()).filter((n: string) => n.length > 3);
		let news: { title: string; source: string | null; url: string }[] = [];
		if (names.length) {
			const like = names.map(() => "LOWER(title) LIKE ?").join(" OR ");
			news = (await env.MARKETS.prepare(`SELECT title, source, url FROM news WHERE COALESCE(published, first_seen) >= ? AND (${like}) ORDER BY COALESCE(published, first_seen) DESC LIMIT 4`)
				.bind(since, ...names.map((n: string) => `%${n}%`)).all<any>()).results ?? [];
		}
		items.push({
			race: d.name, url: d.url, democrat: d.democrat, republican: d.republican, odds: d.odds, rating: d.rating,
			kalshi: d.kalshi, polymarket: d.polymarket, parlay_estimate_D: d.parlay_estimate_D,
			democratic_odds_change: d.democratic_odds_change, money_usd: d.money_usd,
			trade_flow_24h: flow?.by_candidate?.slice(0, 4) ?? null, big_trades_24h: flow?.trade_sizes ?? null,
			headlines: news,
		});
	}
	return items;
}

const BRIEF_SYSTEM = `You write the morning briefing for Parlay the People (parlaythepeople.com), an election research site that tracks Kalshi and Polymarket prediction markets. The reader is a campaign staffer, consultant, reporter or trader who follows the races below.

Write in markdown, under 450 words:
- Start with one sentence: the most important change overnight across their races.
- Then one short section per race that matters today, as "### <Race>", with the odds now (Kalshi vs Polymarket when they differ), the 24-hour and 7-day move, where the money went (net buying for or against each candidate), and any headline that explains it, linked.
- Group races where nothing moved into one closing line ("Quiet: …").
Use only the numbers given. Odds are crowd probabilities. Link race pages with their url. Research, not betting advice: never tell anyone to buy or sell.`;

export async function writeBriefing(items: unknown[]) {
	const today = new Date().toISOString().slice(0, 10);
	const res: any = await aiRun(STANDARD_MODEL, {
		messages: [{ role: "system", content: BRIEF_SYSTEM }, { role: "user", content: `Today is ${today}. The reader's races:\n${JSON.stringify(items)}` }],
		// GLM reasons before it writes; leave room for both or the text comes back empty
		max_tokens: 8000, temperature: 0.3,
	}, { feature: "briefing" });
	const choice = res?.choices?.[0];
	const text = String(choice?.message?.content ?? res?.response ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
	// a briefing cut off at the token limit is not sent; the workflow retries it
	if (choice?.finish_reason === "length") return { text: "", tin: res?.usage?.prompt_tokens ?? 0, tout: res?.usage?.completion_tokens ?? 0 };
	if (!text) console.error("empty briefing", JSON.stringify({ finish: choice?.finish_reason, keys: Object.keys(choice?.message ?? res ?? {}), usage: res?.usage }));
	return { text, tin: res?.usage?.prompt_tokens ?? 0, tout: res?.usage?.completion_tokens ?? 0 };
}

/** One reader's briefing, start to finish. Each step is retried on its own by the workflow if it fails. */
export class BriefingWorkflow extends WorkflowEntrypoint<Env, { userId: string; day: number }> {
	async run(event: WorkflowEvent<{ userId: string; day: number }>, step: WorkflowStep) {
		const { userId, day } = event.payload;
		const ready = await step.do("check plan and credits", async () => {
			const a = await accountForUser(userId);
			if (!a?.user || !a.plan.proTools) return { ok: false, why: "not on a paid plan" };
			if (a.left < price(a, "briefing")) return { ok: false, why: "out of credits" };
			const done = await db().prepare("SELECT sent FROM briefings WHERE user_id = ? AND day = ?").bind(userId, day).first<{ sent: number }>();
			if (done?.sent) return { ok: false, why: "already sent" };
			return { ok: true, why: "" };
		});
		if (!ready.ok) return ready;
		const items = await step.do("gather race data", { retries: { limit: 2, delay: "30 seconds" } }, async () => JSON.parse(JSON.stringify(await gather(userId))));
		if (!items.length) return { ok: false, why: "no races" };
		const brief = await step.do("write the briefing", { retries: { limit: 2, delay: "1 minute", backoff: "linear" }, timeout: "5 minutes" }, async () => {
			const a = (await accountForUser(userId))!;
			const event = await charge(a, "briefing", STANDARD_MODEL);
			const w = await writeBriefing(items);
			await settle(a, event, { tin: w.tin, tout: w.tout, cost: costUsd(STANDARD_MODEL, w.tin, w.tout), ok: !!w.text });
			if (!w.text) throw new Error("empty briefing");
			await db().prepare("INSERT INTO briefings (user_id, day, ts, races, body) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, day) DO UPDATE SET ts = excluded.ts, races = excluded.races, body = excluded.body")
				.bind(userId, day, now(), items.length, w.text).run();
			return w.text;
		});
		await step.do("email it", { retries: { limit: 3, delay: "1 minute" } }, async () => {
			const a = await accountForUser(userId);
			if (!a?.user) return;
			const date = new Date(day * DAY * 1000).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
			await sendMail({
				to: a.user.email, from: "briefing@parlaythepeople.com",
				subject: `Your races this morning: ${date}`,
				text: `${brief}\n\nResearch, not betting advice. Change briefings on ${ORIGIN}/account/`,
				html: emailHtml(`<h2 style="margin:0 0 12px;font-size:20px">Your races, ${date}</h2>${mdToHtml(brief, ORIGIN)}`, ORIGIN),
			});
			await db().prepare("UPDATE briefings SET sent = 1 WHERE user_id = ? AND day = ?").bind(userId, day).run();
		});
		return { ok: true, races: items.length };
	}
}

/** Start today's briefing workflows. Instance ids include the day, so a second run the same day is a no-op. */
export async function startBriefings() {
	const day = Math.floor(now() / DAY);
	let started = 0;
	for (const userId of await candidates("briefing")) {
		const a = await accountForUser(userId);
		if (!a?.plan.proTools) continue;
		try {
			await (env as any).BRIEFING.create({ id: `brief-${userId}-${day}`, params: { userId, day } });
			started++;
		} catch (e) {
			if (!String(e).includes("already")) console.error("briefing start", userId, String(e));
		}
	}
	return { started };
}

// ---- alerts ----

const pct = (x: number) => `${Math.round(x * 100)}%`;
const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export async function checkAlerts() {
	const users = await candidates("alerts");
	if (!users.length) return { users: 0, sent: 0 };
	const t = now();
	const [nowAt, dayAgo] = await Promise.all([racesAt(t), racesAt(t - DAY)]);
	const { results: big } = await env.TRADES.prepare("SELECT src, id, race_id, outcome, side, yes_price, usd, ts FROM trades WHERE ts >= ? AND usd >= 1000 ORDER BY usd DESC LIMIT 200").bind(t - 20 * 60).all<any>();
	let sent = 0;
	for (const userId of users) {
		const a = await accountForUser(userId);
		if (!a?.user || !a.plan.proTools) continue;
		const prefs = await prefsFor(userId);
		const watch = await watchlistFor(userId);
		const name = new Map(watch.map((w) => [w.race_id, w.name ?? w.race_id]));
		const lines: { key: string; md: string }[] = [];
		const today = Math.floor(t / DAY);
		for (const w of watch) {
			const n = nowAt.get(w.race_id), b = dayAgo.get(w.race_id);
			if (!n || !b) continue;
			const move = n.D - b.D;
			if (Math.abs(move) * 100 >= prefs.move_pts) lines.push({ key: `move:${w.race_id}:${today}`, md: `**${name.get(w.race_id)}**: Democratic odds ${move > 0 ? "up" : "down"} ${Math.abs(move * 100).toFixed(1)} points in 24 hours, ${pct(b.D)} to ${pct(n.D)}.` });
		}
		for (const tr of big ?? []) {
			if (!name.has(tr.race_id) || tr.usd < prefs.whale_usd) continue;
			lines.push({ key: `whale:${tr.src}:${tr.id}`, md: `**${name.get(tr.race_id)}**: a ${usd(tr.usd)} trade on ${tr.src === "k" ? "Kalshi" : "Polymarket"} (${tr.outcome}, ${tr.side}, Yes at ${Math.round(tr.yes_price * 100)}¢).` });
		}
		// keep only what this reader hasn't been told yet
		const fresh: typeof lines = [];
		for (const l of lines) {
			const r = await db().prepare("INSERT OR IGNORE INTO alerts_sent (user_id, key, ts) VALUES (?, ?, ?)").bind(userId, l.key, t).run();
			if (r.meta.changes) fresh.push(l);
		}
		if (!fresh.length) continue;
		const body = fresh.map((l) => `- ${l.md}`).join("\n");
		if (prefs.webhook) await postWebhook(prefs.webhook, fresh.length === 1 ? "Alert on your races" : `${fresh.length} alerts on your races`, fresh.map((l) => l.md)).catch((e) => console.error("alert webhook", userId, String(e)));
		try {
			await sendMail({
				to: a.user.email, from: "alerts@parlaythepeople.com",
				subject: fresh.length === 1 ? `Alert: ${fresh[0].md.replace(/\*\*/g, "").split(":")[0]}` : `${fresh.length} alerts on your races`,
				text: `${body.replace(/\*\*/g, "")}\n\nYour races: ${ORIGIN}/account/`,
				html: emailHtml(`<h2 style="margin:0 0 12px;font-size:20px">On your races</h2>${mdToHtml(body, ORIGIN)}<p><a href="${ORIGIN}/ai/">Ask the analyst why</a></p>`, ORIGIN),
			});
			sent++;
		} catch (e) {
			console.error("alert email", userId, String(e));
			// let the next run try again
			for (const l of fresh) await db().prepare("DELETE FROM alerts_sent WHERE user_id = ? AND key = ?").bind(userId, l.key).run();
		}
	}
	await db().prepare("DELETE FROM alerts_sent WHERE ts < ?").bind(t - 14 * DAY).run();
	return { users: users.length, sent };
}
