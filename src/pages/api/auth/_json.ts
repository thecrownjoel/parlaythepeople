/** Shared by the auth routes: only same-site JSON POSTs are accepted (a cross-site form can't send application/json without a preflight). */
export async function readJson(request: Request): Promise<Record<string, any> | null> {
	if (!(request.headers.get("content-type") ?? "").includes("application/json")) return null;
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) return null;
	try { return (await request.json()) as Record<string, any>; } catch { return null; }
}
export const bad = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
export const ok = (o: object = {}) => Response.json({ ok: true, ...o }, { headers: { "cache-control": "no-store" } });
