/** Outgoing email through Cloudflare Email Service (binding EMAIL, sending domain parlaythepeople.com). */
import { env } from "cloudflare:workers";

export async function sendMail(m: { to: string; from: string; subject: string; text: string; html: string }) {
	const mail = (env as unknown as { EMAIL?: { send(m: object): Promise<unknown> } }).EMAIL;
	if (!mail) throw new Error("email_not_configured");
	await mail.send({ to: m.to, from: { email: m.from, name: "Parlay the People" }, subject: m.subject, text: m.text, html: m.html });
}

/** A plain, readable email body: our wordmark, the content, and a footer with where to change settings. */
export function emailHtml(inner: string, origin = "https://parlaythepeople.com") {
	return `<!doctype html><html><body style="margin:0;background:#f4f5f7;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1b1f24">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px 28px;line-height:1.55;font-size:15px">
<p style="margin:0 0 16px;font-weight:800;letter-spacing:.04em;font-size:13px;color:#a3262a">PARLAY THE PEOPLE</p>
${inner}
<hr style="border:0;border-top:1px solid #e3e6ea;margin:24px 0 12px">
<p style="margin:0;font-size:12px;color:#6b7280">Research, not betting advice. Change briefings and alerts on <a href="${origin}/account/" style="color:#6b7280">your account page</a>.</p>
</div></body></html>`;
}
