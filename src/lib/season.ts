/**
 * The homepage engine (docs/homepage-engine.md): what period of the political calendar we're in, what leads the
 * front page, and the order of its modules. A season comes from the date and the election calendar; moments (an
 * editor's pin, today's calendar events) sit on top of it. Preview any date with ?at=2026-11-03T20:00 (admins only).
 */
import { env } from "cloudflare:workers";
import { getIndex } from "./markets";
import cal from "../data/calendar.json";

export type SeasonKey = "stretch" | "election-night" | "aftermath" | "transition" | "governing" | "primaries";
export type ModuleKey =
	| "pin" | "results" | "lead" | "yours" | "ticker" | "big" | "moving" | "pulse" | "globe" | "money" | "map" | "grid"
	| "congress" | "leaders" | "politics" | "polls" | "analysis" | "ballots" | "explore";

export interface Season {
	key: SeasonKey; label: string; cycle: number; eday: string;
	/** The page's main line (h1) and title tag. */
	h1: string; title: string;
	modules: ModuleKey[];
}
export interface Pin { title: string; text?: string | null; url?: string | null; until: number; tone?: "news" | "alert" }

const ORDER: Record<SeasonKey, ModuleKey[]> = {
	stretch: ["pin", "lead", "yours", "ticker", "big", "moving", "pulse", "globe", "money", "map", "grid", "leaders", "politics", "polls", "congress", "analysis", "ballots", "explore"],
	"election-night": ["pin", "results", "yours", "ticker", "big", "moving", "globe", "money", "grid", "analysis", "politics", "explore"],
	aftermath: ["pin", "results", "ticker", "analysis", "politics", "congress", "moving", "money", "leaders", "grid", "big", "explore"],
	transition: ["pin", "lead", "ticker", "congress", "politics", "analysis", "leaders", "moving", "money", "explore"],
	governing: ["pin", "lead", "ticker", "politics", "congress", "analysis", "leaders", "moving", "money", "pulse", "explore"],
	primaries: ["pin", "lead", "ticker", "leaders", "politics", "analysis", "congress", "moving", "money", "explore"],
};

/** 6pm Eastern on Election Day: first polls close (Eastern Standard Time in November). */
const pollsClose = (eday: string) => Date.parse(`${eday}T18:00:00-05:00`);
const at = (iso: string) => Date.parse(iso);

/** The most recent even-year general election on or before `now`, and the next one. */
async function generals(now: number) {
	const index = await getIndex();
	const days = (index?.cycles ?? []).filter((c) => c.year % 2 === 0).map((c) => ({ year: c.year, eday: c.election_day })).sort((a, b) => a.year - b.year);
	const next = days.find((d) => pollsClose(d.eday) + 36 * 3600_000 > now) ?? days[days.length - 1];
	const prev = [...days].reverse().find((d) => pollsClose(d.eday) <= now) ?? null;
	return { next, prev };
}

export async function resolveSeason(now = Date.now()): Promise<Season> {
	const { next, prev } = await generals(now);
	const cycle = next?.year ?? new Date(now).getUTCFullYear(), eday = next?.eday ?? `${cycle}-11-03`;
	const close = pollsClose(eday);
	const make = (key: SeasonKey, label: string, h1: string, title: string, c = cycle, e = eday): Season => ({ key, label, cycle: c, eday: e, h1, title, modules: ORDER[key] });
	const presidential = cycle % 4 === 0;
	const word = presidential ? "election" : "midterms";

	// election night: from the first poll closings until noon Eastern the next day
	if (now >= close && now < close + 18 * 3600_000) return make("election-night", "Election night", `${cycle} election night: live results by the markets`, `${cycle} election results live`);
	if (now < close) {
		// well before a presidential general, the primaries lead
		if (presidential && now < at(`${cycle}-06-15T00:00:00Z`) && now >= at(`${cycle - 1}-11-01T00:00:00Z`)) return make("primaries", "Primary season", `The ${cycle} race for the White House, with the odds`, `${cycle} presidential primary odds`);
		const stretchStart = at(`${cycle}-06-15T00:00:00Z`);
		if (now >= stretchStart) return make("stretch", `${cycle} ${word}`, `Political news and ${cycle} ${word} odds from Kalshi and Polymarket, race by race`, `live ${cycle} ${word} odds from Kalshi & Polymarket`);
	}
	// after the last general: aftermath to mid-December, transition to inauguration / swearing-in, then governing
	const last = prev ?? next;
	if (last) {
		const lc = pollsClose(last.eday);
		const y = last.year;
		if (now >= lc && now < at(`${y}-12-15T05:00:00Z`)) return make("aftermath", `After the ${y} election`, `The ${y} results, and what comes next in Washington`, `${y} election results and what's next`, y, last.eday);
		if (now >= lc && now < at(`${y + 1}-01-21T05:00:00Z`)) return make("transition", "The new Congress", "The new Congress and the U.S. government, with the odds", "The new Congress, with the odds", y, last.eday);
	}
	return make("governing", "This week in Washington", "The U.S. government, with the odds: Congress, the White House, the Pentagon and the courts", "The U.S. government, with the odds");
}

/** The editor's pinned moment, if it hasn't expired. */
export async function activePin(now = Date.now()): Promise<Pin | null> {
	try {
		const r = await env.ACCOUNTS.prepare("SELECT value FROM newsroom_settings WHERE key = 'home_pin'").first<{ value: string }>();
		const p = r ? (JSON.parse(r.value) as Pin) : null;
		return p && p.title && p.until * 1000 > now ? p : null;
	} catch {
		return null;
	}
}
export async function setPin(p: Pin | null) {
	await env.ACCOUNTS.prepare("INSERT INTO newsroom_settings (key, value) VALUES ('home_pin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(p ?? {})).run();
}

/** Today's calendar moments (debates, deadlines, reports, runoffs), as banners. */
export function calendarMoments(now = Date.now()) {
	const today = new Date(now).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
	return (cal.events as { date: string; title: string; kind: string; note?: string; url?: string }[]).filter((e) => e.date === today && e.kind !== "markets");
}

/** Preview dates for the editor: one moment in each season around the next or last general. */
export function previewDates(eday: string) {
	const y = Number(eday.slice(0, 4));
	return [
		{ label: "Final stretch", at: `${y}-10-20T12:00` },
		{ label: "Election night", at: `${eday}T21:00` },
		{ label: "Aftermath", at: `${y}-11-10T12:00` },
		{ label: "Transition", at: `${y}-12-20T12:00` },
		{ label: "Governing", at: `${y + 1}-03-01T12:00` },
		...(y % 4 === 2 ? [{ label: "2028 primaries", at: `${y + 2}-01-20T12:00` }] : []),
	];
}
