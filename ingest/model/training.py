#!/usr/bin/env python3
"""Build the forecasting model's training set: decided U.S. races with daily prices from both exchanges.

Sources
  Kalshi      settled 2024/2025 race markets (historical API): Senate, House, governor, presidential states
  Polymarket  closed 2024/2025 race events: Senate, governor, presidential states, House races

Writes out/model/races.json: [{key, year, office, st, dist, eday, winner, k: {day: [D share, volume, open interest]},
p: {day: [D share, volume]}}], one per race, where day = unix day number and D share = the Democrat's share of the
two main parties' prices that day.

Usage: python3 ingest/model/training.py   (about 10 minutes; rate-limited to stay polite)
"""
import concurrent.futures as cf
import datetime
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "out", "model")
K = "https://api.elections.kalshi.com/trade-api/v2"
G = "https://gamma-api.polymarket.com"
EDAY = {2024: "2024-11-05", 2025: "2025-11-04"}

STATES = {
    "AL": "alabama", "AK": "alaska", "AZ": "arizona", "AR": "arkansas", "CA": "california", "CO": "colorado", "CT": "connecticut",
    "DE": "delaware", "DC": "washington-dc", "FL": "florida", "GA": "georgia", "HI": "hawaii", "ID": "idaho", "IL": "illinois",
    "IN": "indiana", "IA": "iowa", "KS": "kansas", "KY": "kentucky", "LA": "louisiana", "ME": "maine", "MD": "maryland",
    "MA": "massachusetts", "MI": "michigan", "MN": "minnesota", "MS": "mississippi", "MO": "missouri", "MT": "montana",
    "NE": "nebraska", "NV": "nevada", "NH": "new-hampshire", "NJ": "new-jersey", "NM": "new-mexico", "NY": "new-york",
    "NC": "north-carolina", "ND": "north-dakota", "OH": "ohio", "OK": "oklahoma", "OR": "oregon", "PA": "pennsylvania",
    "RI": "rhode-island", "SC": "south-carolina", "SD": "south-dakota", "TN": "tennessee", "TX": "texas", "UT": "utah",
    "VT": "vermont", "VA": "virginia", "WA": "washington", "WV": "west-virginia", "WI": "wisconsin", "WY": "wyoming",
}


def get(url, params=None):
    """GET JSON, retrying rate limits and empty answers with backoff."""
    if params:
        url += ("&" if "?" in url else "?") + "&".join(f"{k}={v}" for k, v in params.items())
    for i in range(6):
        r = subprocess.run(["curl", "-s", "--max-time", "60", "-H", "accept: application/json", url], capture_output=True, text=True)
        try:
            d = json.loads(r.stdout)
        except json.JSONDecodeError:
            d = None
        if d is not None and not (isinstance(d, dict) and d.get("error")):
            return d
        if isinstance(d, dict) and (d.get("error") or {}).get("code") == "not_found":
            return {}
        time.sleep(2 * (i + 1))
    return {}


def day(ts):
    return int(ts) // 86400


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------- Kalshi
RACE_SERIES = re.compile(r"^(?:SENATEPARTY-?([A-Z]{2})|SENATE([A-Z]{2})|HOUSE([A-Z]{2})(\d{1,2}|AL)|GOVPARTY([A-Z]{2})|PRESPARTY([A-Z]{2}))$")


def kalshi_key(series, year):
    m = RACE_SERIES.match(series)
    if not m:
        return None
    s1, s2, hs, hd, g, p = m.groups()
    if s1 or s2:
        return dict(office="senate", st=s1 or s2, dist=None)
    if hs:
        return dict(office="house", st=hs, dist="AL" if hd == "AL" else f"{int(hd):02d}")
    if g:
        return dict(office="governor", st=g, dist=None)
    return dict(office="president", st=p, dist=None)


def kalshi_candles(ticker, t0, t1):
    d = get(f"{K}/historical/markets/{ticker}/candlesticks", {"start_ts": t0, "end_ts": t1, "period_interval": 1440})
    out = {}
    for c in d.get("candlesticks", []) if isinstance(d, dict) else []:
        b = fnum((c.get("yes_bid") or {}).get("close"))
        a = fnum((c.get("yes_ask") or {}).get("close"))
        last = fnum((c.get("price") or {}).get("close"))
        if b is not None and a and a - b <= 0.1:
            px = (a + b) / 2
        elif last:
            px = last
        else:
            continue
        out[day(c["end_period_ts"]) - 1] = (px, fnum(c.get("volume")) or 0, fnum(c.get("open_interest")) or 0)
    return out


def kalshi_races():
    series = get(f"{K}/series", {"category": "Elections"}).get("series", []) + get(f"{K}/series", {"category": "Politics"}).get("series", [])
    names = sorted({s["ticker"] for s in series if RACE_SERIES.match(s["ticker"])})
    print(f"kalshi: {len(names)} race series")

    def one(s):
        races = []
        for yy, year in (("24", 2024), ("25", 2025)):
            ms = [m for m in get(f"{K}/historical/markets", {"event_ticker": f"{s}-{yy}", "limit": 50}).get("markets", [])
                  if m.get("result") in ("yes", "no")]
            party = {}
            for m in ms:
                pa = ((m.get("custom_strike") or {}).get("Party") or "")[:1] or m["ticker"].rsplit("-", 1)[-1][:1]
                if pa in ("D", "R"):
                    party[pa] = m
            if "D" not in party or "R" not in party:
                continue
            key = kalshi_key(s, year)
            t1 = int(datetime.datetime.fromisoformat(EDAY[year] + "T23:00:00-05:00").timestamp())
            t0 = min(int(datetime.datetime.fromisoformat(m["open_time"].replace("Z", "+00:00")).timestamp()) for m in party.values())
            cd, cr = kalshi_candles(party["D"]["ticker"], t0, t1), kalshi_candles(party["R"]["ticker"], t0, t1)
            series_ = {}
            for dd in set(cd) & set(cr):
                pd_, pr = cd[dd][0], cr[dd][0]
                if pd_ + pr > 0:
                    series_[dd] = [round(pd_ / (pd_ + pr), 4), cd[dd][1] + cr[dd][1], cd[dd][2] + cr[dd][2]]
            if (party["D"]["result"] == "yes") == (party["R"]["result"] == "yes"):
                continue  # not exactly one winner (e.g. a party-label quirk): unusable
            winner = "D" if party["D"]["result"] == "yes" else "R"
            names_ = {pa: m.get("yes_sub_title") for pa, m in party.items()}
            races.append(dict(year=year, eday=EDAY[year], winner=winner, names=names_, k=series_, src_k=s, **key))
        return races

    out = []
    with cf.ThreadPoolExecutor(3) as ex:
        for i, rs in enumerate(ex.map(one, names), 1):
            out += rs
            if i % 25 == 0:
                print(f"  kalshi {i}/{len(names)} series, {len(out)} decided races", flush=True)
    return out


# ---------------------------------------------------------------- Polymarket
KNOWN_PARTY = {"donald trump": "R", "trump": "R", "kamala harris": "D", "harris": "D", "republican": "R", "republicans": "R",
               "democrat": "D", "democrats": "D", "democratic": "D"}


def poly_history(token):
    d = get("https://clob.polymarket.com/prices-history", {"market": token, "interval": "max", "fidelity": 1440})
    return {day(h["t"] - 3600): float(h["p"]) for h in (d.get("history", []) if isinstance(d, dict) else [])}


def poly_event(slug, key, year, party_of_name):
    d = get(f"{G}/events", {"slug": slug})
    if not d:
        return None
    e = d[0]
    cands = {}
    ms = e.get("markets", [])
    if len(ms) == 1 and len(json.loads(ms[0].get("outcomes") or "[]")) == 2:
        # head-to-head as one market: outcomes are the two candidates ("Jones" / "Lawler")
        m = ms[0]
        outs, prices, toks = (json.loads(m.get(k) or "[]") for k in ("outcomes", "outcomePrices", "clobTokenIds"))
        for name, price, tok in zip(outs, prices, toks):
            pa = party_of_name(name)
            if pa in ("D", "R"):
                cands.setdefault(pa, (name, tok, price == "1", float(m.get("volume") or 0)))
        ms = []
    for m in ms:
        name = (m.get("groupItemTitle") or m.get("question") or "").strip()
        pa = party_of_name(name)
        prices = json.loads(m.get("outcomePrices") or "[]")
        toks = json.loads(m.get("clobTokenIds") or "[]")
        if pa in ("D", "R") and toks and prices:
            cands.setdefault(pa, (name, toks[0], prices[0] == "1", float(m.get("volume") or 0)))
    if "D" not in cands or "R" not in cands:
        return None
    hd, hr = poly_history(cands["D"][1]), poly_history(cands["R"][1])
    eday = day(datetime.datetime.fromisoformat(EDAY[year] + "T12:00:00-05:00").timestamp())
    series_ = {dd: [round(hd[dd] / (hd[dd] + hr[dd]), 4), None] for dd in set(hd) & set(hr) if dd <= eday and hd[dd] + hr[dd] > 0}
    if cands["D"][2] == cands["R"][2]:
        return None  # unresolved or both "won": skip
    return dict(year=year, eday=EDAY[year], winner="D" if cands["D"][2] else "R", names={pa: c[0] for pa, c in cands.items()},
                p=series_, src_p=slug, **key)


def poly_races(name_party):
    def party_of_name(n):
        low = n.lower()
        m = re.search(r"\((d|r)\)", low)
        if m:
            return m.group(1).upper()
        for k, v in KNOWN_PARTY.items():
            if low == k or low.startswith(k + " "):
                return v
        words = [w for w in re.sub(r"[.,]", "", low).split() if w not in ("jr", "sr", "ii", "iii", "iv")]
        return name_party.get(" ".join(words)) or (name_party.get(words[-1]) if words else None)

    jobs = []
    for st, name in STATES.items():
        jobs.append((f"{name}-us-senate-election-winner", dict(office="senate", st=st, dist=None), 2024))
        jobs.append((f"{name}-presidential-election-winner", dict(office="president", st=st, dist=None), 2024))
        jobs.append((f"{name}-governor-election-winner", dict(office="governor", st=st, dist=None), 2024))
    jobs += [("new-jersey-governor-election-winner-2025", dict(office="governor", st="NJ", dist=None), 2025),
             ("virginia-governor-election-winner", dict(office="governor", st="VA", dist=None), 2025)]
    # House races: closed events under the house-races tag, slugs like "ny-17-election-jones-d-vs-lawler-r"
    for e in get(f"{G}/events", {"tag_slug": "house-races", "closed": "true", "limit": 200, "end_date_min": "2024-10-01", "end_date_max": "2024-12-31"}) or []:
        # the district comes from the title ("CA-41 election: ..."); some slugs carry the wrong one
        m = re.match(r"^\s*([A-Za-z]{2})-(\d{1,2}|AL|al)\b", e.get("title") or "") or re.match(r"^([a-z]{2})-(\d{1,2}|al)-", e["slug"])
        if m and m.group(1).upper() in STATES:
            for nm, pa in re.findall(r"([a-z]+)-(d|r)(?=-|$)", e["slug"]):
                name_party.setdefault(nm, pa.upper())
            d_ = m.group(2).lower()
            jobs.append((e["slug"], dict(office="house", st=m.group(1).upper(), dist="AL" if d_ == "al" else f"{int(d_):02d}"), 2024))
    out = []
    with cf.ThreadPoolExecutor(4) as ex:
        for r in ex.map(lambda j: poly_event(j[0], j[1], j[2], party_of_name), jobs):
            if r:
                out.append(r)
    print(f"polymarket: {len(out)} decided races from {len(jobs)} candidate events")
    return out


# ---------------------------------------------------------------- merge
def race_key(r):
    return f"{r['year']}-{r['office']}-{r['st']}" + (f"-{r['dist']}" if r.get("dist") else "")


def main():
    os.makedirs(OUT, exist_ok=True)
    ks = kalshi_races()
    # candidate names -> party from Kalshi, to label Polymarket candidates that carry no party tag
    name_party = {}
    for r in ks:
        for pa, n in (r.get("names") or {}).items():
            if n:
                words = [w for w in re.sub(r"[.,]", "", n.lower()).split() if w not in ("jr", "sr", "ii", "iii", "iv")]
                name_party[" ".join(words)] = pa
                if words:
                    name_party[words[-1]] = pa
    ps = poly_races(name_party)
    races = {}
    for r in ks + ps:
        k = race_key(r)
        cur = races.setdefault(k, dict(key=k, year=r["year"], office=r["office"], st=r["st"], dist=r.get("dist"),
                                        eday=r["eday"], winner=r["winner"], names=r.get("names"), k={}, p={}))
        if cur["winner"] != r["winner"]:
            print(f"  ! winner disagrees for {k}; dropping")
            cur["conflict"] = True
        if r.get("k") and len(r["k"]) > len(cur["k"]):
            cur["k"] = r["k"]
        if r.get("p") and len(r["p"]) > len(cur["p"]):
            cur["p"] = r["p"]
    out = [r for r in races.values() if not r.get("conflict") and (r["k"] or r["p"])]
    json.dump(out, open(os.path.join(OUT, "races.json"), "w"), separators=(",", ":"))
    from collections import Counter
    print(f"{len(out)} decided races -> out/model/races.json", dict(Counter(r["office"] for r in out)),
          f"| both exchanges: {sum(1 for r in out if r['k'] and r['p'])}")


if __name__ == "__main__":
    main()
