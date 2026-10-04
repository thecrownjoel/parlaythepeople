/**
 * Big-trade rows as HTML, shared by the homepage ("Where the money went"), race pages and the Pro endpoint that
 * fills in rows past the free top 3 (/api/pro/trades). Same markup and classes as the components' own rows.
 */
import type { BigTrade } from "./money";
import { fmtVol, type Race } from "./markets";
import { raceName } from "./home";

export const FREE_TRADES = 3;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const ago = (ts: number) => { const s = Date.now() / 1000 - ts; return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const sideOf = (t: BigTrade) => (t.src === "k" ? (t.side === "yes" ? "Yes" : "No") : (t.side === "BUY" ? "Buy" : "Sell"));
const at = (t: BigTrade) => (t.yes_price != null ? ` at ${Math.round(t.yes_price * 100)}¢` : "");
const ex = (t: BigTrade) => (t.src === "k" ? "Kalshi" : "Polymarket");

export function raceLabel(id: string, byId: Map<string, Race>) {
	const r = byId.get(id);
	if (r) return { name: raceName(r), href: r.path as string | null };
	const m = id.match(/^(\d{4})-pres-(winner|party|nomD|nomR)$/);
	if (m) return { name: `${m[1]} ${m[2] === "nomD" ? "Democratic nomination" : m[2] === "nomR" ? "Republican nomination" : "presidency"}`, href: `/${m[1]}/president/` };
	return { name: id, href: null };
}

/** Homepage rows: amount, race, side and price, time. */
export function homeTradeRow(t: BigTrade, byId: Map<string, Race>) {
	const l = raceLabel(t.race_id, byId);
	return `<a class="mw-trade"${l.href ? ` href="${l.href}"` : ""}><span class="num money">${fmtVol(t.usd)}</span><span class="mw-name">${esc(l.name)}<em>${sideOf(t)} ${esc(t.outcome ?? "")}${at(t)} · ${ex(t)}</em></span><span class="mw-when">${ago(t.ts)}</span></a>`;
}

/** Race page rows. */
export function raceTradeRow(t: BigTrade) {
	return `<li><span class="num money">${fmtVol(t.usd)}</span><span>${sideOf(t)} ${esc(t.outcome ?? "")}${at(t)}</span><span class="rm-src">${ex(t)} · ${ago(t.ts)}</span></li>`;
}
