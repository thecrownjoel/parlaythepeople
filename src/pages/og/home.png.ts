import type { APIRoute } from "astro";
import { getIndex, getCycle, consensus, pct, fmtVol, daysUntil } from "../../lib/markets";
import { cardHtml, renderCard } from "../../lib/og";

/** Homepage share image: who's favored to control the Senate and House, days to go, money traded. */
export const GET: APIRoute = async ({ url }) => {
	const index = await getIndex();
	const data = index?.next ? await getCycle(index.next) : null;
	if (!data) return Response.redirect(`${url.origin}/brand/og.jpg`, 302);
	const y = data.meta.cycle;
	const ctl = (id: string) => data.races.find((r) => r.id === id);
	const box = (name: string, r?: ReturnType<typeof ctl>) => {
		if (!r) return "";
		const c = consensus(r);
		return `<div class="g"><div class="gl">${name} control</div><div class="gn"><b class="d">${pct(c.D)}</b><b class="r">${pct(c.R)}</b></div><div class="bar"><i style="width:${(c.D * 100).toFixed(1)}%;background:#5e92ee"></i><i style="flex:1;background:#e85a4c"></i></div><div class="gs"><span>Dem</span><span>GOP</span></div></div>`;
	};
	const traded = data.races.reduce((a, r) => a + (r.k?.v ?? 0) + (r.p?.v ?? 0), 0);
	const days = daysUntil(data.meta.election_day);
	const html = cardHtml(url.origin, `
<div class="eyebrow" style="margin-top:36px">${y} midterms · ${days > 0 ? `${days} days to go` : "results"}</div>
<h1 style="margin-top:8px">Where the markets stand</h1>
<div class="gs2">${box("Senate", ctl(`${y}-senate-control`))}${box("House", ctl(`${y}-house-control`))}</div>
<div class="foot"><span>Kalshi + Polymarket odds · <b>${fmtVol(traded)} traded</b></span><span>parlaythepeople.com</span></div>`,
		`.gs2{display:flex;gap:28px;margin:auto 0 26px;position:relative}.g{flex:1;background:#161c25;border:1px solid #222a35;border-radius:18px;padding:22px 26px}
.gl{font:800 20px Montserrat;letter-spacing:.1em;text-transform:uppercase;color:#a9b0bc}.gn{display:flex;justify-content:space-between;margin-top:8px}.gn b{font:800 72px/1 Montserrat}.gn .d{color:#5e92ee}.gn .r{color:#e85a4c}
.bar{display:flex;height:14px;border-radius:7px;overflow:hidden;gap:3px;margin-top:14px}.bar i{display:block}.gs{display:flex;justify-content:space-between;margin-top:8px;font-size:20px;font-weight:600;color:#a9b0bc}`);
	return renderCard("home", html, url.origin);
};
