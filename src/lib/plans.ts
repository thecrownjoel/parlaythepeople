/**
 * Plans, credits and model costs: the one place that says what each tier gets and what the AI costs us.
 * Credits are the unit readers see; each action's credit price is set from its measured model cost
 * (see the "Unit costs" section of the Pro design doc), so every plan keeps its margin at heavy use.
 */

export type PlanId = "anon" | "free" | "pro" | "team" | "enterprise";
export type Action = "ask" | "deep";

export interface Plan {
	id: PlanId;
	name: string;
	/** USD per month (annual billing gives two months free); null = not sold / custom. */
	price: number | null;
	priceYear: number | null;
	/** Questions per UTC day (anon and free) or credits per billing month (paid). */
	daily?: number;
	credits?: number;
	seats: number;
	/** Analyst model per mode. Workers AI model ids. */
	model: Record<Action, string>;
	/** Tool-call rounds the analyst may take per question. */
	rounds: Record<Action, number>;
	maxTokens: Record<Action, number>;
	/** Pro tools: trade flow, whale watch, exchange divergence, reranked deep research. */
	proTools: boolean;
	deep: boolean;
	blurb: string;
	features: string[];
}

/** Workers AI list prices, USD per million tokens (developers.cloudflare.com/workers-ai/platform/pricing, Oct 2026). */
export const MODEL_PRICE: Record<string, { in: number; out: number }> = {
	"@cf/zai-org/glm-5.3": { in: 1.4, out: 4.4 },
	"@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
};
export const STANDARD_MODEL = "@cf/zai-org/glm-5.3";

/** Credits charged per action (paid plans). An "ask" is one question; "deep" runs more rounds, more sources and a reranker. */
export const CREDITS: Record<Action, number> = { ask: 1, deep: 5 };

const std = { ask: STANDARD_MODEL, deep: STANDARD_MODEL };

export const PLANS: Record<PlanId, Plan> = {
	anon: {
		id: "anon", name: "Public", price: 0, priceYear: 0, daily: 10, seats: 1, model: std,
		rounds: { ask: 6, deep: 6 }, maxTokens: { ask: 1500, deep: 1500 }, proTools: false, deep: false,
		blurb: "Every race, chart and daily report, no account needed.",
		features: ["All race pages, charts and maps", "Daily market reports and headlines", "AI analyst: 10 questions a day"],
	},
	free: {
		id: "free", name: "Free account", price: 0, priceYear: 0, daily: 25, seats: 1, model: std,
		rounds: { ask: 6, deep: 6 }, maxTokens: { ask: 1500, deep: 1500 }, proTools: false, deep: false,
		blurb: "Sign in with your email for a higher daily limit.",
		features: ["Everything public", "AI analyst: 25 questions a day", "Sign in with an email link or a passkey"],
	},
	pro: {
		id: "pro", name: "Pro", price: 49, priceYear: 490, credits: 600, seats: 1, model: std,
		rounds: { ask: 8, deep: 14 }, maxTokens: { ask: 2500, deep: 5000 }, proTools: true, deep: true,
		blurb: "For consultants, reporters and traders who follow the money.",
		features: ["600 analyst credits a month (a question is 1, a Deep analysis 5)", "Deep mode: longer, multi-source analysis", "Trade flow: net buying by side and trade size", "Whale watch: the biggest trades and repeat Polymarket wallets", "Exchange divergence: where Kalshi and Polymarket disagree", "Full-resolution price history in answers"],
	},
	team: {
		id: "team", name: "Team", price: 249, priceYear: 2490, credits: 4000, seats: 5, model: std,
		rounds: { ask: 8, deep: 14 }, maxTokens: { ask: 2500, deep: 5000 }, proTools: true, deep: true,
		blurb: "For campaigns, PACs and firms working a slate of races.",
		features: ["Everything in Pro", "5 seats sharing 4,000 credits a month", "Shared watchlists (coming)", "Daily briefings and alerts (coming)", "Data API keys (coming)"],
	},
	enterprise: {
		id: "enterprise", name: "Organization", price: null, priceYear: null, credits: 20000, seats: 25, model: std,
		rounds: { ask: 10, deep: 16 }, maxTokens: { ask: 3000, deep: 6000 }, proTools: true, deep: true,
		blurb: "For party committees, large firms and newsrooms.",
		features: ["Everything in Team", "From 20,000 credits and 25 seats", "Private research library: your own memos in the analyst (coming)", "Single sign-on and invoicing"],
	},
};

/** Extra credits sold on top of a plan (kept until used). */
export const CREDIT_PACK = { credits: 250, price: 20 };

/** Estimated model cost of one call, USD. */
export function costUsd(model: string, tin: number, tout: number) {
	const p = MODEL_PRICE[model] ?? MODEL_PRICE[STANDARD_MODEL];
	return (tin * p.in + tout * p.out) / 1e6;
}
