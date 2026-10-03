import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { account, charge, settle, price, randomToken } from "../../../../lib/auth";
import { runAnalyst } from "../../../../lib/analyst";
import { reportHtml, renderPdf } from "../../../../lib/report";
import { getIndex, getCycle, officeTitle } from "../../../../lib/markets";
import { costUsd } from "../../../../lib/plans";
import { readJson } from "../../auth/_json";

/**
 * POST {race_id} (Pro) → text/event-stream: {type:"status"} while the Deep analysis runs and the PDF renders, then
 * {type:"done", url} or {type:"error", text}. Costs CREDITS.report; refunded if it fails.
 */
export const POST: APIRoute = async ({ request, cookies, url }) => {
	const body = await readJson(request);
	const a = await account(cookies, request);
	if (!a.user) return Response.json({ error: "signed_out" }, { status: 401 });
	if (!a.plan.proTools) return Response.json({ error: "pro_only" }, { status: 403 });
	if (a.left < price(a, "report")) return Response.json({ error: "limit" }, { status: 429 });
	const raceId = String(body?.race_id ?? "");
	const index = await getIndex();
	let found: { race: any; eday: string } | null = null;
	for (const cy of index?.cycles ?? []) {
		const data = await getCycle(cy.year);
		const race = data?.races.find((r) => r.id === raceId);
		if (race) { found = { race, eday: data!.meta.election_day }; break; }
	}
	if (!found) return Response.json({ error: "no_race" }, { status: 404 });
	const { race, eday } = found;
	const model = a.plan.model.deep;
	const event = await charge(a, "report", model);
	const user = a.user;

	const enc = new TextEncoder();
	const stream = new ReadableStream({
		async start(ctrl) {
			const send = (o: object) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
			let r = { text: "", ok: false, tin: 0, tout: 0, used: [] as string[] };
			try {
				r = await runAnalyst({
					account: a, mode: "deep", feature: "report", onStatus: (text) => send({ type: "status", text }),
					messages: [{ role: "user", content: `Write the Deep analysis of the ${officeTitle(race)} race (race_id ${race.id}, ${race.cycle}) for a printed report.` }],
					extraSystem: "This answer is printed in a PDF report under the race's charts and odds table, so don't repeat the headline odds table; focus on analysis.",
				});
				if (!r.ok) throw new Error("analysis incomplete");
				send({ type: "status", text: "Laying out the PDF" });
				const pdf = await renderPdf(await reportHtml(race, eday, r.text, url.origin));
				const id = randomToken(12);
				const key = `reports/${user.id}/${id}.pdf`;
				await env.DATA.put(key, pdf, { httpMetadata: { contentType: "application/pdf" } });
				await env.ACCOUNTS.prepare("INSERT INTO reports (id, user_id, race_id, ts, r2_key) VALUES (?, ?, ?, ?, ?)").bind(id, user.id, race.id, Math.floor(Date.now() / 1000), key).run();
				send({ type: "done", url: `/api/pro/report/file?id=${id}` });
			} catch (e) {
				r.ok = false;
				console.error("report", race.id, String(e));
				send({ type: "error", text: "The report couldn't be finished. Your credits weren't used; please try again." });
			} finally {
				try { await settle(event, { tin: r.tin, tout: r.tout, cost: costUsd(model, r.tin, r.tout), ok: r.ok }); } catch { /* ledger best effort */ }
				ctrl.close();
			}
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
};
