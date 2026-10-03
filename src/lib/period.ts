/**
 * Time periods for the section date pickers: 24 hours, a week, 30 or 60 days, or any calendar date
 * back to the start of recorded history. Sections read a period two ways:
 *  - "since": the change from then to now (movers, trends, the Pulse)
 *  - "as of": the state of the markets at that moment (the map, closest races, exchange gaps)
 */
export const HISTORY_START = "2024-11-06";
const DAY = 86400;

export interface Period {
	key: string; // "now" | "24h" | "7d" | "30d" | "60d" | "YYYY-MM-DD"
	label: string; // button text
	since: string; // "over the past 30 days" / "since Sep 3, 2026"
	at: string; // "30 days ago" / "on Sep 3, 2026"
	ts: number; // unix seconds; equals now for "now"
	days: number; // whole days back (at least 1, except "now")
	custom: boolean;
	now: boolean;
}

export const PRESETS = [
	{ key: "24h", label: "24H", secs: DAY, since: "over the past 24 hours", at: "24 hours ago" },
	{ key: "7d", label: "1W", secs: 7 * DAY, since: "over the past week", at: "a week ago" },
	{ key: "30d", label: "30D", secs: 30 * DAY, since: "over the past 30 days", at: "30 days ago" },
	{ key: "60d", label: "60D", secs: 60 * DAY, since: "over the past 60 days", at: "60 days ago" },
] as const;

const fmtDay = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export const isoDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** Parse a period key; anything unrecognized falls back to `fallback`. Dates clamp to recorded history. */
export function parsePeriod(key: string | null | undefined, fallback = "7d", now = Math.floor(Date.now() / 1000)): Period {
	const k = (key ?? "").trim() || fallback;
	if (k === "now") return { key: "now", label: "Now", since: "right now", at: "now", ts: now, days: 0, custom: false, now: true };
	const pre = PRESETS.find((p) => p.key === k);
	if (pre) return { key: pre.key, label: pre.label, since: pre.since, at: pre.at, ts: now - pre.secs, days: Math.round(pre.secs / DAY), custom: false, now: false };
	if (/^\d{4}-\d{2}-\d{2}$/.test(k)) {
		const start = Date.parse(`${HISTORY_START}T12:00:00Z`) / 1000;
		// noon UTC on the chosen day: daily history points sit at noon
		let ts = Math.floor(Date.parse(`${k}T12:00:00Z`) / 1000);
		if (Number.isFinite(ts)) {
			ts = Math.min(Math.max(ts, start), now - 3600);
			const days = Math.max(1, Math.round((now - ts) / DAY));
			return { key: isoDay(ts), label: fmtDay(ts), since: `since ${fmtDay(ts)}`, at: `on ${fmtDay(ts)}`, ts, days, custom: true, now: false };
		}
	}
	return k === fallback ? parsePeriod("7d", "7d", now) : parsePeriod(fallback, fallback, now);
}

/** Bucket size for a series running from `ts` to now: raw 10-minute points, hourly, 6-hourly or daily. */
export function bucketFor(ts: number, now = Math.floor(Date.now() / 1000)) {
	const span = now - ts;
	return span <= 2 * DAY ? 0 : span <= 10 * DAY ? 3600 : span <= 45 * DAY ? 6 * 3600 : DAY;
}
