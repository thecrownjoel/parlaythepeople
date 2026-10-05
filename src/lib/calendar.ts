/** The election calendar (/calendar/, /calendar.ics, state pages): election days, hand-kept dates and market closes. */
import cal from "../data/calendar.json";
import { getIndex } from "./markets";
import { getPolitics, marketPath, type PolEvent } from "./politics";

export interface CalEvent { date: string; title: string; kind: "election" | "runoff" | "deadline" | "debate" | "report" | "markets"; st?: string; note?: string; url?: string; markets?: PolEvent[]; count?: number }

/** Every dated event from `from` (ISO day) for `days` days, soonest first. Market closes are grouped by day. */
export async function calendar(from = new Date().toISOString().slice(0, 10), days = 120): Promise<CalEvent[]> {
	const to = new Date(Date.parse(`${from}T12:00:00Z`) + days * 864e5).toISOString().slice(0, 10);
	const inRange = (d: string) => d >= from && d <= to;
	const out: CalEvent[] = [];
	const index = await getIndex();
	for (const c of index?.cycles ?? []) {
		if (!inRange(c.election_day)) continue;
		out.push({ date: c.election_day, title: `Election Day ${c.year}`, kind: "election", note: `${c.races} races with live odds${c.offices.includes("president") ? ", including the presidency" : ""}.`, url: `/${c.year}/` });
	}
	for (const e of (cal.events as CalEvent[])) if (inRange(e.date)) out.push(e);
	// politics markets closing each day: what the markets are waiting on
	const board = await getPolitics();
	const byDay = new Map<string, PolEvent[]>();
	for (const e of board?.events ?? []) if (e.ends && inRange(e.ends)) byDay.set(e.ends, [...(byDay.get(e.ends) ?? []), e]);
	for (const [date, es] of byDay) {
		es.sort((a, b) => b.vol - a.vol);
		out.push({ date, title: `${es.length} ${es.length === 1 ? "market closes" : "markets close"}`, kind: "markets", markets: es.slice(0, 5), count: es.length });
	}
	const rank = { election: 0, runoff: 1, debate: 2, deadline: 3, report: 4, markets: 5 } as const;
	return out.sort((a, b) => a.date.localeCompare(b.date) || rank[a.kind] - rank[b.kind]);
}

export const calDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export { marketPath };
