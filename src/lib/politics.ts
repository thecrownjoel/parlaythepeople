/**
 * Every other politics market (ingest/politics.py): Kalshi's Politics and Elections categories and Polymarket's
 * politics tags, minus what's already on race pages. The board is R2 politics.json; D1 keeps an hourly price per
 * event (sparklines) and when each event first appeared (new listings).
 */
import { env } from "cloudflare:workers";
import { r2json } from "./markets";

export interface PolOutcome { n: string; p: number; d: number | null }
export interface PolEvent {
	id: string; src: "k" | "p"; title: string; sub: string | null; url: string; img: string | null;
	topic: string; vol: number; vol24: number; ends: string | null; multi: boolean; o: PolOutcome[]; n_out: number;
}
export interface PolBoard {
	generated: string; events: PolEvent[]; topics: { key: string; name: string; count: number }[];
	totals: { events: number; vol: number; vol24: number; kalshi: number; polymarket: number };
}

/** Accent per topic (dark theme), used for chips, bubbles and card edges. */
export const TOPIC_COLOR: Record<string, string> = {
	world: "#4cc3c8", trump: "#e85a4c", courts: "#b48cf2", congress: "#5e92ee", cabinet: "#f5a524",
	policy: "#4cc38a", parties: "#f07ab0", elections: "#e0b44f", more: "#9aa1ad",
};

export const getPolitics = () => r2json<PolBoard>("politics.json");

/** The last 24 hours of hourly prices for these events (the free view; see the Pro gating rules). */
export async function politicsSparks(ids: string[]): Promise<Map<string, number[]>> {
	const out = new Map<string, number[]>();
	const since = Math.floor(Date.now() / 1000) - 25 * 3600;
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		try {
			const { results } = await env.MARKETS.prepare(`SELECT event_id, p FROM politics_history WHERE ts >= ? AND event_id IN (${chunk.map(() => "?").join(",")}) ORDER BY ts`)
				.bind(since, ...chunk).all<{ event_id: string; p: number }>();
			for (const r of results ?? []) out.set(r.event_id, [...(out.get(r.event_id) ?? []), r.p]);
		} catch { /* no history yet */ }
	}
	return out;
}

/** Events that first appeared in the last `hours` (the board's own entries, newest first). */
export async function newListings(board: PolBoard, hours = 72, limit = 10): Promise<PolEvent[]> {
	try {
		const { results } = await env.MARKETS.prepare("SELECT event_id FROM politics_first_seen WHERE first_seen >= ? ORDER BY first_seen DESC LIMIT 200")
			.bind(Math.floor(Date.now() / 1000) - hours * 3600).all<{ event_id: string }>();
		const byId = new Map(board.events.map((e) => [e.id, e]));
		// the first run marks everything as new; until a day has passed there's nothing to call new
		const first = await env.MARKETS.prepare("SELECT MIN(first_seen) AS t FROM politics_first_seen").first<{ t: number }>();
		if (!first?.t || Date.now() / 1000 - first.t < 24 * 3600) return [];
		return (results ?? []).map((r) => byId.get(r.event_id)).filter((e): e is PolEvent => !!e).slice(0, limit);
	} catch {
		return [];
	}
}

/** Sparkline path for values 0-1 in a w × h box. */
export function sparkPath(vals: number[], w = 120, h = 32) {
	if (vals.length < 2) return "";
	const lo = Math.min(...vals), hi = Math.max(...vals), span = Math.max(0.02, hi - lo);
	return vals.map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join("");
}

export const money = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${Math.round(x / 1e3)}K` : `$${Math.round(x)}`);
