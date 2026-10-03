/**
 * Public URLs for EmDash media by id. Byline avatars carry only a media id, but files are served
 * by storage key (/_emdash/api/media/file/<storage_key>), so look the keys up in the CMS database.
 */
import { env } from "cloudflare:workers";

export async function mediaUrls(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
	const uniq = [...new Set(ids.filter((x): x is string => !!x))];
	if (!uniq.length) return new Map();
	try {
		const { results } = await env.DB.prepare(`SELECT id, storage_key FROM media WHERE id IN (${uniq.map(() => "?").join(",")})`)
			.bind(...uniq).all<{ id: string; storage_key: string }>();
		return new Map((results ?? []).map((r) => [r.id, `/_emdash/api/media/file/${r.storage_key}`]));
	} catch {
		return new Map();
	}
}
