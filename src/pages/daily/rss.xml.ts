import type { APIRoute } from "astro";
import { dailyReport, dailySummary, isoDate, DAILY_MONEY_START } from "../../lib/daily";
import { pct, fmtVol } from "../../lib/markets";
import { raceName } from "../../lib/home";
import { SITE_NAME } from "../../lib/site";

/** RSS for the daily market report: the last 14 complete days. */
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const GET: APIRoute = async ({ url }) => {
	const o = url.origin;
	const today = Math.floor(Date.now() / 1000 / 86400) * 86400;
	const items: string[] = [];
	for (let i = 1; i <= 14; i++) {
		const date = isoDate(today - i * 86400);
		if (date < DAILY_MONEY_START) break;
		const rep = await dailyReport(date).catch(() => null);
		if (!rep) continue;
		const long = new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
		items.push(`<item><title>${esc(`Election markets on ${long}`)}</title><link>${o}/daily/${date}/</link><guid>${o}/daily/${date}/</guid><pubDate>${new Date(rep.end * 1000).toUTCString()}</pubDate><description>${esc(dailySummary(rep, raceName, (x) => pct(x), fmtVol))}</description></item>`);
	}
	const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>${esc(SITE_NAME)}: Daily market report</title><link>${o}/daily/</link><description>What moved the Kalshi and Polymarket election markets each day.</description><language>en-us</language>${items.join("")}</channel></rss>\n`;
	return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
