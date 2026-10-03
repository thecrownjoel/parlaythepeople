/**
 * Every Workers AI call goes through Cloudflare AI Gateway (AI_GATEWAY_ID, default "default", which Cloudflare
 * creates on first use), tagged with plan and feature so the gateway's analytics break cost down per plan.
 */
import { env } from "cloudflare:workers";

export function aiRun(model: string, inputs: object, tag: Record<string, string | number> = {}): Promise<any> {
	const id = (env as unknown as { AI_GATEWAY_ID?: string }).AI_GATEWAY_ID || "default";
	return (env.AI as any).run(model, inputs, { gateway: { id, metadata: tag } });
}
