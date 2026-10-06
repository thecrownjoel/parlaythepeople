/**
 * Story signals, collected hourly: what in our own data (and on the calendar) is news right now. Each signal carries
 * the beats and state it belongs to, and a score from 0 to 100 (size of the move or money, recency). News headlines
 * are matched per writer at assignment time (desk.ts), since what counts as news depends on the writer's beat and place.
 */
import { env } from "cloudflare:workers";
import { getIndex, getCycle, consensus, candidate, officeTitle, type Race } from "../markets";
import { moversSince, leadChangesSince } from "../trends";
import { moneySince, biggestTrades } from "../money";
import { calendar } from "../calendar";
import { allRatings, expertScore, marketScore, scoreWord, FORECASTERS } from "../ratings";
import { db, now, DAY } from "./writers";

export interface Signal { id: string; kind: string; key: string | null; title: string; data: Record<string, unknown>; score: number; geography: string; beats: string[] }

const pts = (x: number) => `${Math.abs(x * 100).toFixed(1)} points`;
const raceBeats = (r: Race) => [r.kind, "markets"];
const day = () => Math.floor(now() / DAY);

export async function collectSignals(): Promise<Signal[]> {
	const index = await getIndex();
	const data = index ? await getCycle(index.next) : null;
	if (!data) return [];
	const t = now();
	const out: Signal[] = [];
	const byId = new Map(data.races.map((r) => [r.id, r]));
	const raceData = (r: Race) => ({ race_id: r.id, race: officeTitle(r), url: `https://parlaythepeople.com${r.path}`, democrat: candidate(r, "D"), republican: candidate(r, "R"), odds_D: Math.round(consensus(r).D * 1000) / 1000 });

	// odds moves over 24 hours (3+ points; each writer applies their own threshold)
	for (const m of await moversSince(data, t - DAY, 25)) {
		if (Math.abs(m.delta) < 0.03) continue;
		const who = m.delta > 0 ? "Democrats" : "Republicans";
		out.push({
			id: `move:${m.race.id}:${day()}`, kind: "move", key: m.race.id, geography: m.race.st, beats: raceBeats(m.race),
			title: `${officeTitle(m.race)}: odds swing ${pts(m.delta)} toward ${who} in a day`,
			data: { ...raceData(m.race), from: m.from, to: m.to, delta: m.delta, move_pts: Math.abs(m.delta * 100) },
			score: Math.min(100, 40 + Math.abs(m.delta) * 400),
		});
	}
	// favorite flips over a week
	for (const f of await leadChangesSince(data, t - 7 * DAY, 10)) {
		out.push({
			id: `flip:${f.race.id}:${Math.floor(day() / 7)}`, kind: "flip", key: f.race.id, geography: f.race.st, beats: raceBeats(f.race),
			title: `${officeTitle(f.race)}: ${f.who ?? (f.nowLeader === "D" ? "the Democrat" : "the Republican")} is now the favorite`,
			data: { ...raceData(f.race), from: f.from, to: f.to, now_leader: f.nowLeader, move_pts: Math.abs((f.to - f.from) * 100) },
			score: 85,
		});
	}
	// money pouring into a race (24 hours)
	try {
		const money = [...(await moneySince(t - DAY))].sort((a, b) => b[1].usd - a[1].usd).slice(0, 8);
		for (const [id, mo] of money) {
			const r = byId.get(id);
			if (!r || mo.usd < 100_000) continue;
			out.push({
				id: `money:${id}:${day()}`, kind: "money", key: id, geography: r.st, beats: ["money", ...raceBeats(r)],
				title: `${officeTitle(r)}: $${Math.round(mo.usd / 1000).toLocaleString("en-US")}K traded in a day`,
				data: { ...raceData(r), usd_24h: Math.round(mo.usd), trades: mo.n, money_usd: mo.usd }, score: Math.min(95, 35 + Math.log10(mo.usd) * 8),
			});
		}
		for (const b of await biggestTrades(t - DAY, 5)) {
			const r = byId.get(b.race_id);
			if (!r || b.usd < 25_000) continue;
			out.push({
				id: `whale:${b.src}:${b.race_id}:${b.ts}`, kind: "whale", key: b.race_id, geography: r.st, beats: ["money", "markets", r.kind],
				title: `${officeTitle(r)}: a $${Math.round(b.usd).toLocaleString("en-US")} bet on ${b.src === "k" ? "Kalshi" : "Polymarket"}`,
				data: { ...raceData(r), exchange: b.src === "k" ? "Kalshi" : "Polymarket", contract: b.outcome, side: b.side, yes_price: b.yes_price, usd: Math.round(b.usd), money_usd: b.usd },
				score: Math.min(90, 40 + Math.log10(b.usd) * 7),
			});
		}
	} catch (e) { console.error("newsroom money signals", String(e)); }

	// new polls that disagree with the market (fieldwork ended in the last 4 days)
	try {
		const since = new Date((t - 4 * DAY) * 1000).toISOString().slice(0, 10);
		const { results } = await env.MARKETS.prepare("SELECT race_id, pollster, end_date, d, r, d_name, r_name, sample, pop FROM polls WHERE end_date >= ? ORDER BY end_date DESC LIMIT 60").bind(since).all<any>();
		for (const p of results ?? []) {
			const r = byId.get(p.race_id);
			if (!r) continue;
			const pollD = p.d / Math.max(0.01, p.d + p.r);
			const gap = Math.abs(pollD - consensus(r).D) * 100;
			out.push({
				id: `poll:${p.race_id}:${p.pollster}:${p.end_date}`.slice(0, 200), kind: "poll", key: p.race_id, geography: r.st, beats: ["polls", r.kind],
				title: `${officeTitle(r)}: new ${p.pollster} poll, ${p.d_name} ${Math.round(p.d * 100)}–${p.r_name} ${Math.round(p.r * 100)}`,
				data: { ...raceData(r), pollster: p.pollster, end_date: p.end_date, poll_d: p.d, poll_r: p.r, sample: p.sample, pop: p.pop, poll_gap_pts: gap },
				score: Math.min(90, 30 + gap * 3),
			});
		}
	} catch (e) { console.error("newsroom poll signals", String(e)); }

	// the forecasters: Cook / Sabato / Inside Elections rating changes, and races where the experts and the markets split
	try {
		const ratings = await allRatings();
		for (const [id, r] of ratings) {
			const race = byId.get(id);
			if (!race) continue;
			for (const f of Object.values(r)) {
				if (!f?.changed || f.changed < t - 2 * DAY || !f.previous) continue;
				out.push({
					id: `rating:${id}:${f.source}:${f.rating}`.slice(0, 200), kind: "rating", key: id, geography: race.st, beats: [race.kind, "polls", "markets"],
					title: `${officeTitle(race)}: ${FORECASTERS[f.source].name} moves it from ${f.previous} to ${f.rating}`,
					data: { ...raceData(race), forecaster: FORECASTERS[f.source].name, from: f.previous, to: f.rating, as_of: f.as_of, link: FORECASTERS[f.source].url },
					score: 70 + Math.min(20, Math.abs((f.score ?? 0)) * 5),
				});
			}
			const exp = expertScore(r);
			const c = consensus(race), pD = c.D / Math.max(0.01, c.D + c.R), mkt = marketScore(pD);
			if (exp != null && (Math.abs(exp - mkt) >= 2 || (exp * mkt < 0 && Math.abs(exp - mkt) >= 1))) {
				out.push({
					id: `split:${id}:${Math.floor(day() / 7)}`, kind: "split", key: id, geography: race.st, beats: [race.kind, "polls", "markets"],
					title: `${officeTitle(race)}: the forecasters say ${scoreWord(Math.round(exp))}, the markets say ${scoreWord(mkt)}`,
					data: { ...raceData(race), experts: Object.values(r).map((x) => ({ forecaster: FORECASTERS[x!.source].name, rating: x!.rating, as_of: x!.as_of })), market_two_party_D: pD },
					score: Math.min(90, 50 + Math.abs(exp - mkt) * 10),
				});
			}
		}
	} catch (e) { console.error("newsroom rating signals", String(e)); }

	// the calendar: what's coming in the next three days
	try {
		const soon = await calendar(new Date().toISOString().slice(0, 10), 3);
		for (const e of soon.filter((x) => x.kind !== "markets")) {
			out.push({
				id: `cal:${e.date}:${e.title}`.slice(0, 200), kind: "calendar", key: e.st ?? null, geography: e.st ?? "US", beats: e.kind === "report" ? ["money"] : ["voting", "senate", "house", "governor"],
				title: `Coming up ${e.date}: ${e.title}`, data: { ...e, official_source: e.url ?? null }, score: e.kind === "election" ? 95 : 45,
			});
		}
	} catch (e) { console.error("newsroom calendar signals", String(e)); }

	return out;
}

/** Collect and store this hour's signals (new ones only; an existing id keeps its first-seen time). */
export async function refreshSignals() {
	const signals = await collectSignals();
	let added = 0;
	for (const s of signals) {
		const r = await db().prepare("INSERT OR IGNORE INTO newsroom_signals (id, kind, key, title, data, score, geography, beats, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.bind(s.id, s.kind, s.key, s.title, JSON.stringify(s.data), s.score, s.geography, JSON.stringify(s.beats), now()).run();
		added += r.meta.changes ?? 0;
	}
	await db().prepare("DELETE FROM newsroom_signals WHERE seen_at < ?").bind(now() - 30 * DAY).run();
	return { found: signals.length, added };
}

export async function recentSignals(hours = 24): Promise<Signal[]> {
	const { results } = await db().prepare("SELECT * FROM newsroom_signals WHERE seen_at >= ? ORDER BY score DESC LIMIT 200").bind(now() - hours * 3600).all<any>();
	return (results ?? []).map((r) => ({ ...r, data: JSON.parse(r.data || "{}"), beats: JSON.parse(r.beats || "[]") }));
}
