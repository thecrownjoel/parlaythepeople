/**
 * The newsroom's reading: free news sources only (Google News RSS searches, publishers' RSS feeds, the GDELT DOC API),
 * and a plain-text reader for articles. Writers read to understand; posts summarize and link, with short quotes at most.
 */
import { STATES } from "../states";

export interface Headline { title: string; url: string; source: string | null; published: number | null; via: string }

const UA = "Mozilla/5.0 (compatible; ParlayNewsroom/1.0; +https://parlaythepeople.com/posts/)";
const DAY = 86400;

const decode = (s: string) => s
	.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
	.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
	.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&")
	.trim();
const tag = (xml: string, name: string) => {
	const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
	return m ? decode(m[1]) : null;
};

/** Items of an RSS or Atom feed. Workers have no DOMParser, so this reads the few tags we need. */
export function parseFeed(xml: string, via: string): Headline[] {
	const out: Headline[] = [];
	const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
	for (const it of items) {
		let title = tag(it, "title");
		const link = tag(it, "link") || it.match(/<link[^>]*href="([^"]+)"/i)?.[1] || null;
		if (!title || !link) continue;
		let source = tag(it, "source");
		// Google News titles end with " - Publisher"
		if (!source && via === "gnews") { const m = title.match(/^(.*) - ([^-]+)$/); if (m) { title = m[1]; source = m[2]; } }
		else if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
		const d = tag(it, "pubDate") ?? tag(it, "updated") ?? tag(it, "published");
		const t = d ? Date.parse(d) : NaN;
		out.push({ title: title.replace(/<[^>]+>/g, ""), url: decode(link), source, published: Number.isFinite(t) ? Math.floor(t / 1000) : null, via });
	}
	return out;
}

async function get(url: string, timeoutMs = 12000) {
	const res = await fetch(url, { headers: { "user-agent": UA, accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs), cf: { cacheTtl: 600 } } as RequestInit);
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	return res;
}

/** Google News search: current national and local headlines for any query. */
export async function googleNews(query: string, days = 2): Promise<Headline[]> {
	const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;
	try { return parseFeed(await (await get(url)).text(), "gnews"); } catch (e) { console.error("gnews", query, String(e)); return []; }
}

export async function rss(url: string): Promise<Headline[]> {
	try { return parseFeed(await (await get(url)).text(), "rss"); } catch (e) { console.error("rss", url, String(e)); return []; }
}

/** GDELT DOC API: worldwide and local coverage, updated every 15 minutes, with direct article links. */
export async function gdelt(query: string, hours = 48): Promise<Headline[]> {
	const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${query} sourcelang:english`)}&mode=artlist&format=json&maxrecords=25&sort=datedesc&timespan=${hours}h`;
	try {
		const j: any = await (await get(url)).json();
		return (j?.articles ?? []).map((a: any) => {
			const s = String(a.seendate ?? ""); // 20261005T141500Z
			const t = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00Z`);
			return { title: String(a.title ?? ""), url: String(a.url ?? ""), source: a.domain ?? null, published: Number.isFinite(t) ? Math.floor(t / 1000) : null, via: "gdelt" };
		}).filter((h: Headline) => h.title && h.url);
	} catch (e) { console.error("gdelt", query, String(e)); return []; }
}

/** The search phrases for a beat in a place ("Ohio Senate race", "farm bill Iowa"). */
export const BEAT_QUERY: Record<string, string> = {
	senate: "Senate race", house: "House race", governor: "governor race", president: "2028 presidential",
	money: "campaign finance super PAC", polls: "poll election", natsec: "national security Congress",
	agriculture: "farm bill agriculture", economy: "economy voters", world: "world politics election",
	courts: "Supreme Court ruling", immigration: "immigration policy", health: "health care policy", energy: "energy policy",
	voting: "voting rights election officials", local: "city council mayor",
};

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).slice(0, 7).join(" ");

/** Headlines for a writer's beats × places, newest first, duplicates and blocked domains removed. */
export async function headlinesFor(o: { beats: string[]; geography: string[]; places: string[]; feeds?: string[]; block?: string[]; limit?: number }): Promise<Headline[]> {
	const where = o.geography.filter((g) => g !== "US").map((g) => STATES[g] ?? g).concat(o.places);
	const queries: string[] = [];
	for (const b of o.beats.slice(0, 4)) {
		const q = BEAT_QUERY[b] ?? b;
		if (where.length) for (const w of where.slice(0, 3)) queries.push(`"${w}" ${q}`);
		else queries.push(q);
	}
	for (const p of o.places.slice(0, 2)) queries.push(`"${p}" politics`);
	// the forecasters' rating changes, as covered in the news (their own sites aren't read directly)
	if (o.beats.some((b) => ["senate", "house", "governor", "polls"].includes(b))) queries.push(`"Cook Political Report" OR "Sabato's Crystal Ball" rating${where[0] ? ` "${where[0]}"` : ""}`);
	const jobs: Promise<Headline[]>[] = queries.slice(0, 9).map((q) => googleNews(q));
	// GDELT for local and world beats, where Google News is thinnest
	if (o.places.length || o.beats.includes("world")) jobs.push(gdelt(o.places[0] ? `"${o.places[0]}"` : "election international"));
	for (const f of (o.feeds ?? []).slice(0, 6)) jobs.push(rss(f));
	const all = (await Promise.all(jobs)).flat();
	const cutoff = Date.now() / 1000 - 3 * DAY;
	const seen = new Set<string>();
	const block = (o.block ?? []).map((d) => d.toLowerCase());
	return all
		.filter((h) => (h.published ?? Date.now() / 1000) >= cutoff)
		.filter((h) => !block.some((d) => h.url.toLowerCase().includes(d) || (h.source ?? "").toLowerCase().includes(d)))
		.sort((a, b) => (b.published ?? 0) - (a.published ?? 0))
		.filter((h) => { const k = norm(h.title); if (seen.has(k)) return false; seen.add(k); return true; })
		.slice(0, o.limit ?? 30);
}

/** An article as plain text, for the reporter to read (not to republish). Google News links are redirects we can't
 *  follow without a browser, so those come back null and the reporter works from the headline. */
export async function readArticle(url: string, maxChars = 6000): Promise<{ url: string; title: string | null; text: string } | null> {
	if (!/^https?:\/\//.test(url) || url.includes("news.google.com/")) return null;
	try {
		const res = await get(url, 10000);
		if (!(res.headers.get("content-type") ?? "").includes("html")) return null;
		const html = (await res.text()).slice(0, 600_000);
		const title = tag(html, "title");
		const body = (html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html)
			.replace(/<(script|style|noscript|nav|header|footer|aside|form|svg|figure)[\s\S]*?<\/\1>/gi, " ")
			.replace(/<\/(p|h[1-6]|li|div|br)>/gi, "\n")
			.replace(/<[^>]+>/g, " ");
		const text = decode(body).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 60).join("\n");
		return text.length > 200 ? { url: res.url || url, title, text: text.slice(0, maxChars) } : null;
	} catch {
		return null;
	}
}
