#!/usr/bin/env python3
"""Log a Parlay estimate for every live race, once an hour, so the model's track record can be scored.

Reads the cycle files from ingest.py and the fitted model (coef.json from fit.py). Writes out/forecast.sql
for D1 table `forecasts`. Control-of-chamber and presidential-winner markets are left out: the model was
trained on single races (Senate, House, governor, presidential states).
"""
import datetime
import glob
import json
import math
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "out")
NOW = int(time.time())
EPS = 1e-4


def logit(p):
    p = min(max(p, EPS), 1 - EPS)
    return math.log(p / (1 - p))


def shares(src):
    o = (src or {}).get("o") or []
    tot = sum(x["p"] for x in o) or 1
    d = sum(x["p"] for x in o if x.get("pa") == "D") / tot
    r = sum(x["p"] for x in o if x.get("pa") == "R") / tot
    return (d, r) if o else None


def estimate(model, pd):
    """Parlay probability that the Democrat wins, given the market's (two-party) Democratic share."""
    fav = pd >= 0.5
    q = pd if fav else 1 - pd
    z = model["coef"][0] + sum(w * logit(q) for w, f in zip(model["coef"][1:], model["features"]) if f == "lq")
    pq = 1 / (1 + math.exp(-z))
    lo, hi = model.get("blend") or (0.5, 0.5 + 1e-9)
    t = min(1.0, max(0.0, (q - lo) / (hi - lo)))  # competitive races keep the market's odds
    pq = (1 - t) * q + t * pq
    return pq if fav else 1 - pq


def main():
    if datetime.datetime.fromtimestamp(NOW, datetime.timezone.utc).minute >= 10 and "--force" not in os.sys.argv:
        open(os.path.join(OUT, "forecast.sql"), "w").write("")
        return print("forecast: logged hourly; skipped this run")
    model = json.load(open(os.path.join(HERE, "coef.json")))
    version = f"lq{model['coef'][1]:.3f}-b{int(model.get('blend', [0])[0] * 100)}-n{model['trained_on']}"
    lines = []
    for f in sorted(glob.glob(os.path.join(OUT, "cycles", "*.json"))):
        for r in json.load(open(f)).get("races", []):
            if r["kind"] == "control":
                continue
            sh = [s for s in (shares(r.get("k")), shares(r.get("p"))) if s and s[0] + s[1] > 0]
            if not sh:
                continue
            pd = sum(s[0] / (s[0] + s[1]) for s in sh) / len(sh)  # two-party Democratic share, averaged
            est = estimate(model, pd)
            lines.append(f"INSERT OR REPLACE INTO forecasts (race_id,ts,market_d,model_d,version) VALUES "
                         f"('{r['id']}',{NOW - NOW % 3600},{pd:.4f},{est:.4f},'{version}');")
    open(os.path.join(OUT, "forecast.sql"), "w").write("\n".join(lines) + "\n")
    print(f"forecast: {len(lines)} race estimates ({version})")


if __name__ == "__main__":
    main()
