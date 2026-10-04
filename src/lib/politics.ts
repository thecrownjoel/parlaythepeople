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

/** URL slug per topic (/politics/<slug>/), and search copy for each topic page. */
export const TOPIC_SLUG: Record<string, string> = {
	world: "world", trump: "white-house", courts: "courts", congress: "congress", cabinet: "cabinet",
	policy: "policy", parties: "parties-2028", elections: "other-elections", more: "more",
};
export const TOPIC_SEO: Record<string, { title: string; about: string }> = {
	world: { title: "World politics odds: elections and leaders abroad", about: "elections, leaders, wars and ceasefires around the world" },
	trump: { title: "Trump and White House odds", about: "President Trump, the White House, executive actions and approval ratings" },
	courts: { title: "Supreme Court and legal odds", about: "the Supreme Court, justices, trials, indictments and rulings" },
	congress: { title: "Congress odds: bills, shutdowns and votes", about: "bills, shutdowns, leadership fights and votes in Congress" },
	cabinet: { title: "Cabinet and appointment odds", about: "cabinet secretaries, nominees, confirmations and appointments" },
	policy: { title: "Policy odds: tariffs, taxes, immigration and the economy", about: "tariffs, taxes, immigration, spending and the economy" },
	parties: { title: "Party and 2028 odds", about: "party leadership, 2028 hopefuls and primaries" },
	elections: { title: "Mayor, governor and other election odds", about: "mayoral races, state offices, runoffs and referendums" },
	more: { title: "More politics odds", about: "everything else in politics" },
};
export const topicFromSlug = (slug: string) => Object.entries(TOPIC_SLUG).find(([, s]) => s === slug)?.[0] ?? null;

const pctWord = (p: number) => (p >= 0.995 ? "more than 99%" : p < 0.005 ? "less than 1%" : `${Math.round(p * 100)}%`);
const exName = (e: PolEvent) => (e.src === "k" ? "Kalshi" : "Polymarket");

/** One plain-language sentence per market, for answers and structured data. */
export function marketAnswer(e: PolEvent, asOf: string) {
	const lead = e.o[0];
	const odds = e.multi
		? `traders on ${exName(e)} favor ${lead.n} at ${pctWord(lead.p)}${e.o[1] ? `, ahead of ${e.o[1].n} at ${pctWord(e.o[1].p)}` : ""}`
		: `traders on ${exName(e)} give it a ${pctWord(lead.p)} chance`;
	return `As of ${asOf}, ${odds}. ${money(e.vol24)} traded in the last 24 hours, ${money(e.vol)} in all.`;
}

/** JSON-LD for a politics page: the page, its breadcrumb, the markets as a list, the dataset and Q&A. */
export function politicsLd(origin: string, path: string, name: string, description: string, events: PolEvent[], generated: string, crumbs: [string, string][]) {
	const asOf = new Date(generated).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
	const top = [...events].sort((a, b) => b.vol24 - a.vol24);
	const q = (e: PolEvent) => (e.title.trim().endsWith("?") ? e.title.trim() : `What are the odds for "${e.title.trim()}"?`);
	return {
		"@context": "https://schema.org",
		"@graph": [
			{ "@type": "CollectionPage", "@id": `${origin}${path}#page`, url: `${origin}${path}`, name, description, dateModified: generated, isPartOf: { "@id": `${origin}/#website` }, about: { "@type": "Thing", name: "Political prediction markets" } },
			{ "@type": "BreadcrumbList", itemListElement: crumbs.map(([n, p], i) => ({ "@type": "ListItem", position: i + 1, name: n, item: `${origin}${p}` })) },
			{ "@type": "ItemList", name, numberOfItems: events.length, itemListElement: top.slice(0, 50).map((e, i) => ({ "@type": "ListItem", position: i + 1, name: e.title, url: e.url, description: marketAnswer(e, asOf) })) },
			{ "@type": "Dataset", name: `${name} (Kalshi and Polymarket)`, description, url: `${origin}${path}`, dateModified: generated, license: "https://parlaythepeople.com/data/", isAccessibleForFree: true,
				creator: { "@type": "Organization", name: "Parlay the People", url: origin },
				distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${origin}/api/v1/politics.json` }],
				keywords: ["prediction markets", "politics odds", "Kalshi", "Polymarket", ...new Set(top.slice(0, 8).map((e) => e.title))] },
			{ "@type": "FAQPage", mainEntity: top.slice(0, 10).map((e) => ({ "@type": "Question", name: q(e), acceptedAnswer: { "@type": "Answer", text: marketAnswer(e, asOf) } })) },
		],
	};
}
