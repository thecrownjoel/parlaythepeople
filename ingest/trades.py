#!/usr/bin/env python3
"""Recent Kalshi trades for the most active race contracts (Kalshi has no browser access, so the
site can't fetch these live). Writes out/kalshi_trades.json: {ticker: [[unix_ts, contracts, yes_price, taker_side]]}."""
import concurrent.futures as cf
import datetime
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from ingest import get, fnum  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
TOP = 160          # most active contracts by 24h volume
PER_TICKER = 30


def main():
    tickers = []
    for f in sorted(glob.glob(os.path.join(OUT, "cycles", "*.json"))):
        for r in json.load(open(f))["races"]:
            for o in ((r.get("k") or {}).get("o") or []):
                v24 = ((o.get("m") or {}).get("v24")) or 0
                if o.get("id") and v24 > 0:
                    tickers.append((v24, o["id"]))
    tickers = [t for _v, t in sorted(tickers, reverse=True)[:TOP]]

    def one(t):
        d = get("https://api.elections.kalshi.com/trade-api/v2/markets/trades", {"ticker": t, "limit": PER_TICKER})
        rows = []
        for tr in d.get("trades", []):
            try:
                ts = int(datetime.datetime.fromisoformat(tr["created_time"].replace("Z", "+00:00")).timestamp())
            except Exception:
                continue
            rows.append([ts, fnum(tr.get("count_fp")) or 0, fnum(tr.get("yes_price_dollars")), tr.get("taker_side")])
        return t, rows
    out = {}
    with cf.ThreadPoolExecutor(6) as ex:
        for t, rows in ex.map(one, tickers):
            if rows:
                out[t] = rows
    json.dump({"generated": int(datetime.datetime.now().timestamp()), "trades": out}, open(os.path.join(OUT, "kalshi_trades.json"), "w"), separators=(",", ":"))
    print(f"kalshi trades: {sum(len(v) for v in out.values())} trades for {len(out)} contracts")


if __name__ == "__main__":
    main()
