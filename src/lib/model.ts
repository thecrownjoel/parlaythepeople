/**
 * The Parlay estimate: the fitted forecasting model (ingest/model/fit.py → coef.json), applied to a race's
 * market odds. The model stretches or shrinks the market's confidence; a 50/50 market stays 50/50.
 */
import model from "../../ingest/model/coef.json";

export const MODEL = model as { features: string[]; coef: number[]; trained_on: number; beats_market: boolean; cv: { model: { brier: number; logloss: number }; market: { brier: number; logloss: number } } };
const EPS = 1e-4;
const logit = (p: number) => { const q = Math.min(Math.max(p, EPS), 1 - EPS); return Math.log(q / (1 - q)); };

/** Probability the Democrat wins, from the markets' Democratic and Republican odds (two-party share). */
export function parlayD(D: number, R: number): number | null {
	if (!(D + R > 0)) return null;
	const pd = D / (D + R);
	const fav = pd >= 0.5, q = fav ? pd : 1 - pd;
	const z = MODEL.coef[0] + MODEL.features.reduce((a, f, i) => a + (f === "lq" ? MODEL.coef[i + 1] * logit(q) : 0), 0);
	const pq = 1 / (1 + Math.exp(-z));
	return fav ? pq : 1 - pq;
}
