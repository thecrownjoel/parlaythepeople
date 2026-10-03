import type { APIRoute } from "astro";
import { getCycle, fmtVol } from "../../../lib/markets";
import { merged } from "../../../lib/home";
import { cardHtml, renderCard, esc } from "../../../lib/og";

/** Presidential share image: the top five candidates to win, with odds and money. */
export const GET: APIRoute = async ({ params, url }) => {
	const year = Number((params.year ?? "").replace(/\.png$/, ""));
	const data = year ? await getCycle(year) : null;
	const top = merged(data?.pres.winner, 5);
	if (!data || !top.length) return Response.redirect(`${url.origin}/brand/og.jpg`, 302);
	const col = (pa: string | null) => (pa === "D" ? "#5e92ee" : pa === "R" ? "#e85a4c" : "#c9cdd5");
	const max = Math.max(top[0].v, 0.01);
	const rows = top.map((c) => `<div class="row"><span class="n">${esc(c.n)}${c.pa ? ` (${c.pa})` : ""}</span><span class="b"><i style="width:${(c.v / max) * 100}%;background:${col(c.pa)}"></i></span><b style="color:${col(c.pa)}">${Math.round(c.v * 100)}%</b></div>`).join("");
	const traded = top.reduce((a, c) => a + c.vol, 0);
	const html = cardHtml(url.origin, `
<div class="eyebrow" style="margin-top:32px">${year} presidential election</div>
<h1 style="margin-top:8px">Who wins the White House?</h1>
<div class="rows">${rows}</div>
<div class="foot"><span>Kalshi + Polymarket odds · <b>${fmtVol(traded)} traded</b> on these five</span><span>parlaythepeople.com</span></div>`,
		`.rows{margin:26px 0 22px;display:flex;flex-direction:column;gap:6px;position:relative}.row{display:grid;grid-template-columns:420px 1fr 110px;gap:18px;align-items:center}
.n{font-size:27px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.b{height:16px;background:#222a35;border-radius:8px;overflow:hidden}.b i{display:block;height:100%;border-radius:8px}.row b{font:800 34px Montserrat;text-align:right}`);
	return renderCard(`president/${year}-v2`, html, url.origin);
};
