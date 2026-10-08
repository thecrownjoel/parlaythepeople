/**
 * Plans, AI pricing and model costs: the one place that says what each tier gets and what the AI costs.
 *
 * Membership is a low monthly fee for the research features (the time machine, the full daily archive,
 * complete trade lists, full-history downloads, Pro analyst tools, alerts). AI is pay for what you use: each
 * answer, Deep analysis, briefing or report costs its measured Workers AI cost times AI_MARKUP, taken from the
 * plan's monthly AI allowance first and then from the account's AI balance (topped up; granted by hand until
 * billing is connected). Public visitors and free accounts get a daily number of standard questions instead.
 */

export type PlanId = "anon" | "free" | "pro" | "team" | "enterprise";
export type Action = "ask" | "deep";
/** Everything metered: analyst questions, plus briefings and PDF reports. */
export type Metered = Action | "briefing" | "report";

export interface Plan {
	id: PlanId;
	name: string;
	/** Membership, USD per month (annual billing gives two months free); null = custom. */
	price: number | null;
	priceYear: number | null;
	/** AI questions per UTC day for plans without an allowance (0: the AI analyst is Pro only). */
	daily?: number;
	/** AI included each month, in cents (paid plans); usage beyond it comes from the AI balance. */
	aiAllowance?: number;
	seats: number;
	/** Analyst model per mode. Workers AI model ids. */
	model: Record<Action, string>;
	/** Tool-call rounds the analyst may take per question. */
	rounds: Record<Action, number>;
	maxTokens: Record<Action, number>;
	/** Pro analyst tools: trade flow, whale watch, exchange divergence, race analogs, reranked deep research. */
	proTools: boolean;
	deep: boolean;
	/** History: "default" = each homepage section's default view and the 24-hour chart; "all" = every period,
	 *  any date since Nov 2024, 1Y and All charts (Pro). */
	history: "default" | "all";
	/** Full daily archive, complete trade lists and full-history downloads. */
	archive: boolean;
	blurb: string;
	features: string[];
}

/** Workers AI list prices, USD per million tokens (developers.cloudflare.com/workers-ai/platform/pricing, Oct 2026). */
export const MODEL_PRICE: Record<string, { in: number; out: number }> = {
	"@cf/zai-org/glm-5.3": { in: 1.4, out: 4.4 },
	"@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
	// Gemini API paid-tier list prices (ai.google.dev/gemini-api/docs/pricing, Oct 2026); $0 while on the free tier
	"gemini-3.5-flash": { in: 1.5, out: 9 },
	"gemini-3.6-flash": { in: 1.5, out: 7.5 },
};
export const STANDARD_MODEL = "@cf/zai-org/glm-5.3";

/** What readers pay for AI: the measured model cost times this. Covers card fees, AI Search, retries and margin. */
export const AI_MARKUP = 3;
/** Typical price of each action in cents (measured cost × markup, rounded), shown before it runs and required in
 *  the balance to start it. The actual charge is the real cost × markup, at least 1 cent. */
export const TYPICAL_CENTS: Record<Metered, number> = { ask: 4, deep: 20, report: 15, briefing: 4 };

/** Cents charged for an action that cost `usd` of model time. */
export const chargeCents = (usd: number) => Math.max(1, Math.ceil(usd * AI_MARKUP * 100));
export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const std = { ask: STANDARD_MODEL, deep: STANDARD_MODEL };

export const PLANS: Record<PlanId, Plan> = {
	anon: {
		id: "anon", name: "Public", price: 0, priceYear: 0, daily: 0, seats: 1, model: std,
		rounds: { ask: 6, deep: 6 }, maxTokens: { ask: 1500, deep: 1500 }, proTools: false, deep: false, history: "default", archive: false,
		blurb: "Every race, chart and poll, live, no account needed.",
		features: ["Live odds, polls and charts for every race", "Today's view of every homepage section", "The last 7 daily reports"],
	},
	free: {
		id: "free", name: "Free account", price: 0, priceYear: 0, daily: 0, seats: 1, model: std,
		rounds: { ask: 6, deep: 6 }, maxTokens: { ask: 1500, deep: 1500 }, proTools: false, deep: false, history: "default", archive: false,
		blurb: "Sign up with your email. No card, no password.",
		features: ["Everything public", "Followed races on every device", "One click to Pro when you want history and the AI analyst"],
	},
	pro: {
		id: "pro", name: "Pro", price: 9, priceYear: 90, aiAllowance: 300, seats: 1, model: std,
		rounds: { ask: 8, deep: 14 }, maxTokens: { ask: 2500, deep: 5000 }, proTools: true, deep: true, history: "all", archive: true,
		blurb: "The time machine and the money trail, for anyone who follows races closely.",
		features: [
			"The AI analyst: ask anything, with Deep analyses, PDF reports and morning briefings",
			"All historical data: every section for 24 hours, a week, 30 or 60 days, or any date since Nov 2024",
			"1-year and full-history charts",
			"The full daily report archive",
			"Every big trade and Polymarket wallet, not just the top 3",
			"Full-history data downloads",
			"Move and big-bet alerts on your races",
			"AI pays as you go, with $3 included each month",
		],
	},
	team: {
		id: "team", name: "Team", price: 49, priceYear: 490, aiAllowance: 1500, seats: 5, model: std,
		rounds: { ask: 8, deep: 14 }, maxTokens: { ask: 2500, deep: 5000 }, proTools: true, deep: true, history: "all", archive: true,
		blurb: "For campaigns, PACs and firms working a slate of races.",
		features: ["Everything in Pro for 5 people", "$15 of AI included each month, shared", "One AI balance for the team", "Data API keys (coming)"],
	},
	enterprise: {
		id: "enterprise", name: "Organization", price: null, priceYear: null, aiAllowance: 10000, seats: 25, model: std,
		rounds: { ask: 10, deep: 16 }, maxTokens: { ask: 3000, deep: 6000 }, proTools: true, deep: true, history: "all", archive: true,
		blurb: "For party committees, large firms and newsrooms.",
		features: ["Everything in Team for 25+ people", "AI at a volume rate", "Private research library: your own memos in the analyst (coming)", "Single sign-on and invoicing"],
	},
};

/** AI balance top-ups (kept until used). */
export const TOP_UPS = [10, 25, 100];

/** Estimated model cost of one call, USD. */
export function costUsd(model: string, tin: number, tout: number) {
	const p = MODEL_PRICE[model] ?? MODEL_PRICE[STANDARD_MODEL];
	return (tin * p.in + tout * p.out) / 1e6;
}
