import type { APIRoute } from "astro";
import { calendar } from "../lib/calendar";

/** The election calendar as an iCal feed (election days, runoffs, FEC deadlines), for Google Calendar, Outlook and Apple Calendar. */
export const GET: APIRoute = async ({ url }) => {
	const events = (await calendar(undefined, 400)).filter((e) => e.kind !== "markets");
	const esc = (s: string) => s.replace(/[\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Parlay the People//Election calendar//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Parlay the People election calendar", "X-PUBLISHED-TTL:PT12H"];
	for (const e of events) {
		const d = e.date.replace(/-/g, "");
		const next = new Date(Date.parse(`${e.date}T12:00:00Z`) + 864e5).toISOString().slice(0, 10).replace(/-/g, "");
		const link = e.url ? (e.url.startsWith("http") ? e.url : `${url.origin}${e.url}`) : `${url.origin}/calendar/`;
		lines.push("BEGIN:VEVENT", `UID:${d}-${e.kind}-${e.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@parlaythepeople.com`, `DTSTAMP:${stamp}`,
			`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${esc(e.title)}`, `DESCRIPTION:${esc(`${e.note ?? ""} ${link}`.trim())}`, `URL:${link}`, "END:VEVENT");
	}
	lines.push("END:VCALENDAR");
	return new Response(lines.join("\r\n") + "\r\n", { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
