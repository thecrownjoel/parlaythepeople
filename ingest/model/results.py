#!/usr/bin/env python3
"""Record who won each race once the exchanges settle it, so the Parlay estimate can be scored.

Runs hourly, and every collector run for config.RESULTS_WINDOW_DAYS after an Election Day. Does nothing until a cycle's Election Day has passed; then, for every race of that cycle
without a result, checks its contracts (from D1 race_contracts) on Kalshi (settled result) and
Polymarket (closed market, winning outcome). A race is recorded when its settled contracts name exactly
one winning party and the two exchanges don't disagree. Writes out/results.sql for D1 race_results.
"""
import datetime
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import config  # noqa: E402
from ingest import get  # noqa: E402
from archive import d1_rows  # noqa: E402

OUT = os.path.join(os.path.dirname(HERE), "out")
K = "https://api.elections.kalshi.com/trade-api/v2"
G = "https://gamma-api.polymarket.com"


def kalshi_result(ticker):
    """'yes' / 'no' once settled, else None."""
    for url in (f"{K}/markets/{ticker}", f"{K}/historical/markets/{ticker}"):
        try:
            m = (get(url) or {}).get("market") or {}
        except Exception:
            m = {}
        if m.get("result") in ("yes", "no") and m.get("status") in ("settled", "finalized", "closed", "determined"):
            return m["result"]
    return None


def poly_result(cid):
    """'yes' / 'no' once the market is closed and resolved, else None."""
    try:
        ms = get(f"{G}/markets", {"condition_ids": cid, "closed": "true"}) or []
    except Exception:
        ms = []
    for m in ms if isinstance(ms, list) else []:
        prices = json.loads(m.get("outcomePrices") or "[]")
        if m.get("closed") and prices and prices[0] in ("0", "1"):
            return "yes" if prices[0] == "1" else "no"
    return None


def winner(contracts, check):
    yes = {c["party"] for c in contracts if check(c["market"]) == "yes"}
    return yes.pop() if len(yes) == 1 else None


def main():
    today = datetime.date.today().isoformat()
    years = [y for y, d in config.ELECTION_DAYS.items() if d < today]
    path = os.path.join(OUT, "results.sql")
    # right after an election, check every run (results land within hours); otherwise once an hour
    window = any(d < today <= (datetime.date.fromisoformat(d) + datetime.timedelta(days=config.RESULTS_WINDOW_DAYS)).isoformat() for d in config.ELECTION_DAYS.values())
    if not years or (not window and datetime.datetime.utcnow().minute >= 10 and "--force" not in sys.argv):
        open(path, "w").write("")
        return print("results: nothing to resolve yet" if not years else "results: checked hourly; skipped this run")
    yrs = ",".join(f"'{y}'" for y in years)
    rows = d1_rows("ballottape-markets",
                   "SELECT c.race_id, c.src, c.market, c.party FROM race_contracts c LEFT JOIN race_results r ON r.race_id = c.race_id "
                   f"WHERE r.race_id IS NULL AND substr(c.race_id, 1, 4) IN ({yrs})") or []
    races = {}
    for r in rows:
        races.setdefault(r["race_id"], []).append(r)
    lines, now = [], int(time.time())
    for rid, cs in races.items():
        kw = winner([c for c in cs if c["src"] == "k"], kalshi_result)
        pw = winner([c for c in cs if c["src"] == "p"], poly_result)
        if kw and pw and kw != pw:
            print(f"  ! {rid}: Kalshi says {kw}, Polymarket says {pw}; waiting")
            continue
        w = kw or pw
        if w:
            src = "kp" if kw and pw else "k" if kw else "p"
            lines.append(f"INSERT OR IGNORE INTO race_results (race_id,winner,decided_at,source) VALUES ('{rid}','{w}',{now},'{src}');")
    open(path, "w").write("\n".join(lines) + "\n")
    print(f"results: {len(lines)} races resolved of {len(races)} pending")


if __name__ == "__main__":
    main()
