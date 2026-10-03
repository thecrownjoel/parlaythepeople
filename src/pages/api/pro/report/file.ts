import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { currentUser } from "../../../../lib/auth";

/** GET ?id= → the PDF, for the reader who made it. */
export const GET: APIRoute = async ({ url, cookies }) => {
	const user = await currentUser(cookies);
	if (!user) return new Response("Sign in to download your reports.", { status: 401 });
	const row = await env.ACCOUNTS.prepare("SELECT race_id, ts, r2_key FROM reports WHERE id = ? AND user_id = ?").bind(url.searchParams.get("id") ?? "", user.id).first<{ race_id: string; ts: number; r2_key: string }>();
	const obj = row ? await env.DATA.get(row.r2_key) : null;
	if (!row || !obj) return new Response("Report not found.", { status: 404 });
	const name = `parlay-${row.race_id}-${new Date(row.ts * 1000).toISOString().slice(0, 10)}.pdf`;
	return new Response(obj.body, { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${name}"`, "cache-control": "private, no-store" } });
};
