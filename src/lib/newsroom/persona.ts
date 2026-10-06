/**
 * Hiring an AI writer: Workers AI invents the persona (a fictional name, age, hometown, background, bio and voice) and
 * FLUX.1 [schnell] paints a photorealistic portrait of a person who doesn't exist. Personas are fictional by design:
 * the prompt forbids real people's names, and the portrait prompt describes an invented face, never a real person.
 * AI writers are labeled as AI on their bylines and author pages (see docs/newsroom-architecture.md, Rules).
 */
import { aiRun } from "../ai";
import { costUsd, STANDARD_MODEL } from "../plans";
import { STATES } from "../states";
import { BEATS, FORMATS, perspectiveOf, DEFAULT_CADENCE, DEFAULT_TRIGGERS, newId, now, type Writer } from "./writers";

export const PORTRAIT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export interface Persona { name: string; age: number; hometown: string; gender: string; background: string; bio: string; voice: string; samples: string; look: string }

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)];

/** Ask for a persona; the randomness comes from the seed traits we pass, so two hires never come out alike. */
export async function inventPersona(o: { beats: string[]; geography: string[]; places: string[]; perspective: number; formats: string[]; hint?: string }): Promise<{ persona: Persona; cost: number }> {
	const where = o.geography.filter((g) => g !== "US").map((g) => STATES[g] ?? g).concat(o.places);
	const seed = {
		gender: pick(["woman", "man", "woman", "man", "nonbinary person"]),
		decade: pick(["late 20s", "early 30s", "late 30s", "40s", "50s", "early 60s"]),
		path: pick(["former local newspaper reporter", "ex-Capitol Hill staffer", "former campaign pollster", "data analyst turned writer", "former TV political producer", "ex-commodities trader", "former state legislative aide", "political science PhD who left academia", "longtime wire-service reporter", "former city hall beat reporter"]),
		quirk: pick(["coaches youth soccer", "restores old motorcycles", "runs marathons", "keeps bees", "is a lifelong minor-league baseball fan", "plays in a bluegrass band", "bakes bread competitively", "collects campaign buttons", "hunts and fishes", "volunteers as a poll worker"]),
		ethnicity: pick(["White", "Black", "Latino", "Asian American", "Middle Eastern American", "mixed-race", "Native American", "South Asian American"]),
	};
	const lens = perspectiveOf(o.perspective);
	const prompt = `Invent a fictional staff writer for Parlay the People, an election news site that tracks prediction markets. The person does not exist.

Their beat: ${o.beats.map((b) => BEATS[b] ?? b).join(", ") || "U.S. elections"}. Coverage area: ${where.join(", ") || "national"}. Perspective: ${lens.label} (${lens.lens}). They write: ${o.formats.map((f) => FORMATS[f]?.label ?? f).join(", ")}.
Seed traits to build on: a ${seed.ethnicity} ${seed.gender} in their ${seed.decade}, a ${seed.path}, who ${seed.quirk}.${o.hint ? `\nEditor's note: ${o.hint}` : ""}

Rules: the name must be ordinary and believable but must NOT be the name of any real journalist, politician or public figure. No real employers by name except generic ones ("a Midwestern daily", "a Senate office"). Hometown should be in or near their coverage area when it is a state.

Return only JSON:
{"name": "First Last", "age": number, "gender": "woman|man|nonbinary", "hometown": "City, ST",
 "background": "2 sentences of career history, fictional and generic",
 "bio": "a 70-110 word author bio in third person for their author page, warm and specific; mention their beat and a personal detail; do not mention AI",
 "voice": "one sentence of style instructions for how they write (sentence length, tone, signature moves)",
 "samples": "two short sample paragraphs (60-90 words each) about a generic election-market topic, in their voice, separated by a blank line, using no real numbers",
 "look": "a one-sentence physical description for a portrait: apparent age, ethnicity, hair, glasses or not, clothing; no celebrity resemblance"}`;
	const res: any = await aiRun(STANDARD_MODEL, { messages: [{ role: "user", content: prompt }], max_tokens: 10000, reasoning_effort: "low", temperature: 0.9 }, { feature: "newsroom-hire" });
	const text = String(res?.choices?.[0]?.message?.content ?? res?.response ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
	const persona = parseJson<Persona>(text);
	if (!persona?.name || !persona.bio) {
		console.error("persona: unparsable", JSON.stringify({ finish: res?.choices?.[0]?.finish_reason, usage: res?.usage, head: text.slice(0, 300) }));
		throw new Error("The model didn't return a persona; try again.");
	}
	return { persona, cost: costUsd(STANDARD_MODEL, res?.usage?.prompt_tokens ?? 0, res?.usage?.completion_tokens ?? 0) };
}

/** A photorealistic headshot of the invented person, as JPEG bytes. */
export async function paintPortrait(p: Persona): Promise<Uint8Array> {
	const prompt = `Professional editorial headshot photograph of a fictional ${p.age}-year-old ${p.gender} journalist: ${p.look}. Natural expression, soft window light, shallow depth of field, neutral newsroom background, shot on 85mm, realistic skin texture, head and shoulders, centered, square crop. Not a celebrity, not a real person.`;
	let b64 = "";
	for (let attempt = 0; attempt < 3 && !b64; attempt++) {
		const res: any = await aiRun(PORTRAIT_MODEL, { prompt: prompt.slice(0, 2000), steps: 8 }, { feature: "newsroom-portrait" }).catch(() => null);
		b64 = String(res?.image ?? "");
	}
	if (!b64) throw new Error("The portrait model returned no image.");
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** A new writer record from a persona (not yet saved; the byline and photo are attached by the caller). */
export function writerFromPersona(p: Persona, o: { beats: string[]; geography: string[]; places: string[]; perspective: number; formats: string[]; per_week?: number }): Writer {
	const t = now();
	const slug = p.name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
	return {
		id: newId("w"), byline_id: null, name: p.name, slug, kind: "ai", age: p.age || null,
		bio: `${p.bio.trim()}\n\n${p.name.split(/\s+/)[0]} is an AI writer on the Parlay Newsroom: a fictional persona whose stories are researched and written by AI from Parlay the People's data and cited sources, checked automatically, and reviewed by our editor.`,
		photo_media_id: null, beats: o.beats, geography: o.geography.length ? o.geography : ["US"], places: o.places, perspective: o.perspective,
		formats: o.formats.length ? o.formats : ["brief"], cadence: { ...DEFAULT_CADENCE, per_week: o.per_week ?? DEFAULT_CADENCE.per_week }, triggers: { ...DEFAULT_TRIGGERS },
		voice: p.voice, samples: p.samples, sources: { feeds: [], block: [] }, approval: "drafts", auto_formats: [], budget_cents: 1000,
		active: 1, vacation_until: null, tips: 0, email: null, created: t, updated: t,
	};
}

/** The first {...} object in model output (models sometimes wrap JSON in prose or code fences). */
export function parseJson<T>(text: string): T | null {
	const s = text.replace(/```(?:json)?/g, "");
	const start = s.indexOf("{");
	if (start < 0) return null;
	let depth = 0, inStr = false, esc = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
		if (ch === '"') inStr = true;
		else if (ch === "{") depth++;
		else if (ch === "}" && --depth === 0) { try { return JSON.parse(s.slice(start, i + 1)) as T; } catch { return null; } }
	}
	return null;
}
