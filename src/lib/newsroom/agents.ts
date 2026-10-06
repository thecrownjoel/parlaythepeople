/**
 * The three agents behind every AI-written story, each a Workers AI call through AI Gateway (lib/ai.ts):
 *
 * 1. Reporter: researches with the analyst's tools plus news search and an article reader, then returns a numbered
 *    source log: every fact with the tool call or URL it came from.
 * 2. Writer: writes the story from the source log only, in the writer's voice, format and perspective, tagging each
 *    factual sentence with the facts it rests on ([F3]).
 * 3. Fact-checker: a separate call that sees only the draft and the source log, and marks every claim supported,
 *    unsupported or contradicted. It doesn't know or care about perspective.
 */
import { TOOLS, PRO_TOOLS, runTool } from "../ai-tools";
import { aiRun } from "../ai";
import { costUsd } from "../plans";
import { getIndex, daysUntil } from "../markets";
import { headlinesFor, googleNews, readArticle } from "./news";
import { parseJson } from "./persona";
import { BEATS, FORMATS, perspectiveOf, type Writer } from "./writers";

export interface Usage { tin: number; tout: number; cost: number }
export interface Fact { id: string; fact: string; source: string; url?: string | null; quote?: string | null }
export interface Brief { kind: string; title: string; data: Record<string, unknown>; note?: string | null }
export interface Draft { headline: string; dek: string; body: string; tags: string[]; category: string; label: "news" | "perspective" }
export interface Check { verdict: "pass" | "fail"; claims: { text: string; status: "supported" | "unsupported" | "contradicted"; facts: string[]; note?: string }[]; label_ok: boolean; issues: string[] }

const strip = (s: unknown) => String(s ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
const usageOf = (model: string, res: any): Usage => {
	const tin = res?.usage?.prompt_tokens ?? 0, tout = res?.usage?.completion_tokens ?? 0;
	return { tin, tout, cost: costUsd(model, tin, tout) };
};
const add = (a: Usage, b: Usage): Usage => ({ tin: a.tin + b.tin, tout: a.tout + b.tout, cost: a.cost + b.cost });

const NEWS_TOOLS = [
	{
		name: "news_search",
		description: "Search current news (Google News, last few days) for any topic or place, e.g. 'Ohio Senate race', 'farm bill Iowa'. Returns headlines with publisher, date and link.",
		input_schema: { type: "object", properties: { query: { type: "string" }, days: { type: "integer", default: 3 } }, required: ["query"] },
	},
	{
		name: "read_article",
		description: "Read an article's text from its URL to understand it and pull a short quote (Google News redirect links can't be read; use direct publisher links). Never copy more than a sentence.",
		input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
	},
];

async function runNewsTool(name: string, input: any) {
	if (name === "news_search") return { headlines: (await googleNews(String(input.query ?? ""), Math.min(7, Number(input.days ?? 3)))).slice(0, 12) };
	if (name === "read_article") return (await readArticle(String(input.url ?? ""))) ?? { error: "Couldn't read that page; work from the headline, or find a direct publisher link." };
	return { error: "unknown tool" };
}

async function context() {
	const index = await getIndex();
	const next = index?.cycles.find((c) => c.year === index.next);
	return `Today is ${new Date().toISOString().slice(0, 10)}.${next ? ` The next general election is ${next.election_day} (${daysUntil(next.election_day)} days away).` : ""}`;
}

// ---- 1. reporter ----

export async function report(o: { writer: Writer; brief: Brief; format: string; model: string; feedback?: string | null }): Promise<{ facts: Fact[]; usage: Usage; used: string[] }> {
	const { writer: w, brief, format } = o;
	const tools = [...TOOLS, ...PRO_TOOLS, ...NEWS_TOOLS].map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
	const headlines = await headlinesFor({ beats: w.beats, geography: w.geography, places: w.places, feeds: w.sources.feeds, block: w.sources.block, limit: 12 }).catch(() => []);
	const system = `You are the reporter on the Parlay Newsroom at Parlay the People (parlaythepeople.com), an election research site tracking Kalshi and Polymarket prediction markets, polls, expert ratings and campaign money. ${await context()}

Your job: research one story for ${w.name}, who covers ${w.beats.map((b) => BEATS[b] ?? b).join(", ")} (${w.geography.join(", ")}${w.places.length ? `; ${w.places.join(", ")}` : ""}), for a ${FORMATS[format]?.label ?? format}.

How to research:
- Get every number from the tools. Start with find_races if you need a race_id, then race_detail; add odds_history, trade_flow, polls, expert_ratings, campaign_finance, money, whale_watch, exchange_divergence or race_analogs when they help the story. Use news_search and read_article for what's happening and why, and search_research for background.
- Make 4 to 10 tool calls. Stay on this story.
- Voting dates, deadlines and how-to-vote details: only from official sources the tools return, never from memory.
- Polymarket wallets are pseudonyms: never guess who owns one. Social posts are claims, not facts.

When done, reply with ONLY JSON (no prose): {"facts": [{"id": "F1", "fact": "one specific, checkable statement with its number and date", "source": "tool name, or publisher name", "url": "the page or article URL", "quote": "an exact short quote from an article, or null"}, ...]}
List 8 to 25 facts. Each fact must come from a tool result you actually saw. Include the race page URL from the tools so the writer can link it.`;
	const user = `The story: ${brief.title}
Signal data: ${JSON.stringify(brief.data).slice(0, 3000)}${brief.note ? `\nEditor's note: ${brief.note}` : ""}${o.feedback ? `\nThe fact-checker rejected the last draft. Fix this in your research: ${o.feedback}` : ""}
Recent headlines on this writer's beat (may or may not be relevant):
${headlines.map((h) => `- ${h.title} (${h.source ?? "?"}, ${h.published ? new Date(h.published * 1000).toISOString().slice(0, 10) : "?"}) ${h.url}`).join("\n")}`;
	const convo: any[] = [{ role: "system", content: system }, { role: "user", content: user }];
	let usage: Usage = { tin: 0, tout: 0, cost: 0 };
	const used: string[] = [];
	for (let round = 0; round < 8; round++) {
		const last = round === 7;
		const res: any = await aiRun(o.model, { messages: convo, ...(last ? {} : { tools }), max_tokens: 12000, reasoning_effort: "low", temperature: 0.2 }, { feature: "newsroom-report", writer: w.slug });
		usage = add(usage, usageOf(o.model, res));
		const msg = res?.choices?.[0]?.message ?? { content: res?.response, tool_calls: res?.tool_calls };
		const calls = (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string | object } }[];
		if (!calls.length) {
			const facts = parseJson<{ facts: Fact[] }>(strip(msg.content))?.facts ?? [];
			return { facts: facts.filter((f) => f?.fact).map((f, i) => ({ ...f, id: f.id || `F${i + 1}` })), usage, used };
		}
		convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: calls });
		for (const c of calls) {
			let args: any = {};
			try { args = typeof c.function.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function.arguments ?? {}; } catch { /* empty args */ }
			used.push(c.function.name);
			// a failing tool is reported back to the model, not fatal to the story
			const out = await (NEWS_TOOLS.some((t) => t.name === c.function.name) ? runNewsTool(c.function.name, args) : runTool(c.function.name, args, { pro: true }))
				.catch((e) => ({ error: `This tool is unavailable right now (${String(e).slice(0, 120)}). Use other sources.` }));
			convo.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out).slice(0, 14000) });
		}
		if (round === 6) convo.push({ role: "user", content: "That's enough research. Reply now with the JSON source log only." });
	}
	return { facts: [], usage, used };
}

// ---- 2. writer ----

export async function write(o: { writer: Writer; brief: Brief; format: string; facts: Fact[]; model: string; feedback?: string | null }): Promise<{ draft: Draft | null; usage: Usage }> {
	const { writer: w, format } = o;
	const f = FORMATS[format] ?? FORMATS.brief;
	const lens = perspectiveOf(w.perspective);
	const label: Draft["label"] = w.perspective !== 0 || f.opinion ? "perspective" : "news";
	const system = `You are ${w.name}, a writer on the Parlay Newsroom at Parlay the People (parlaythepeople.com). ${await context()}
Beat: ${w.beats.map((b) => BEATS[b] ?? b).join(", ")}. Coverage: ${w.geography.join(", ")}${w.places.length ? ` (${w.places.join(", ")})` : ""}.
Perspective: ${lens.lens}.${label === "perspective" ? " This piece runs labeled as Perspective (opinion)." : " This piece runs as News: keep your own opinions out of it."}
Voice: ${w.voice ?? "clear, specific, plain words"}
${w.samples ? `How you sound:\n${w.samples}\n` : ""}
Assignment: ${f.brief} Length: ${f.words[0]}–${f.words[1]} words.

Rules you never break:
- Use ONLY the facts in the source log. Every sentence that states a fact, number, date or quote ends with the ids it rests on, like [F2] or [F2, F5]. Analysis and opinion sentences need no tag, but must not smuggle in new facts.
- Your perspective changes the angle and the argument, never the numbers, odds, dates, quotes or who said what.
- Market odds are crowd probabilities ("traders give Collins a 41% chance"). Research, not betting advice: never tell readers to buy, sell or bet.
- Credit forecasters, pollsters and publishers by name. Quote at most one short sentence from any article, attributed and linked; summarize and link otherwise.
- No unsourced claims about anyone's conduct. Leave private individuals out.
- Link the race page and sources with markdown links using the URLs in the log.
- End with a short "## What to watch" section.

Reply in exactly this format, nothing before it:
HEADLINE: specific, under 90 characters, no clickbait
DEK: one-sentence summary under 160 characters
TAGS: comma-separated, only from: senate, house, governor, president, 2026, 2028, kalshi, polymarket
CATEGORY: market-moves or analysis
---
the story in markdown, with [F#] tags`;
	const user = `Story: ${o.brief.title}${o.brief.note ? `\nEditor's note: ${o.brief.note}` : ""}${o.feedback ? `\nThe fact-checker flagged the last draft. Fix every issue: ${o.feedback}` : ""}
Source log:
${o.facts.map((x) => `[${x.id}] ${x.fact} (source: ${x.source}${x.url ? `, ${x.url}` : ""})${x.quote ? ` Quote: "${x.quote}"` : ""}`).join("\n")}`;
	const res: any = await aiRun(o.model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 16000, reasoning_effort: "low", temperature: 0.6 }, { feature: "newsroom-write", writer: w.slug });
	const usage = usageOf(o.model, res);
	if (res?.choices?.[0]?.finish_reason === "length") return { draft: null, usage };
	const raw = strip(res?.choices?.[0]?.message?.content ?? res?.response);
	const d = parseDraft(raw);
	if (!d?.headline || !d.body) {
		console.error("newsroom write: unusable draft", JSON.stringify({ finish: res?.choices?.[0]?.finish_reason, usage: res?.usage, head: raw.slice(0, 200) }));
		return { draft: null, usage };
	}
	const okTags = new Set(["senate", "house", "governor", "president", "2026", "2028", "kalshi", "polymarket", "ballot-measures"]);
	return {
		draft: { headline: d.headline.trim(), dek: (d.dek ?? "").trim(), body: d.body.trim(), tags: (d.tags ?? []).map((t) => String(t).toLowerCase()).filter((t) => okTags.has(t)), category: d.category === "analysis" ? "analysis" : "market-moves", label },
		usage,
	};
}

/** HEADLINE:/DEK:/TAGS:/CATEGORY: lines, then "---", then the markdown body (sturdier than JSON for long text). */
function parseDraft(text: string): Omit<Draft, "label"> | null {
	const t = text.replace(/^```\w*\n?|```$/g, "").trim();
	const split = t.search(/^-{3,}\s*$/m);
	if (split < 0) return null;
	const head = t.slice(0, split), body = t.slice(split).replace(/^-{3,}\s*\n/, "").trim();
	const field = (k: string) => head.match(new RegExp(`^\\**${k}\\**:\\s*(.+)$`, "im"))?.[1].trim().replace(/^\*+|\*+$/g, "") ?? "";
	const headline = field("HEADLINE");
	return headline && body ? { headline, dek: field("DEK"), body, tags: field("TAGS").split(",").map((x) => x.trim()).filter(Boolean), category: field("CATEGORY") } : null;
}

// ---- 3. fact-checker ----

export async function check(o: { draft: Draft; facts: Fact[]; model: string; writer: Writer }): Promise<{ check: Check; usage: Usage }> {
	const system = `You are the fact-checker on the Parlay Newsroom. You see a draft and the source log it was written from. You don't care about the writer's politics; you care whether each claim is backed by the log.

For every sentence in the draft that states a fact, number, date, quote or claim about a person, decide:
- supported: the cited facts (or any facts in the log) back it exactly; rounding is fine.
- unsupported: nothing in the log backs it (including facts with no [F#] tag that aren't in the log).
- contradicted: the log says something different.
Also check: quotes match the log's quotes exactly; no claims about a real person's conduct without a source; no betting advice; voting dates and deadlines only from the log; the piece runs as "${o.draft.label}" (${o.draft.label === "news" ? "so it must be neutral reporting with no opinion" : "opinion and first-person takes are fine, but facts must still be supported"}). The site prints that label and the AI disclosure above and below the story, so don't require them in the text; set label_ok false only if the content doesn't fit the label.

Verdict: "fail" if any claim is contradicted, if any substantive claim (a number, a quote, a claim about a person, a date) is unsupported, or if the label is wrong; otherwise "pass". Minor unsupported color ("it was a busy week") doesn't fail a draft.

Reply with ONLY JSON: {"verdict": "pass|fail", "claims": [{"text": "the claim, short", "status": "supported|unsupported|contradicted", "facts": ["F1"], "note": "why, if not supported"}], "label_ok": true, "issues": ["each problem the writer must fix, specific"]}`;
	const user = `Source log:\n${o.facts.map((x) => `[${x.id}] ${x.fact} (source: ${x.source}${x.url ? `, ${x.url}` : ""})${x.quote ? ` Quote: "${x.quote}"` : ""}`).join("\n")}\n\nDraft headline: ${o.draft.headline}\nDek: ${o.draft.dek}\n\n${o.draft.body}`;
	const res: any = await aiRun(o.model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 16000, reasoning_effort: "high", temperature: 0 }, { feature: "newsroom-check", writer: o.writer.slug });
	const usage = usageOf(o.model, res);
	const c = parseJson<Check>(strip(res?.choices?.[0]?.message?.content ?? res?.response));
	if (!c?.verdict) return { check: { verdict: "fail", claims: [], label_ok: false, issues: ["The fact-checker didn't return a report."] }, usage };
	// trust the claims over the headline verdict: any contradiction fails
	if (c.claims?.some((x) => x.status === "contradicted")) c.verdict = "fail";
	return { check: c, usage };
}

/** The published body: [F#] tags removed (the source log stays with the draft for the editor). */
export const cleanBody = (body: string) => body.replace(/\s*\[F\d+(?:\s*,\s*F\d+)*\]/g, "").replace(/[ \t]+\n/g, "\n");
