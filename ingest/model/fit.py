#!/usr/bin/env python3
"""Fit and test the Parlay forecasting model on decided races (out/model/races.json from training.py).

Every race is looked at from several distances before Election Day (1 to 90 days out). Each look becomes
one example, oriented around the market favorite so the model learns how often favorites really win,
not which party won in 2024:

  q      the favorite's market probability (average of the exchanges that priced it that day)
  y      1 if the favorite won

The model is a regularized logistic regression on a few inputs (see FEATURES). It is judged by grouped
cross-validation: races are split into folds and every race is scored by a model that never saw it.
Each input is kept only if it beats the market on those held-out races.

Writes out/model/report.json (scores) and ingest/model/coef.json (the fitted model, used by forecast.py).
Pure Python: no numpy needed on the collector.
"""
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "out", "model")
HORIZONS = [1, 3, 7, 14, 21, 30, 45, 60, 90]
# Competitive races keep the market's odds: the correction is only reliable for lopsided races, so it is
# phased in as the favorite's price rises from BLEND[0] to BLEND[1] (set before testing, not tuned).
BLEND = (0.70, 0.80)
EPS = 1e-4


def logit(p):
    p = min(max(p, EPS), 1 - EPS)
    return math.log(p / (1 - p))


def sigmoid(z):
    return 1 / (1 + math.exp(-max(min(z, 35), -35)))


def eday_num(r):
    import datetime
    return int(datetime.datetime.fromisoformat(r["eday"] + "T12:00:00+00:00").timestamp()) // 86400


def price_at(series, d, back=3):
    """Latest D share at or up to `back` days before day d."""
    for i in range(back + 1):
        v = series.get(str(d - i))
        if v and v[0] is not None:
            return v
    return None


def social_at(soc, fav, d, days=7):
    """Favorite's share of the two candidates' interactions over the `days` before day d, and the
    sentiment gap (favorite minus underdog, in 0-1 units); None without data for both."""
    if not soc or "D" not in soc or "R" not in soc:
        return None, None
    dog = "R" if fav == "D" else "D"
    tot = lambda pa: sum((soc[pa].get(str(d - i)) or [0])[0] or 0 for i in range(days))
    a, b = tot(fav), tot(dog)
    sov = a / (a + b) if a + b > 0 else None
    def sent(pa):
        v = [x[1] for x in (soc[pa].get(str(d - i)) for i in range(days)) if x and x[1] is not None]
        return sum(v) / len(v) if v else None
    sf, sd = sent(fav), sent(dog)
    return sov, ((sf - sd) / 100 if sf is not None and sd is not None else None)


def examples(races, social=None):
    """One example per race per horizon with a price; features use only what was known that day."""
    social = social or {}
    rows = []
    for r in races:
        ed = eday_num(r)
        for h in HORIZONS:
            d = ed - h
            k, p = price_at(r["k"], d), price_at(r["p"], d)
            vals = [x[0] for x in (k, p) if x]
            if not vals:
                continue
            pd = sum(vals) / len(vals)
            fav = "D" if pd >= 0.5 else "R"
            q = pd if fav == "D" else 1 - pd
            # 7-day move toward the favorite, from the same exchanges
            k7, p7 = price_at(r["k"], d - 7), price_at(r["p"], d - 7)
            v7 = [x[0] for x in (k7, p7) if x]
            mom = None
            if v7:
                pd7 = sum(v7) / len(v7)
                q7 = pd7 if fav == "D" else 1 - pd7
                mom = logit(q) - logit(q7)
            sov, sent = social_at(social.get(r["key"]), fav, d)
            rows.append(dict(race=r["key"], office=r["office"], h=h, q=q, y=1 if r["winner"] == fav else 0, sov=sov, sent=sent,
                             gap=abs(k[0] - p[0]) if k and p else None, both=bool(k and p), mom=mom,
                             kvol=(k[1] if k and len(k) > 1 and k[1] else None)))
    return rows


# Candidate inputs. Each maps an example to a number; logit(q) is always in.
FEATURES = {
    "lq": lambda e: logit(e["q"]),
    "lq_far": lambda e: logit(e["q"]) * math.log1p(e["h"]) / math.log1p(90),   # does the market's edge fade far out?
    "lq_house": lambda e: logit(e["q"]) * (1 if e["office"] == "house" else 0),  # thin markets
    "mom": lambda e: max(-2, min(2, e["mom"] or 0)),                               # 7-day momentum toward the favorite
    "gap": lambda e: (e["gap"] or 0) * 10,                                          # exchanges disagree (10s of points)
    "single": lambda e: 0 if e["both"] else 1,                                      # priced on one exchange only
    # LunarCrush (only when social.json exists): buzz beyond the odds, and the sentiment gap
    "buzz": lambda e: 0 if e["sov"] is None else (e["sov"] - e["q"]) * 4,
    "sent": lambda e: 0 if e["sent"] is None else e["sent"] * 4,
}


def fit(rows, feats, l2=1.0, iters=50, intercept=False):
    """Newton's method for L2-regularized logistic regression. With intercept=False a 50/50 market stays
    50/50: the model only stretches or shrinks the market's confidence, so it can't learn which party
    happened to win the close races of one year."""
    n = len(feats) + 1
    w = [0.0] * n
    X = [[1.0 if intercept else 0.0] + [FEATURES[f](e) for f in feats] for e in rows]
    Y = [e["y"] for e in rows]
    W = [1 / e["_n"] for e in rows]  # each race counts once, however many horizons it has
    for _ in range(iters):
        g = [0.0] * n
        H = [[0.0] * n for _ in range(n)]
        for x, y, wt in zip(X, Y, W):
            p = sigmoid(sum(a * b for a, b in zip(w, x)))
            for i in range(n):
                g[i] += wt * (p - y) * x[i]
                for j in range(n):
                    H[i][j] += wt * p * (1 - p) * x[i] * x[j]
        for i in range(1, n):  # don't shrink the intercept
            g[i] += l2 * w[i] / len(set(e["race"] for e in rows))
            H[i][i] += l2 / len(set(e["race"] for e in rows))
        if not intercept:
            H[0][0] += 1.0
        step = solve(H, g)
        w = [a - b for a, b in zip(w, step)]
        if max(abs(s) for s in step) < 1e-8:
            break
    return w


def solve(A, b):
    n = len(b)
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-12:
            M[c][c] = 1e-12
        for r in range(n):
            if r != c:
                f = M[r][c] / M[c][c]
                for k in range(c, n + 1):
                    M[r][k] -= f * M[c][k]
    return [M[i][n] / M[i][i] for i in range(n)]


def predict(w, feats, e, blend=False):
    p = sigmoid(w[0] + sum(wi * FEATURES[f](e) for wi, f in zip(w[1:], feats)))
    if blend:
        t = min(1.0, max(0.0, (e["q"] - BLEND[0]) / (BLEND[1] - BLEND[0])))
        p = (1 - t) * e["q"] + t * p
    return p


def scores(pairs):
    """Race-weighted Brier score and log loss over (prob, outcome, weight)."""
    tw = sum(w for _, _, w in pairs) or 1
    brier = sum(w * (p - y) ** 2 for p, y, w in pairs) / tw
    ll = -sum(w * (y * math.log(max(p, EPS)) + (1 - y) * math.log(max(1 - p, EPS))) for p, y, w in pairs) / tw
    return round(brier, 5), round(ll, 5)


def cross_val(rows, feats, folds=5, seed=7, l2=1.0, blend=False):
    races = sorted({e["race"] for e in rows})
    random.Random(seed).shuffle(races)
    fold_of = {r: i % folds for i, r in enumerate(races)}
    model, market = [], []
    for f in range(folds):
        train = [e for e in rows if fold_of[e["race"]] != f]
        test = [e for e in rows if fold_of[e["race"]] == f]
        w = fit(train, feats, l2)
        for e in test:
            model.append((predict(w, feats, e, blend), e["y"], 1 / e["_n"]))
            market.append((e["q"], e["y"], 1 / e["_n"]))
    return scores(model), scores(market)


def main():
    races = json.load(open(os.path.join(OUT, "races.json")))
    sp = os.path.join(OUT, "social.json")
    social = json.load(open(sp)) if os.path.exists(sp) else {}
    if not social:
        FEATURES.pop("buzz"); FEATURES.pop("sent")
    rows = examples(races, social)
    print(f"social data for {sum(1 for e in rows if e['sov'] is not None)} looks")
    per = {}
    for e in rows:
        per[e["race"]] = per.get(e["race"], 0) + 1
    for e in rows:
        e["_n"] = per[e["race"]]
    fav_won = sum(e["y"] / e["_n"] for e in rows) / len(per)
    avg_q = sum(e["q"] / e["_n"] for e in rows) / len(per)
    print(f"{len(rows)} looks at {len(per)} races; favorites priced at {avg_q:.1%} on average and won {fav_won:.1%}")

    # Forward selection: start from calibration (intercept + logit q); add an input only if it lowers
    # held-out log loss averaged over several fold splits.
    def cv_ll(feats):
        lls = [cross_val(rows, feats, seed=s)[0][1] for s in (1, 2, 3, 4, 5)]
        return sum(lls) / len(lls)

    chosen = ["lq"]
    best = cv_ll(chosen)
    report = {"races": len(per), "looks": len(rows), "favorite_priced": round(avg_q, 4), "favorite_won": round(fav_won, 4), "steps": []}
    mk = cross_val(rows, chosen, seed=1)[1]
    report["market"] = {"brier": mk[0], "logloss": mk[1]}
    report["steps"].append({"features": list(chosen), "cv_logloss": round(best, 5)})
    print(f"market alone:       brier {mk[0]}  logloss {mk[1]}")
    print(f"calibrated market:  logloss {best:.5f}")
    improved = True
    while improved:
        improved = False
        trials = [(cv_ll(chosen + [f]), f) for f in FEATURES if f not in chosen]
        if not trials:
            break
        ll, f = min(trials)
        print(f"  + {f:9s} logloss {ll:.5f} ({'keep' if ll < best - 0.0005 else 'no gain'})")
        if ll < best - 0.0005:
            chosen.append(f)
            best = ll
            improved = True
            report["steps"].append({"features": list(chosen), "cv_logloss": round(best, 5)})

    # final scores: the blended model, averaged over 10 fold splits
    runs = [cross_val(rows, chosen, seed=sd, blend=True) for sd in range(1, 11)]
    model_cv = tuple(round(sum(r[0][i] for r in runs) / len(runs), 5) for i in (0, 1))
    market_cv = runs[0][1]
    for lo, hi in ((1, 7), (14, 30), (45, 90)):
        sub = [e for e in rows if lo <= e["h"] <= hi]
        mc, kc = cross_val(sub, chosen, seed=1) if len({e["race"] for e in sub}) >= 10 else ((None, None), (None, None))
        report.setdefault("by_horizon", {})[f"{lo}-{hi}d"] = {"model": mc, "market": kc}
        print(f"  {lo:>2}-{hi:<2} days out: model {mc}  market {kc}")
    report["model"] = {"features": chosen, "brier": model_cv[0], "logloss": model_cv[1]}
    report["beats_market"] = model_cv[1] < market_cv[1]
    # per-office check on held-out predictions
    w = fit(rows, chosen)
    report["coef"] = dict(zip(["intercept"] + chosen, [round(x, 4) for x in w]))
    print("final:", report["model"], "| market:", report["market"], "| coef:", report["coef"])
    os.makedirs(OUT, exist_ok=True)
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)
    json.dump({"features": chosen, "coef": w, "blend": list(BLEND), "trained_on": report["races"], "beats_market": report["beats_market"],
               "cv": {"model": report["model"], "market": report["market"]}},
              open(os.path.join(HERE, "coef.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
