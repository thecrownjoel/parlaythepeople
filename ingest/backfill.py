#!/usr/bin/env python3
"""Backfill daily price history from the exchanges' own history APIs.

Fills race_history with one point per day (noon UTC) for every race and the presidential
party race, from when each market opened up to the day live collection began. Safe to re-run:
rows are INSERT OR IGNORE and days already covered by live collection are skipped.

Usage:  python3 ingest/backfill.py [--since-days N]
        then: npx wrangler d1 execute ballottape-markets --remote --file ingest/out/backfill.sql
Needs ingest/out/cycles/*.json from a normal ingest run.
"""
import concurrent.futures as cf
import glob
import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from ingest import get, fnum  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
DAYS = int(sys.argv[sys.argv.index("--since-days") + 1]) if "--since-days" in sys.argv else 760
NOW = int(time.time())
KALSHI_MAX_CANDLES = 10000  # per request, summed across tickers


def day_of(ts):
    return int(ts) // 86400


def kalshi_daily(tickers):
    """{ticker: {day: price}} from Kalshi daily candlesticks (bid/ask midpoint, else last trade)."""
    per = max(1, KALSHI_MAX_CANDLES // (DAYS + 2) - 1)
    out = {}
    for i in range(0, len(tickers), per):
        chunk = tickers[i:i + per]
        d = get("https://api.elections.kalshi.com/trade-api/v2/markets/candlesticks",
                {"market_tickers": ",".join(chunk), "start_ts": NOW - DAYS * 86400, "end_ts": NOW, "period_interval": 1440})
        for m in d.get("markets", []):
            series = {}
            for c in m.get("candlesticks", []):
                b = fnum((c.get("yes_bid") or {}).get("close_dollars"))
                a = fnum((c.get("yes_ask") or {}).get("close_dollars"))
                last = fnum((c.get("price") or {}).get("close_dollars"))
                if b is not None and a and a - b <= 0.1:
                    p = (a + b) / 2
                elif last:
                    p = last
                elif b is not None and a:
                    p = (a + b) / 2
                else:
                    continue
                series[day_of(c["end_period_ts"]) - 1] = p  # candle ending at midnight ET describes the day before
            out[m["market_ticker"]] = series
        time.sleep(0.15)  # stay well under Kalshi's public rate limit
        print(f"  kalshi {min(i + per, len(tickers))}/{len(tickers)}", end="\r", flush=True)
    print()
    return out


def poly_daily(tokens):
    """{token: {day: price}} from Polymarket's CLOB price history."""
    def one(tok):
        try:
            d = get("https://clob.polymarket.com/prices-history", {"market": tok, "interval": "max", "fidelity": 1440})
            # a point stamped just after midnight UTC is the previous day's close
            return tok, {day_of(h["t"] - 3600): float(h["p"]) for h in d.get("history", [])}
        except Exception:
            return tok, {}
    out = {}
    with cf.ThreadPoolExecutor(8) as ex:
        for n, (tok, s) in enumerate(ex.map(one, tokens), 1):
            out[tok] = s
            if n % 50 == 0 or n == len(tokens):
                print(f"  polymarket {n}/{len(tokens)}", end="\r", flush=True)
    print()
    return out


def shares_by_day(outcomes, series, key):
    """Per day, each party's share of the outcomes priced that day (carrying forward quiet days)."""
    days = sorted({d for o in outcomes for d in series.get(o[key], {})})
    last, result = {}, {}
    for d in days:
        for o in outcomes:
            v = series.get(o[key], {}).get(d)
            if v is not None:
                last[o[key]] = v
        priced = [o for o in outcomes if o[key] in last]
        if len(priced) < 2:
            continue
        tot = sum(last[o[key]] for o in priced) or 1
        result[d] = (sum(last[o[key]] for o in priced if o.get("pa") == "D") / tot,
                     sum(last[o[key]] for o in priced if o.get("pa") == "R") / tot)
    return result


def first_live_day():
    """Day live collection began, so backfill never overlaps live 10-minute points."""
    r = subprocess.run(["npx", "--yes", "wrangler@4", "d1", "execute", "ballottape-markets", "--remote", "--json",
                        "--command", "SELECT MIN(ts) AS t FROM race_history WHERE ts % 86400 != 43200"],
                       capture_output=True, text=True, cwd=os.path.dirname(HERE))
    try:
        return day_of(json.loads(r.stdout)[0]["results"][0]["t"])
    except Exception:
        return day_of(NOW)


def main():
    races = []  # (race_id, kalshi outcomes, polymarket outcomes)
    for f in sorted(glob.glob(os.path.join(OUT, "cycles", "*.json"))):
        c = json.load(open(f))
        for r in c["races"]:
            races.append((r["id"], (r.get("k") or {}).get("o", []), (r.get("p") or {}).get("o", [])))
        party = c.get("pres", {}).get("party")
        if party:
            races.append((f"{c['meta']['cycle']}-president", party.get("k", {}).get("o", []), party.get("p", {}).get("o", [])))
    tickers = sorted({o["id"] for _, ko, _ in races for o in ko if o.get("id")})
    tokens = sorted({o["tok"] for _, _, po in races for o in po if o.get("tok")})
    print(f"{len(races)} races, {len(tickers)} Kalshi markets, {len(tokens)} Polymarket markets, {DAYS} days")
    ks, ps = kalshi_daily(tickers), poly_daily(tokens)
    stop = first_live_day()
    rows = []
    for rid, ko, po in races:
        k, p = shares_by_day(ko, ks, "id"), shares_by_day(po, ps, "tok")
        for d in sorted(set(k) | set(p)):
            if d >= stop:
                continue
            kv, pv = k.get(d, (None, None)), p.get(d, (None, None))
            rows.append((rid, d * 86400 + 43200, *kv, *pv))
    fmt = lambda x: "NULL" if x is None else repr(round(x, 4))  # noqa: E731
    with open(os.path.join(OUT, "backfill.sql"), "w") as fh:
        for i in range(0, len(rows), 200):
            vals = ",".join(f"('{r[0]}',{r[1]},{fmt(r[2])},{fmt(r[3])},{fmt(r[4])},{fmt(r[5])})" for r in rows[i:i + 200])
            fh.write(f"INSERT OR IGNORE INTO race_history (race_id,ts,k_d,k_r,p_d,p_r) VALUES {vals};\n")
    span = (min(r[1] for r in rows), max(r[1] for r in rows)) if rows else (0, 0)
    print(f"{len(rows)} daily points for {len({r[0] for r in rows})} races, "
          f"{time.strftime('%Y-%m-%d', time.gmtime(span[0]))} to {time.strftime('%Y-%m-%d', time.gmtime(span[1]))} -> out/backfill.sql")


if __name__ == "__main__":
    main()
