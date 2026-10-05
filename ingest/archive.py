#!/usr/bin/env python3
"""Keep everything, every run. Runs after ingest.py (and the social and news steps), before publish.sh.

Writes:
  out/archive/snap.json.gz       every contract's price, quote, volume and open interest this run
                                 (uploaded to R2 archive/snap/YYYY/MM/DD/HHMM.json.gz)
  out/archive/books.json.gz      the full order book of every race contract on both exchanges, this run
                                 (archive/books/YYYY/MM/DD/HHMM.json.gz)
  out/archive/raw-*.json.gz      the exchanges' raw responses, once an hour; the whole politics board (every
                                 outcome) every run; LunarCrush's untouched responses whenever social.py ran
                                 (archive/raw/...)
  out/archive.sql                money-traded history, headlines, social posts, hourly social readings
                                 (D1 ballottape-markets)
  out/trades.sql                 every new trade on any contract whose volume moved (D1 ballottape-trades)

Trades: each contract has a cursor (last trade time and volume seen). Only contracts whose volume
changed since their cursor are fetched, from just after the last trade seen, so nothing is missed
even when a run is skipped, and quiet contracts cost nothing.
"""
import concurrent.futures as cf
import datetime
import glob
import gzip
import json
import os
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
from ingest import get, fnum, sql_str, sql_num  # noqa: E402
import config  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
ARC = os.path.join(OUT, "archive")
NOW = int(time.time())
WR = ["npx", "--yes", "wrangler@4"]
MAX_MARKETS = 500        # contracts fetched per run (busiest first); the rest wait for the next run
FIRST_LOOKBACK = 3 * 86400  # how far back to start a contract we've never collected
MAX_PAGES = 5
FRESH = 15 * 60          # an output file older than this was not written by this run
D1_WARN_GB = 7           # D1 databases stop at 10 GB; warn early enough to start the next cycle's database


def d1_rows(db, sql):
    r = subprocess.run(WR + ["d1", "execute", db, "--remote", "--json", "--command", sql],
                       capture_output=True, text=True, cwd=os.path.dirname(HERE))
    try:
        return json.loads(r.stdout)[0]["results"]
    except Exception:
        print(f"  d1 read failed on {db}: {(r.stderr or r.stdout)[-300:]}")
        return None


def cycles():
    return {int(os.path.basename(f)[:-5]): json.load(open(f)) for f in sorted(glob.glob(os.path.join(OUT, "cycles", "*.json")))}


def contracts(cyc):
    """Every contract in the cycle files: (src, market, race_id, name, volume, outcome dict)."""
    out = []
    for year, c in cyc.items():
        for r in c.get("races", []):
            for src in ("k", "p"):
                for o in ((r.get(src) or {}).get("o") or []):
                    out.append((src, o.get("id") if src == "k" else o.get("cid"), r["id"], o.get("n"), o.get("v"), o))
        for name, m in (c.get("pres") or {}).items():
            for src in ("k", "p"):
                for o in ((m or {}).get(src) or {}).get("o") or []:
                    if isinstance(o, dict):
                        out.append((src, o.get("id") if src == "k" else o.get("cid"), f"{year}-pres-{name}", o.get("n"), o.get("v"), o))
    return [x for x in out if x[1]]


# ---------------------------------------------------------------- files for R2
def write_files(cyc):
    shutil.rmtree(ARC, ignore_errors=True)  # only this run's files get uploaded
    os.makedirs(ARC, exist_ok=True)
    with gzip.open(os.path.join(ARC, "snap.json.gz"), "wt") as fh:
        json.dump({"ts": NOW, "cycles": cyc}, fh, separators=(",", ":"))
    n = 1
    try:
        books = order_books(cyc)
        with gzip.open(os.path.join(ARC, "books.json.gz"), "wt") as fh:
            json.dump(books, fh, separators=(",", ":"))
        n += 1
        print(f"  order books: {len(books['k'])} Kalshi, {len(books['p'])} Polymarket")
    except Exception as e:
        print(f"  order books failed: {str(e)[:200]}")
    raw = []
    if datetime.datetime.fromtimestamp(NOW, datetime.timezone.utc).minute < 10:  # exchange pulls hourly (large)
        raw += glob.glob(os.path.join(OUT, "raw", "*.json"))
    raw += [f for f in (os.path.join(OUT, "politics.json"), os.path.join(OUT, "lunarcrush_raw.json"))
            if os.path.exists(f) and NOW - os.path.getmtime(f) < FRESH]
    for f in raw:
        with open(f, "rb") as src, gzip.open(os.path.join(ARC, f"raw-{os.path.basename(f)}.gz"), "wb") as dst:
            shutil.copyfileobj(src, dst)
            n += 1
    return n


# ---------------------------------------------------------------- order books
def order_books(cyc):
    """Every race and presidential contract's full book, as each exchange returned it.
    Kalshi: both sides per ticker, 100 tickers a call. Polymarket: the Yes token's book (the No book mirrors it),
    500 tokens a call."""
    ks, ps = set(), set()
    for src, _market, _race, _name, _v, o in contracts(cyc):
        if src == "k" and o.get("id"):
            ks.add(o["id"])
        elif src == "p" and o.get("tok"):
            ps.add(o["tok"])
    ks, ps = sorted(ks), sorted(ps)
    kb, pb = [], []
    for i in range(0, len(ks), 100):
        kb += get("https://api.elections.kalshi.com/trade-api/v2/markets/orderbooks", {"tickers": ks[i:i + 100]}).get("orderbooks") or []
    for i in range(0, len(ps), 500):
        d = get("https://clob.polymarket.com/books", body=[{"token_id": t} for t in ps[i:i + 500]])
        pb += d if isinstance(d, list) else []
    return {"ts": NOW, "k": kb, "p": pb}


# ---------------------------------------------------------------- database size
def db_sizes():
    """Once a day: each D1 database's size, with a workflow warning when one nears the 10 GB cap."""
    if datetime.datetime.fromtimestamp(NOW, datetime.timezone.utc).strftime("%H%M") >= "0010":
        return
    for db in ("ballottape-markets", "ballottape-trades", "parlay-accounts", "ballottape-cms"):
        r = subprocess.run(WR + ["d1", "info", db, "--json"], capture_output=True, text=True, cwd=os.path.dirname(HERE))
        try:
            gb = json.loads(r.stdout)["database_size"] / 1e9
        except Exception:
            print(f"  d1 size unavailable for {db}")
            continue
        print(f"  d1 {db}: {gb:.2f} GB")
        if gb >= D1_WARN_GB:
            print(f"::warning::D1 {db} is {gb:.1f} GB of 10 GB. Start a new database for the next cycle "
                  f"(e.g. {db}-{datetime.date.today().year + 1}) and point new writes at it.")


# ---------------------------------------------------------------- money-traded history
def volume_sql(cyc):
    lines = []
    for year, c in cyc.items():
        try:
            prev = get(f"{config.SITE_URL}/api/v1/{year}.json")
            prev = {r["id"]: r for r in prev.get("races", [])} if isinstance(prev, dict) else {}
        except Exception:
            prev = {}
        for r in c.get("races", []):
            k, p = r.get("k") or {}, r.get("p") or {}
            kv24 = sum(((o.get("m") or {}).get("v24") or 0) for o in k.get("o", [])) if k else None
            pv24 = sum(((o.get("m") or {}).get("v24") or 0) for o in p.get("o", [])) if p else None
            koi = sum(((o.get("m") or {}).get("oi") or 0) for o in k.get("o", [])) if k else None
            pliq = sum(((o.get("m") or {}).get("liq") or 0) for o in p.get("o", [])) if p else None
            kv, pv = k.get("v"), p.get("v")
            was = prev.get(r["id"])
            hourly = datetime.datetime.fromtimestamp(NOW, datetime.timezone.utc).minute < 10  # full baseline once an hour
            if not hourly and was and (was.get("k") or {}).get("v") == kv and (was.get("p") or {}).get("v") == pv:
                continue  # no trading since the last run
            lines.append("INSERT OR REPLACE INTO volume_history (race_id,ts,k_v,p_v,k_v24,p_v24,k_oi,p_liq) VALUES ("
                         + ",".join([sql_str(r["id"]), str(NOW)] + [sql_num(x) for x in (kv, pv, kv24, pv24, koi, pliq)]) + ");")
    return lines


# ---------------------------------------------------------------- headlines and social
def news_sql():
    f = os.path.join(OUT, "news.json")
    if not os.path.exists(f):
        return []
    items = json.load(open(f)).get("items", [])
    return [f"INSERT OR IGNORE INTO news (url,title,source,tag,published,first_seen) VALUES ("
            f"{sql_str(n['url'])},{sql_str(n['title'])},{sql_str(n.get('source'))},{sql_str(n.get('tag'))},{sql_num(n.get('ts'))},{NOW});"
            for n in items if n.get("url") and n.get("title")]


def social_sql():
    f = os.path.join(OUT, "social.json")
    if not os.path.exists(f):
        return []
    s = json.load(open(f))
    if NOW - (s.get("generated") or 0) > 15 * 60:
        return []  # this run reused the previous pulse; nothing new to record
    hour = NOW - NOW % 3600
    lines = []
    for topic, p in (s.get("topics") or {}).items():
        lines.append("INSERT OR REPLACE INTO social_hourly (topic,ts,i24,contributors,posts24,sentiment,trend) VALUES ("
                     + ",".join([sql_str(topic), str(hour), sql_num(p.get("i24")), sql_num(p.get("contributors")),
                                 sql_num(p.get("posts24")), sql_num(p.get("sentiment")), sql_str(p.get("trend"))]) + ");")
        for post in p.get("top") or []:
            if not post.get("u"):
                continue
            lines.append("INSERT INTO social_posts (url,topic,title,author,network,interactions,sentiment,posted_at,first_seen,last_seen) VALUES ("
                         + ",".join([sql_str(post["u"]), sql_str(topic), sql_str(post.get("t")), sql_str(post.get("by")), sql_str(post.get("net")),
                                     sql_num(post.get("i")), sql_num(post.get("s")), sql_num(post.get("at")), str(NOW), str(NOW)])
                         + ") ON CONFLICT(url, topic) DO UPDATE SET interactions=excluded.interactions,sentiment=excluded.sentiment,last_seen=excluded.last_seen;")
    return lines


# ---------------------------------------------------------------- trades
def iso_ts(s):
    try:
        return int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except Exception:
        return None


def kalshi_trades(ticker, since):
    rows, cursor = [], None
    for _ in range(MAX_PAGES):
        params = {"ticker": ticker, "min_ts": since + 1, "limit": 1000}
        if cursor:
            params["cursor"] = cursor
        d = get("https://api.elections.kalshi.com/trade-api/v2/markets/trades", params)
        for t in d.get("trades", []):
            ts = iso_ts(t.get("created_time", ""))
            if ts is None:
                continue
            size = fnum(t.get("count_fp")) or fnum(t.get("count")) or 0
            yes = fnum(t.get("yes_price_dollars"))
            no = fnum(t.get("no_price_dollars"))
            side = t.get("taker_side")
            usd = size * ((yes if side == "yes" else no) or 0)
            rows.append((t.get("trade_id"), ts, side, yes, size, usd, None))
        cursor = d.get("cursor")
        if not cursor:
            break
    return rows


def poly_trades(cid, since):
    rows = []
    for page in range(MAX_PAGES):
        d = get("https://data-api.polymarket.com/trades", {"market": cid, "limit": 500, "offset": page * 500, "takerOnly": "true"})
        if not isinstance(d, list) or not d:
            break
        older = False
        for t in d:
            ts = int(t.get("timestamp") or 0)
            if ts <= since:
                older = True
                continue
            size, price = fnum(t.get("size")) or 0, fnum(t.get("price"))
            # the price of the side traded; express it as the Yes price for consistency
            yes = price if (t.get("outcomeIndex") in (0, None)) else (1 - price if price is not None else None)
            tid = f"{t.get('transactionHash')}:{t.get('asset')}:{t.get('side')}:{size}:{price}"
            rows.append((tid, ts, t.get("side"), yes, size, size * (price or 0), t.get("proxyWallet")))
        if older or len(d) < 500:
            break
    return rows


def trades_sql(cyc):
    cur = d1_rows("ballottape-trades", "SELECT src, market, last_ts, last_v FROM trade_cursor")
    if cur is None:
        return [], "trade cursors unavailable; skipped"
    cursors = {(r["src"], r["market"]): (r["last_ts"], r["last_v"]) for r in cur}
    todo, seen = [], set()
    for src, market, race_id, name, v, _o in contracts(cyc):
        if (src, market) in seen:
            continue
        seen.add((src, market))
        last_ts, last_v = cursors.get((src, market), (None, None))
        if v is None or (last_v is not None and abs(v - last_v) < 1e-9):
            continue
        todo.append(((v or 0) - (last_v or 0), src, market, race_id, name, v, last_ts or NOW - FIRST_LOOKBACK))
    todo.sort(reverse=True)
    todo = todo[:MAX_MARKETS]

    def one(job):
        _dv, src, market, race_id, name, v, since = job
        err = None
        for attempt in range(4):  # the exchanges rate-limit bursts; back off and retry
            try:
                rows = kalshi_trades(market, since) if src == "k" else poly_trades(market, since)
                return job, rows, None
            except Exception as e:
                err = str(e)[:120]
                time.sleep(1.5 * (attempt + 1))
        return job, [], err  # leave the cursor alone; the next run retries

    lines, n_trades, errs, min_ts = [], 0, 0, NOW
    with cf.ThreadPoolExecutor(6) as ex:
        for (_dv, src, market, race_id, name, v, since), rows, err in ex.map(one, todo):
            if err:
                errs += 1
                continue
            vals = [f"({sql_str(src)},{sql_str(tid)},{sql_str(market)},{sql_str(race_id)},{sql_str(name)},{ts},{sql_str(side)},"
                    f"{sql_num(yes)},{sql_num(size)},{sql_num(round(usd, 4))},{sql_str(wallet)})"
                    for tid, ts, side, yes, size, usd, wallet in rows if tid]
            for i in range(0, len(vals), 100):
                lines.append("INSERT OR IGNORE INTO trades (src,id,market,race_id,outcome,ts,side,yes_price,size,usd,wallet) VALUES "
                             + ",".join(vals[i:i + 100]) + ";")
            n_trades += len(vals)
            min_ts = min([min_ts] + [r[1] for r in rows])
            last = max([r[1] for r in rows] + [since])
            lines.append(f"INSERT OR REPLACE INTO trade_cursor (src,market,last_ts,last_v) VALUES ({sql_str(src)},{sql_str(market)},{last},{sql_num(v)});")
    if n_trades:
        # refresh the daily money rollup for every day these trades touched
        first_day = min_ts // 86400
        lines.append("INSERT OR REPLACE INTO trade_daily (race_id,day,src,usd,n,big) "
                     f"SELECT race_id, ts / 86400, src, SUM(usd), COUNT(*), MAX(usd) FROM trades WHERE ts >= {first_day * 86400} "
                     "AND race_id IS NOT NULL GROUP BY race_id, ts / 86400, src;")
    return lines, f"{n_trades} trades from {len(todo) - errs} contracts ({errs} failed, {len(seen)} followed)"


def main():
    cyc = cycles()
    if not cyc:
        sys.exit("no cycle files; run ingest.py first")
    files = write_files(cyc)
    db_sizes()
    a = volume_sql(cyc) + news_sql() + social_sql()
    open(os.path.join(OUT, "archive.sql"), "w").write("\n".join(a) + "\n")
    t, note = trades_sql(cyc)
    open(os.path.join(OUT, "trades.sql"), "w").write("\n".join(t) + "\n")
    print(f"archive: {files} files, {len(a)} history/news/social statements; {note}")


if __name__ == "__main__":
    main()
