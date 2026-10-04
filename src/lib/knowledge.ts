/**
 * The AI analyst's reading material: plain-text research documents written to R2 (binding KNOWLEDGE)
 * and indexed by Cloudflare AI Search (instance "parlay"). Numbers here are snapshots for context;
 * the analyst gets exact, current figures from its database tools (lib/ai-tools.ts).
 *
 *   races/<race id>.md     one dossier per race: candidates, odds on both exchanges, Parlay estimate,
 *                          recent moves, money, social pulse, recent headlines that name the candidates
 *   news/<YYYY-MM-DD>.md   every headline the site carried that day
 *   analysis/<slug>.md     the Analysis desk's articles
 *   about/*.md             how the numbers are made (methodology, the model)
 */
import { env } from "cloudflare:workers";
import { getEmDashCollection } from "emdash";
import { getIndex, getCycle, consensus, shares, candidate, pct, fmtVol, officeTitle, RATING_LABEL, type Race } from "./markets";
import { racesAt } from "./trends";
import { moneySince } from "./money";
import { getSocial, pulseIndex, compact, type Pulse } from "./social";
import { parlayD, MODEL } from "./model";
import { dailyReport, dailySummary, isoDate } from "./daily";
import { average, marginText, type Poll } from "./polls";

const DAY = 86400;
interface Doc { key: string; body: string; meta: Record<string, string> }

const pts = (d: number) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)} pts`;

function raceDoc(r: Race, o: { origin: string; eday: string; ago7?: number; ago30?: number; m7?: number; find: ReturnType<typeof pulseIndex>; news: { title: string; source: string | null; url: string; published: number | null }[]; polls?: Poll[] }): Doc {
	const c = consensus(r);
	const ks = shares(r.k), ps = shares(r.p);
	const est = r.kind !== "control" ? parlayD(c.D, c.R) : null;
	const dName = candidate(r, "D"), rName = candidate(r, "R");
	const lines: string[] = [];
	lines.push(`# ${officeTitle(r)}, ${r.cycle}`);
	lines.push(`Race page: ${o.origin}${r.path}`);
	lines.push(`Election Day: ${o.eday}. Snapshot taken ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.`);
	lines.push("");
	lines.push("## Candidates and odds");
	if (dName || rName) lines.push(`Democrat: ${dName ?? "not named"}. Republican: ${rName ?? "not named"}.`);
	lines.push(`Market consensus: Democrats ${pct(c.D, 1)}, Republicans ${pct(c.R, 1)}${c.O > 0.02 ? `, others ${pct(c.O, 1)}` : ""}. Rating: ${RATING_LABEL[c.rating]}.`);
	if (ks) lines.push(`Kalshi: D ${pct(ks.D, 1)} / R ${pct(ks.R, 1)}.`);
	if (ps) lines.push(`Polymarket: D ${pct(ps.D, 1)} / R ${pct(ps.R, 1)}.`);
	if (est != null) lines.push(`Parlay estimate (our model): ${est >= 0.5 ? "Democrat" : "Republican"} ${pct(Math.max(est, 1 - est), 1)}.`);
	for (const s of [r.k, r.p]) for (const x of s?.o ?? []) if (x.q) lines.push(`Contract "${x.n}" on ${s === r.k ? "Kalshi" : "Polymarket"}: bid ${x.q[0] ?? "—"}, ask ${x.q[1] ?? "—"}, last ${x.q[2] ?? "—"} (dollars per $1 contract).`);
	const pa = average(o.polls ?? []);
	if (pa) {
		lines.push("");
		lines.push("## Polls");
		lines.push(`Parlay polling average: ${marginText(pa)} (${pa.d_name} ${pct(pa.d, 1)}, ${pa.r_name} ${pct(pa.r, 1)}) from ${pa.used} polls; newest ended ${pa.latest}. Source: polls listed on Wikipedia (${pa.source}).`);
		for (const p of pa.polls.slice(0, 5)) lines.push(`- ${p.pollster}, ended ${p.end_date}${p.sample ? `, ${p.sample} ${p.pop ?? ""}`.trimEnd() : ""}: ${pa.d_name.split(/\s+/).pop()} ${pct(p.d)}, ${pa.r_name.split(/\s+/).pop()} ${pct(p.r)}.`);
	}
	lines.push("");
	lines.push("## Movement and money");
	if (o.ago7 != null) lines.push(`Democratic odds over the past 7 days: ${pts(c.D - o.ago7)} (from ${pct(o.ago7, 1)}).`);
	if (o.ago30 != null) lines.push(`Over the past 30 days: ${pts(c.D - o.ago30)} (from ${pct(o.ago30, 1)}).`);
	lines.push(`Money traded to date: ${fmtVol((r.k?.v ?? 0) + (r.p?.v ?? 0))}${o.m7 ? `; ${fmtVol(o.m7)} in the past 7 days` : ""}.`);
	const pulses = [dName && o.find(dName), rName && o.find(rName)].filter((p): p is Pulse => !!p && p.races.includes(r.path));
	if (pulses.length) {
		lines.push("");
		lines.push("## Social pulse (LunarCrush)");
		for (const p of pulses) {
			lines.push(`${p.name}: ${compact(p.i24)} interactions in 24 hours, ${p.contributors} people posting, ${p.sentiment != null ? `${Math.round(p.sentiment)}% positive` : "sentiment n/a"}${p.wow != null ? `, ${p.wow >= 0 ? "up" : "down"} ${Math.abs(Math.round(p.wow * 100))}% week over week` : ""}.`);
			for (const post of (p.top ?? []).slice(0, 3)) lines.push(`- Top post (${post.net ?? "social"}${post.by ? `, ${post.by}` : ""}): "${post.t.slice(0, 200)}" ${post.u}`);
		}
	}
	const names = [dName, rName].filter(Boolean).map((n) => n!.split(/\s+/).pop()!.toLowerCase()).filter((n) => n.length > 3);
	const hits = names.length ? o.news.filter((n) => names.some((w) => n.title.toLowerCase().includes(w))).slice(0, 8) : [];
	if (hits.length) {
		lines.push("");
		lines.push("## Recent headlines");
		for (const n of hits) lines.push(`- ${n.title} (${n.source ?? "news"}, ${n.published ? new Date(n.published * 1000).toISOString().slice(0, 10) : ""}) ${n.url}`);
	}
	return { key: `races/${r.id}.md`, body: lines.join("\n") + "\n", meta: { title: officeTitle(r), url: `${o.origin}${r.path}`, kind: "race", cycle: String(r.cycle) } };
}

function ptText(blocks: unknown): string {
	if (!Array.isArray(blocks)) return "";
	return blocks.map((b: any) => (Array.isArray(b?.children) ? b.children.map((c: any) => c?.text ?? "").join("") : "")).filter(Boolean).join("\n\n");
}

/** Build every document. */
export async function buildKnowledge(origin = "https://parlaythepeople.com"): Promise<Doc[]> {
	const now = Math.floor(Date.now() / 1000);
	const index = await getIndex();
	const docs: Doc[] = [];
	const [at7, at30, m7, social] = await Promise.all([racesAt(now - 7 * DAY), racesAt(now - 30 * DAY), moneySince(now - 7 * DAY), getSocial()]);
	const find = pulseIndex(social);
	let news: { title: string; source: string | null; url: string; published: number | null; first_seen: number }[] = [];
	try {
		news = (await env.MARKETS.prepare("SELECT title, source, url, published, first_seen FROM news WHERE first_seen >= ? ORDER BY COALESCE(published, first_seen) DESC").bind(now - 45 * DAY).all<any>()).results ?? [];
	} catch { /* no headline archive yet */ }
	const pollsBy = new Map<string, Poll[]>();
	try {
		const { results } = await env.MARKETS.prepare("SELECT race_id, pollster, partisan, start_date, end_date, sample, pop, d, r, other, undecided, d_name, r_name, source FROM polls ORDER BY end_date DESC").all<Poll & { race_id: string }>();
		for (const p of results ?? []) pollsBy.set(p.race_id, [...(pollsBy.get(p.race_id) ?? []), p]);
	} catch { /* no polls table yet */ }
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		if (!data) continue;
		for (const r of data.races) {
			docs.push(raceDoc(r, { origin, eday: data.meta.election_day, ago7: at7.get(r.id)?.D, ago30: at30.get(r.id)?.D, m7: m7.get(r.id)?.usd, find, news, polls: pollsBy.get(r.id) }));
		}
	}
	// presidential markets: one document per cycle with every candidate's odds on both exchanges
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		const pres = data?.pres;
		if (!pres || !(pres.winner || pres.party)) continue;
		const part = (title: string, m?: any) => {
			if (!m) return "";
			const rows: string[] = [];
			for (const x of ["k", "p"] as const) {
				const s_ = m[x];
				if (!s_) continue;
				const tot = s_.o.reduce((a: number, o: any) => a + o.p, 0) || 1;
				rows.push(`${x === "k" ? "Kalshi" : "Polymarket"}: ` + s_.o.slice().sort((a: any, b: any) => b.p - a.p).slice(0, 12).map((o: any) => `${o.n}${o.pa ? ` (${o.pa})` : ""} ${pct(o.p / tot, 1)}`).join("; ") + ".");
			}
			return rows.length ? `## ${title}\n${rows.join("\n")}\n` : "";
		};
		docs.push({ key: `races/${cy.year}-president.md`, meta: { title: `${cy.year} presidential election`, url: `${origin}/${cy.year}/president/`, kind: "race", cycle: String(cy.year) },
			body: `# ${cy.year} presidential election\n\nPage: ${origin}/${cy.year}/president/\nElection Day: ${data!.meta.election_day}.\n\n${part("Which party wins", pres.party)}\n${part("Who wins the presidency", pres.winner)}\n${part("Democratic nomination", pres.nomD)}\n${part("Republican nomination", pres.nomR)}` });
	}
	// headline digests by day
	const byDay = new Map<string, typeof news>();
	for (const n of news) {
		const d = new Date((n.published ?? n.first_seen) * 1000).toISOString().slice(0, 10);
		byDay.set(d, [...(byDay.get(d) ?? []), n]);
	}
	for (const [d, items] of byDay) {
		docs.push({ key: `news/${d}.md`, meta: { title: `Political headlines, ${d}`, kind: "news", date: d },
			body: `# Political headlines, ${d}\n\n${items.map((n) => `- ${n.title} (${n.source ?? "news"}) ${n.url}`).join("\n")}\n` });
	}
	// daily market reports for the last 30 days
	for (let i = 1; i <= 30; i++) {
		const date = isoDate(now - i * DAY);
		const rep = await dailyReport(date).catch(() => null);
		if (!rep) continue;
		const nm = (r: Race) => (r.kind === "house" ? `${r.label} (${r.state})` : r.kind === "control" ? r.label : `${r.state} ${r.kind === "senate" ? "Senate" : "Governor"}`);
		const lines = [`# Election markets on ${date}`, `Report: ${origin}/daily/${date}/`, "", dailySummary(rep, nm, (x) => pct(x), fmtVol), ""];
		if (rep.movers.length) lines.push("Biggest moves (Democratic odds, start to end of day):", ...rep.movers.map((m) => `- ${nm(m.r)}: ${pct(m.from)} to ${pct(m.to)}`), "");
		if (rep.flips.length) lines.push("Lead changes:", ...rep.flips.map((m) => `- ${nm(m.r)}: now ${m.to >= 0.5 ? "Democrat" : "Republican"} favored`), "");
		if (rep.money) lines.push(`Money traded: ${fmtVol(rep.money.usd)} on ${rep.cycle.meta.cycle} races. Most: ${rep.money.top.slice(0, 5).map((x) => `${x.r ? nm(x.r) : x.id} ${fmtVol(x.usd)}`).join("; ")}.`);
		docs.push({ key: `daily/${date}.md`, body: lines.join("\n") + "\n", meta: { title: `Election markets on ${date}`, url: `${origin}/daily/${date}/`, kind: "daily", date } });
	}
	// analysis articles
	try {
		const { entries } = await getEmDashCollection("posts", { orderBy: { published_at: "desc" }, limit: 200 });
		for (const p of entries) {
			const by = (p.data.bylines ?? []).map((c: any) => c.byline.displayName).join(", ");
			docs.push({ key: `analysis/${p.id}.md`, meta: { title: p.data.title, url: `${origin}/posts/${p.id}`, kind: "analysis" },
				body: `# ${p.data.title}\n\nBy ${by || "Parlay the People"}${p.data.publishedAt ? `, ${p.data.publishedAt.toISOString().slice(0, 10)}` : ""}. ${origin}/posts/${p.id}\n\n${p.data.excerpt ? p.data.excerpt + "\n\n" : ""}${ptText(p.data.content)}\n` });
		}
	} catch { /* CMS unavailable: skip articles this round */ }
	docs.push({ key: "about/model.md", meta: { title: "The Parlay estimate", url: `${origin}/model/`, kind: "about" },
		body: `# The Parlay estimate (our forecasting model)\n\nThe Parlay estimate adjusts prediction-market odds using ${MODEL.trained_on} decided races from 2024 and 2025. In decided races, clear favorites (priced 80% or more) won more often than priced, so the estimate moves lopsided races further toward the favorite. Races where the favorite is under 70% keep the market's odds; the adjustment phases in between 70% and 80%. It never flips a favorite. On held-out races it scored a Brier score of ${MODEL.cv.model.brier} against the market's ${MODEL.cv.market.brier}, and log loss ${MODEL.cv.model.logloss} against ${MODEL.cv.market.logloss}. Momentum, exchange disagreement, thin markets, distance from Election Day and LunarCrush social data (share of conversation vs. odds, sentiment) were tested and did not improve accuracy, so they are not in the model. Details: ${origin}/model/\n` });
	docs.push({ key: "about/methodology.md", meta: { title: "How Parlay the People's numbers are made", url: `${origin}/methodology/`, kind: "about" },
		body: `# How the numbers are made\n\nOdds come from Kalshi and Polymarket, collected every 10 minutes. A contract paying $1 that trades at 63 cents implies about a 63% chance. Kalshi prices use the bid/ask midpoint (or the last trade when the spread is wider than 10 cents); Polymarket uses its displayed price. Each market's outcomes are rescaled to sum to 100%, and the headline number averages the two exchanges. Ratings: Safe 90%+, Likely 75–90%, Lean 60–75%, Toss-up under 60%. Money traded counts Kalshi contracts at $1 and Polymarket in dollars. Social data comes from LunarCrush: interactions, people posting, and sentiment (the share of posts that read as positive). Parlay the People is election research, not betting advice. Details: ${origin}/methodology/\n` });
	return docs;
}

/** Write documents whose text changed since the last run (tracked in _manifest.json, which AI Search skips). */
export async function publishKnowledge(origin?: string) {
	const docs = await buildKnowledge(origin);
	const manifestObj = await env.KNOWLEDGE.get("_manifest.json");
	const manifest: Record<string, string> = manifestObj ? await manifestObj.json() : {};
	const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s.replace(/Snapshot taken [^\n]*\n/, ""))))).map((b) => b.toString(16).padStart(2, "0")).join("");
	let written = 0;
	const next: Record<string, string> = {};
	for (let i = 0; i < docs.length; i += 25) {
		await Promise.all(docs.slice(i, i + 25).map(async (d) => {
			const h = await hash(d.body);
			next[d.key] = h;
			if (manifest[d.key] === h) return;
			await env.KNOWLEDGE.put(d.key, d.body, { httpMetadata: { contentType: "text/markdown; charset=utf-8" }, customMetadata: d.meta });
			written++;
		}));
	}
	// remove documents for races that no longer exist
	const gone = Object.keys(manifest).filter((k) => !(k in next));
	if (gone.length) await env.KNOWLEDGE.delete(gone);
	await env.KNOWLEDGE.put("_manifest.json", JSON.stringify(next), { httpMetadata: { contentType: "application/json" } });
	return { docs: docs.length, written, removed: gone.length };
}
