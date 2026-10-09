/**
 * One story, start to finish, as a durable Cloudflare Workflow (binding NEWSROOM): research → write → fact-check
 * (one rewrite allowed) → EmDash draft with the writer's byline → published on its own only for formats the editor
 * trusts. Every step retries on its own and every model call is logged against the writer's budget.
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { report, write, check, cleanBody, type Brief, type Fact, type Draft, type Check, type Usage } from "./agents";
import { createDraft, publishPost, upsertByline } from "./cms";
import { db, now, getWriter, getSettings, saveWriter, spentCents, perspectiveOf, FORMATS } from "./writers";
import { sendMail, emailHtml } from "../mail";

const ORIGIN = "https://parlaythepeople.com";

async function setStatus(id: string, status: string, reason: string | null = null) {
	await db().prepare("UPDATE newsroom_assignments SET status = ?, reason = COALESCE(?, reason), updated = ? WHERE id = ?").bind(status, reason, now(), id).run();
}
async function logCost(writerId: string, assignmentId: string, step: string, u: Usage) {
	await db().prepare("INSERT INTO newsroom_costs (writer_id, assignment_id, step, cost_usd, tokens, ts) VALUES (?, ?, ?, ?, ?, ?)").bind(writerId, assignmentId, step, u.cost, u.tin + u.tout, now()).run();
}

export class NewsroomWorkflow extends WorkflowEntrypoint<Env, { assignmentId: string }> {
	async run(event: WorkflowEvent<{ assignmentId: string }>, step: WorkflowStep) {
		const id = event.payload.assignmentId;
		type Job = { stop: string } | { writerId: string; format: string; brief: Brief; model: string; notify: string | null } | null;
		// step results must be plain serializable values; the job travels as JSON text
		const job: Job = JSON.parse(await step.do("load the assignment", async () => JSON.stringify(await (async (): Promise<Job> => {
			const a = await db().prepare("SELECT * FROM newsroom_assignments WHERE id = ?").bind(id).first<any>();
			if (!a || !["queued", "researching", "writing", "checking"].includes(a.status)) return null;
			const w = await getWriter(a.writer_id);
			if (!w) return null;
			const s = a.signal_id ? await db().prepare("SELECT * FROM newsroom_signals WHERE id = ?").bind(a.signal_id).first<any>() : null;
			const brief: Brief = s ? { kind: s.kind, title: s.title, data: JSON.parse(s.data || "{}"), note: a.note } : { kind: "tip", title: a.note ?? "Editor's assignment", data: {}, note: a.note };
			const settings = await getSettings();
			if (w.kind === "ai" && (await spentCents(w.id)) >= w.budget_cents) return { stop: "over its monthly AI budget" };
			return { writerId: w.id, format: a.format, brief, model: settings.model, notify: settings.notify_email };
		})())));
		if (!job) return { ok: false, why: "nothing to do" };
		if ("stop" in job) { const why = job.stop; await step.do("drop: budget", () => setStatus(id, "dropped", `Writer is ${why}`)); return { ok: false, why }; }

		let facts: Fact[] = [], draft: Draft | null = null, verdict: Check | null = null, feedback: string | null = null;
		for (let attempt = 1; attempt <= 2; attempt++) {
			facts = await step.do(`research (try ${attempt})`, { retries: { limit: 2, delay: "30 seconds" }, timeout: "10 minutes" }, async () => {
				await setStatus(id, "researching");
				const w = (await getWriter(job.writerId))!;
				const r = await report({ writer: w, brief: job.brief, format: job.format, model: job.model, feedback });
				await logCost(w.id, id, "research", r.usage);
				if (r.facts.length < 3) throw new Error(`only ${r.facts.length} facts found`);
				return JSON.parse(JSON.stringify(r.facts)) as Fact[];
			}).catch(() => [] as Fact[]);
			if (facts.length < 3) { await step.do(`drop: research ${attempt}`, () => setStatus(id, "dropped", "The reporter couldn't find enough sourced facts for this story.")); return { ok: false, why: "no facts" }; }

			draft = await step.do(`write (try ${attempt})`, { retries: { limit: 2, delay: "30 seconds" }, timeout: "10 minutes" }, async () => {
				await setStatus(id, "writing");
				const w = (await getWriter(job.writerId))!;
				const r = await write({ writer: w, brief: job.brief, format: job.format, facts, model: job.model, feedback });
				await logCost(w.id, id, "write", r.usage);
				if (!r.draft) throw new Error("no draft");
				return r.draft;
			}).catch(() => null);
			if (!draft) { await step.do(`drop: writing ${attempt}`, () => setStatus(id, "dropped", "The writer didn't produce a usable draft.")); return { ok: false, why: "no draft" }; }

			verdict = await step.do(`fact-check (try ${attempt})`, { retries: { limit: 2, delay: "30 seconds" }, timeout: "10 minutes" }, async () => {
				await setStatus(id, "checking");
				const w = (await getWriter(job.writerId))!;
				const r = await check({ draft: draft!, facts, model: job.model, writer: w });
				await logCost(w.id, id, "check", r.usage);
				return r.check;
			}).catch((): Check => ({ verdict: "fail", claims: [], label_ok: false, issues: ["The fact-check didn't complete; rewrite more tightly from the source log."] }));
			if (verdict.verdict === "pass") break;
			feedback = [...(verdict.issues ?? []), ...(verdict.claims ?? []).filter((c) => c.status !== "supported").map((c) => `"${c.text}": ${c.status}${c.note ? ` (${c.note})` : ""}`)].join("; ").slice(0, 2000);
		}

		const passed = verdict?.verdict === "pass";
		type Saved = { post: { id: string; slug: string } | null; auto: boolean; writer: string };
		const saved: Saved | null = await step.do("save the draft in EmDash", { retries: { limit: 3, delay: "30 seconds" } }, async (): Promise<Saved> => {
			const w = (await getWriter(job.writerId))!;
			const cost = await db().prepare("SELECT SUM(cost_usd) AS c, SUM(tokens) AS t FROM newsroom_costs WHERE assignment_id = ?").bind(id).first<{ c: number; t: number }>();
			let post: { id: string; slug: string } | null = null;
			if (passed) {
				if (!w.byline_id) { w.byline_id = await upsertByline(w); await saveWriter(w); }
				const line = draft!.label === "perspective" ? perspectiveOf(w.perspective).line(w.name.split(/\s+/)[0]) : null;
				const label = draft!.label === "perspective" ? "**Perspective.**" : "";
				const head = [label, line].filter(Boolean).join(" ");
				post = await createDraft({
					title: draft!.headline, excerpt: draft!.dek, bylineId: w.byline_id,
					markdown: `${head ? `*${head.replace(/\*\*/g, "")}*\n\n` : ""}${cleanBody(draft!.body)}\n\n*Research, not betting advice.*`,
					category: draft!.category, tags: draft!.tags,
				});
			}
			await db().prepare(`INSERT INTO newsroom_drafts (assignment_id, post_id, post_slug, headline, dek, body, label, source_log, check_report, cost_usd, tokens, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(assignment_id) DO UPDATE SET post_id = excluded.post_id, post_slug = excluded.post_slug, headline = excluded.headline, dek = excluded.dek, body = excluded.body, label = excluded.label, source_log = excluded.source_log, check_report = excluded.check_report, cost_usd = excluded.cost_usd, tokens = excluded.tokens`)
				.bind(id, post?.id ?? null, post?.slug ?? null, draft!.headline, draft!.dek, draft!.body, draft!.label, JSON.stringify(facts), JSON.stringify(verdict), cost?.c ?? 0, cost?.t ?? 0, now()).run();
			await setStatus(id, passed ? "ready" : "dropped", passed ? null : `Failed the fact-check twice: ${feedback?.slice(0, 300) ?? ""}`);
			return { post, auto: passed && w.approval === "auto" && w.auto_formats.includes(job.format), writer: w.name };
		}).catch(() => null);
		if (!saved) { await step.do("drop: save failed", () => setStatus(id, "dropped", "The story passed but couldn't be saved in EmDash; see the worker logs.")); return { ok: false, why: "save failed" }; }
		if (!passed || !saved.post) return { ok: false, why: "failed the fact-check" };

		if (saved.auto) {
			await step.do("publish (auto-publish format)", { retries: { limit: 3, delay: "30 seconds" } }, async () => {
				await publishPost(saved.post!.id);
				await setStatus(id, "published");
			});
		}
		if (job.notify) {
			await step.do("tell the editor", { retries: { limit: 2, delay: "1 minute" } }, async () => {
				const verb = saved.auto ? "published" : "ready for review";
				await sendMail({
					to: job.notify!, from: "newsroom@parlaythepeople.com",
					subject: `${saved.writer}: "${draft!.headline}" is ${verb}`,
					text: `${draft!.dek}\n\n${FORMATS[job.format]?.label ?? job.format} by ${saved.writer}, ${verb}.\nReview: ${ORIGIN}/_emdash/admin/plugins/newsroom/drafts`,
					html: emailHtml(`<h2 style="margin:0 0 8px;font-size:20px">${draft!.headline.replace(/</g, "&lt;")}</h2><p>${draft!.dek.replace(/</g, "&lt;")}</p><p>${FORMATS[job.format]?.label ?? job.format} by ${saved.writer}, ${verb}.</p><p><a href="${ORIGIN}/_emdash/admin/plugins/newsroom/drafts">Open the Newsroom drafts</a></p>`, ORIGIN),
				});
			}).catch(() => null);
		}
		return { ok: true, post: saved.post.id, published: saved.auto };
	}
}
