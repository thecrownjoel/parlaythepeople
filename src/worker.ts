import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { startBriefings, checkAlerts, BriefingWorkflow } from "./lib/briefing";
import { buildAnalogs, analogsCount } from "./lib/analogs";
import { pingIndexNow } from "./lib/indexnow";

export { PluginBridge, BriefingWorkflow };

const emdashScheduled = createScheduledHandler();

/**
 * The every-minute cron: EmDash's maintenance first, then Pro jobs by the clock (UTC):
 * - every 10 minutes (minute ending in 3): move and big-bet alerts on followed races
 * - 11:00 daily (7am Eastern): start the morning briefing workflows
 * - Mondays 06:30: rebuild the race analogs index
 * - 12:15 daily: tell IndexNow (Bing, ChatGPT search, Copilot) which pages to recrawl
 */
async function proJobs(at: Date) {
	const m = at.getUTCMinutes(), h = at.getUTCHours();
	try {
		if (m % 10 === 3) console.log("alerts", JSON.stringify(await checkAlerts()));
		// first run after setup: build the analogs index if it's empty
		if (m % 10 === 7) {
			if ((await analogsCount()) === 0) console.log("analogs bootstrap", JSON.stringify(await buildAnalogs()));
		}
		if (h === 11 && m === 0) console.log("briefings", JSON.stringify(await startBriefings()));
		if (at.getUTCDay() === 1 && h === 6 && m === 30) console.log("analogs", JSON.stringify(await buildAnalogs()));
		if (h === 12 && m === 15) console.log("indexnow", JSON.stringify(await pingIndexNow()));
	} catch (e) {
		console.error("pro jobs", String(e));
	}
}

export default {
	...handler,
	// /embed/ cards are made to be framed by other sites; everything else keeps EmDash's same-origin framing rule
	async fetch(request, env, ctx) {
		const res = await handler.fetch!(request, env, ctx);
		if (!new URL(request.url).pathname.startsWith("/embed/")) return res;
		const headers = new Headers(res.headers);
		headers.delete("x-frame-options");
		headers.set("content-security-policy", "frame-ancestors *");
		return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
	},
	async scheduled(controller, env, ctx) {
		await emdashScheduled(controller, env, ctx);
		ctx.waitUntil(proJobs(new Date(controller.scheduledTime)));
	},
} satisfies ExportedHandler;
