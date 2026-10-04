/**
 * The Pro and sign-up gate: a blurred preview of real (free) content under a card that says what opens it.
 * Used as an HTML fragment by the date pickers and chart range buttons, and by pages (daily archive, trade lists).
 * Styles: src/styles/gate.css (global, so fragments swapped into a page are styled too).
 */
import type { Plan } from "./plans";
import { PLANS } from "./plans";

export type GateKind = "60d" | "time" | "archive" | "trades" | "ai";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const LOCK = `<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7V5.1a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

export const COPY: Record<GateKind, { eyebrow: string; title: string; body: string }> = {
	"60d": {
		eyebrow: "Free account",
		title: "Sign up free to see the past 60 days",
		body: "A free account opens the 60-day view on every section, 25 AI questions a day, and your followed races on every device. No password, no card.",
	},
	time: {
		eyebrow: "Pro only",
		title: "Historical data is part of Pro",
		body: "See any section over the past 24 hours, a week, 30 or 60 days, or as it stood on any date since November 2024: the map before a debate, the odds the night a story broke.",
	},
	archive: {
		eyebrow: "Pro · archive",
		title: "Every daily report since the archive began",
		body: "Free readers get the last 7 days of market reports. Pro opens the full archive: every move, lead change and dollar, day by day.",
	},
	ai: {
		eyebrow: "Pro only",
		title: "The AI analyst is part of Pro",
		body: "Ask anything about any race and get answers built from live odds on both exchanges, every trade, the polls and our model, with links. Pay as you go: about 4¢ a question, with $3 included every month.",
	},
	trades: {
		eyebrow: "Pro · the money trail",
		title: "See every big trade and who keeps betting",
		body: "Free readers see the top 3. Pro shows every large trade, the Polymarket wallets behind them, and which side they're on.",
	},
};

/** The card's buttons: the next step for this viewer. */
export function actions(kind: GateKind, plan: Plan, next: string) {
	const signup = `<a class="gate-btn" href="/account/?next=${encodeURIComponent(next)}">Sign up free</a>`;
	const pro = `<a class="gate-btn" href="/pro/">Get Pro · $${PLANS.pro.price}/month</a>`;
	const proGhost = `<a class="gate-btn gate-ghost" href="/pro/">See Pro</a>`;
	if (kind === "60d") return plan.id === "anon" ? `${signup}${proGhost}` : pro;
	// signed out: Pro members only need to sign in
	return plan.id === "anon" ? `${pro}<a class="gate-btn gate-ghost" href="/account/?next=${encodeURIComponent(next)}">Sign in</a>` : pro;
}

/** A gate around `preview` (HTML of content the viewer may already see, shown blurred and inert). */
export function gateHtml(kind: GateKind, plan: Plan, preview: string, next = "/") {
	const c = COPY[kind];
	return `<div class="gate" data-gate="${kind}">`
		+ `<div class="gate-preview" aria-hidden="true" inert>${preview}</div>`
		+ `<div class="gate-card" role="note"><p class="gate-eyebrow">${LOCK}<span>${esc(c.eyebrow)}</span></p>`
		+ `<p class="gate-title">${esc(c.title)}</p><p class="gate-body">${esc(c.body)}</p>`
		+ `<div class="gate-actions">${actions(kind, plan, next)}</div></div></div>`;
}

/** Which gate a homepage period needs for this plan (null = open): each section's default view is free; every
 *  other period and any date is Pro. */
export function periodGate(plan: Plan, key: string, def: string): GateKind | null {
	return key === def || plan.history === "all" ? null : "time";
}

/** Which gate a chart range needs for this plan (null = open): the chart's default range is free; every other
 *  range (24H, 1W, 1M, 1Y, All) and any date is Pro. */
export function rangeGate(plan: Plan, key: string, def: string): GateKind | null {
	return key === def || plan.history === "all" ? null : "time";
}
