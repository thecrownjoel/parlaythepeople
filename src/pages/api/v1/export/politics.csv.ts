import type { APIRoute } from "astro";
import { getPolitics, marketPath } from "../../../../lib/politics";

/** Every politics market on the board, one row each: leading outcome, its price, money traded, close date. */
export const GET: APIRoute = async ({ url }) => {
	const board = await getPolitics();
	const cell = (v: unknown) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
	const rows = (board?.events ?? []).map((e) => [e.id, e.src === "k" ? "Kalshi" : "Polymarket", e.title, e.topic, e.o[0]?.n, e.o[0]?.p, e.o[0]?.d, e.n_out, e.vol24, e.vol, e.ends, `${url.origin}${marketPath(e)}`, e.url].map(cell).join(","));
	return new Response(["id,exchange,title,topic,leading_outcome,price,change_24h,outcomes,traded_24h_usd,traded_usd,closes,page,exchange_url", ...rows].join("\n") + "\n", {
		headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="politics-markets.csv"`, "cache-control": "public, max-age=600", "access-control-allow-origin": "*" },
	});
};
