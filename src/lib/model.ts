/**
 * The Parlay estimate: the fitted forecasting model (ingest/model/fit.py → coef.json), applied to a race's
 * market odds. Lopsided races are adjusted (their favorites win more often than priced); competitive races
 * keep the market's odds, with the adjustment phased in between the `blend` prices.
 */
import model from "../../ingest/model/coef.json";

export const MODEL = model as { features: string[]; coef: number[]; blend?: number[]; trained_on: number; beats_market: boolean; cv: { model: { brier: number; logloss: number }; market: { brier: number; logloss: number } } };
const EPS = 1e-4;
const logit = (p: number) => { const q = Math.min(Math.max(p, EPS), 1 - EPS); return Math.log(q / (1 - q)); };

/** Probability the Democrat wins, from the markets' Democratic and Republican odds (two-party share). */
export function parlayD(D: number, R: number): number | null {
	if (!(D + R > 0)) return null;
	const pd = D / (D + R);
	const fav = pd >= 0.5, q = fav ? pd : 1 - pd;
	const z = MODEL.coef[0] + MODEL.features.reduce((a, f, i) => a + (f === "lq" ? MODEL.coef[i + 1] * logit(q) : 0), 0);
	const raw = 1 / (1 + Math.exp(-z));
	// competitive races keep the market's odds; the correction phases in for lopsided ones
	const [lo, hi] = MODEL.blend ?? [0.5, 0.5 + 1e-9];
	const t = Math.min(1, Math.max(0, (q - lo) / (hi - lo)));
	const pq = (1 - t) * q + t * raw;
	return fav ? pq : 1 - pq;
}
