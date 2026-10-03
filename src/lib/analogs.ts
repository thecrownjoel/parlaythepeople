/**
 * Race analogs (Pro): every race's Democratic odds, cut into 32-day windows, stored as 32-number vectors in
 * Vectorize (index race-analogs, binding ANALOGS, euclidean). Each window remembers what happened over the
 * 32 days after it. Asking "which races moved like this one?" embeds the race's last 32 days and returns the
 * nearest windows from other races, with what came next: the closest thing we have to a base rate until
 * races start settling.
 *
 * Rebuilt weekly by the scheduled handler (src/worker.ts) and on demand at POST /api/internal/analogs.
 */
import { env } from "cloudflare:workers";

export const WINDOW = 32; // days; Vectorize's minimum dimension count
const DAY = 86400;

/** Two-party Democratic share per day for each race (the average of the exchanges that list it). */
async function dailyD(raceIds: string[]): Promise<Map<string, Map<number, number>>> {
	const out = new Map<string, Map<number, number>>();
	const marks = raceIds.map(() => "?").join(",");
	const { results } = await env.MARKETS.prepare(
		`SELECT race_id, ts / 86400 AS day,
		        AVG(CASE WHEN k_d + k_r > 0 THEN k_d / (k_d + k_r) END) AS kd,
		        AVG(CASE WHEN p_d + p_r > 0 THEN p_d / (p_d + p_r) END) AS pd
		   FROM race_history WHERE race_id IN (${marks}) GROUP BY race_id, day`,
	).bind(...raceIds).all<{ race_id: string; day: number; kd: number | null; pd: number | null }>();
	for (const r of results ?? []) {
		const v = r.kd != null && r.pd != null ? (r.kd + r.pd) / 2 : r.kd ?? r.pd;
		if (v == null) continue;
		const m = out.get(r.race_id) ?? new Map<number, number>();
		m.set(r.day, v);
		out.set(r.race_id, m);
	}
	return out;
}

/** The race's odds on each of the WINDOW days ending at `end` (gaps carry the last known value). Null if too sparse. */
export function windowAt(days: Map<number, number>, end: number): number[] | null {
	const vals: number[] = [];
	let last: number | undefined;
	// seed with the most recent value before the window
	for (let d = end - WINDOW; d > end - WINDOW - 14 && last === undefined; d--) last = days.get(d);
	let seen = 0;
	for (let d = end - WINDOW + 1; d <= end; d++) {
		const v = days.get(d);
		if (v != null) { last = v; seen++; }
		if (last === undefined) return null;
		vals.push(Math.round(last * 1000) / 1000);
	}
	return seen >= WINDOW * 0.6 ? vals : null;
}

/** Rebuild the index: non-overlapping windows stepping back from each race's latest day. */
export async function buildAnalogs() {
	const { results: races } = await env.MARKETS.prepare("SELECT id, cycle, kind FROM races WHERE kind != 'control'").all<{ id: string; cycle: number; kind: string }>();
	const today = Math.floor(Date.now() / 1000 / DAY);
	let vectors = 0;
	for (let i = 0; i < (races ?? []).length; i += 40) {
		const batch = races!.slice(i, i + 40);
		const daily = await dailyD(batch.map((r) => r.id));
		const out: VectorizeVector[] = [];
		for (const r of batch) {
			const days = daily.get(r.id);
			if (!days?.size) continue;
			const lastDay = Math.max(...days.keys());
			const firstDay = Math.min(...days.keys());
			for (let end = lastDay; end - WINDOW >= firstDay - 1; end -= WINDOW) {
				const vals = windowAt(days, end);
				if (!vals) continue;
				const after = end + WINDOW <= today ? windowAt(days, end + WINDOW) : null;
				const dEnd = vals.at(-1)!, dStart = vals[0];
				const dNext = after ? after.at(-1)! : null;
				out.push({
					id: `${r.id}:${end}`,
					values: vals,
					metadata: {
						race_id: r.id, kind: r.kind, cycle: r.cycle, end_day: end, d_start: dStart, d_end: dEnd,
						known: dNext == null ? 0 : 1, d_next: dNext ?? -1,
					},
				});
			}
		}
		for (let j = 0; j < out.length; j += 500) await env.ANALOGS.upsert(out.slice(j, j + 500));
		vectors += out.length;
	}
	return { races: races?.length ?? 0, vectors };
}

/** Vectors in the index (null if it can't be read). */
export async function analogsCount(): Promise<number | null> {
	try {
		const d: any = await env.ANALOGS.describe();
		return d?.vectorCount ?? d?.vectorsCount ?? null;
	} catch {
		return null;
	}
}

const iso = (day: number) => new Date(day * DAY * 1000).toISOString().slice(0, 10);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The nearest windows from other races to this race's last WINDOW days, with what happened next. */
export async function findAnalogs(raceId: string, names: Map<string, string>) {
	const daily = await dailyD([raceId]);
	const days = daily.get(raceId);
	if (!days?.size) return { error: `No price history for ${raceId}.` };
	const end = Math.max(...days.keys());
	const vals = windowAt(days, end);
	if (!vals) return { error: "Not enough recent price history to compare (needs most of the last 32 days)." };
	const res = await env.ANALOGS.query(vals, { topK: 20, returnMetadata: "all", filter: { known: 1, race_id: { $ne: raceId } } });
	// one window per race: the closest
	const seen = new Set<string>();
	const matches = res.matches.filter((m) => { const id = String(m.metadata?.race_id); if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, 10);
	const now = { from: vals[0], to: vals.at(-1)! };
	const dir = Math.sign(now.to - now.from);
	const rows = matches.map((m) => {
		const md = m.metadata as Record<string, number | string>;
		const dEnd = Number(md.d_end), dNext = Number(md.d_next);
		return {
			race: names.get(String(md.race_id)) ?? md.race_id, race_id: md.race_id,
			window: `${iso(Number(md.end_day) - WINDOW + 1)} to ${iso(Number(md.end_day))}`,
			democratic_odds: `${Math.round(Number(md.d_start) * 100)}% to ${Math.round(dEnd * 100)}%`,
			next_32_days: `${Math.round(dEnd * 100)}% to ${Math.round(dNext * 100)}%`,
			next_change: r3(dNext - dEnd), favorite_flipped: (dEnd - 0.5) * (dNext - 0.5) < 0, distance: r3(m.score),
		};
	});
	const changes = rows.map((r) => r.next_change).sort((a, b) => a - b);
	const median = changes.length ? changes.at(Math.floor(changes.length / 2))! : null;
	return {
		race_id: raceId,
		this_race_last_32_days: `${Math.round(now.from * 100)}% to ${Math.round(now.to * 100)}% Democratic`,
		analogs: rows,
		summary: rows.length ? {
			analogs: rows.length,
			kept_moving_same_way: dir === 0 ? null : rows.filter((r) => Math.sign(r.next_change) === dir).length,
			median_next_32_day_change: median,
			favorite_flipped: rows.filter((r) => r.favorite_flipped).length,
		} : null,
		note: "Analogs are other races whose Democratic odds followed the closest 32-day path, and what their odds did over the following 32 days. A base rate for context, not a forecast; no 2026 race has settled yet.",
	};
}
