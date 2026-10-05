import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

/** Every House and Senate candidate's FEC money this cycle, one row each (?cycle=2026). Public FEC data, free. */
export const GET: APIRoute = async ({ url }) => {
	const cycle = Number(url.searchParams.get("cycle") ?? 2026);
	const { results } = await env.MARKETS.prepare("SELECT c.cand_id, c.name, c.party, c.office, c.state, c.district, c.ici, c.receipts, c.disbursements, c.cash, c.debts, c.indiv, c.pac, c.party_contrib, c.self_funding, c.coverage_end, o.support, o.oppose FROM fec_candidates c LEFT JOIN fec_outside o ON o.cand_id = c.cand_id AND o.cycle = c.cycle WHERE c.cycle = ? ORDER BY c.state, c.office, c.district, c.receipts DESC")
		.bind(cycle).all<Record<string, unknown>>().catch(() => ({ results: [] as Record<string, unknown>[] }));
	const cols = ["cand_id", "name", "party", "office", "state", "district", "ici", "receipts", "disbursements", "cash", "debts", "indiv", "pac", "party_contrib", "self_funding", "coverage_end", "support", "oppose"];
	const cell = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
	const body = [cols.join(","), ...(results ?? []).map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
	return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="fec-${cycle}.csv"`, "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
};
