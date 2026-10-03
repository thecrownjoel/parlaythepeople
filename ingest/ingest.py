#!/usr/bin/env python3
"""Parlay the People collector.

Pulls every open US election market from Kalshi and Polymarket, files each one by
cycle (election year), office and place, and writes:

  out/cycles/<year>.json   everything the site shows for that cycle
  out/index.json           which cycles exist and which one is next
  out/unmatched.json       election markets the classifier didn't recognise (review list)
  out/d1.sql               upserts for the races index and the price-history table

Usage:  python3 ingest/ingest.py [--cached]
--cached reuses the raw pulls in out/raw/ instead of calling the exchanges.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.parse
from collections import Counter

sys.path.insert(0, os.path.dirname(__file__))
import config  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
RAW = os.path.join(OUT, "raw")
NOW = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)

ST = {'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado',
      'CT': 'Connecticut', 'DE': 'Delaware', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho',
      'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana',
      'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
      'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
      'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina',
      'ND': 'North Dakota', 'OH': 'Ohio', 'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania',
      'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
      'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia',
      'WI': 'Wisconsin', 'WY': 'Wyoming'}
NAME2AB = {v.lower(): k for k, v in ST.items()}
US_WORDS = re.compile(r"\b(U\.?S\.?|Congress|House|Senate|Governor|President|Presidential|Electoral|"
                      + "|".join(ST.values()) + r")\b")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


def fnum(x):
    return float(x) if x not in (None, "") else None


# ---------------------------------------------------------------- fetching
def get(url, params=None, body=None, tries=3):
    if params:
        url += "?" + urllib.parse.urlencode(params, doseq=True)
    cmd = ["curl", "-s", "--max-time", "60", "-H", "accept: application/json", url]
    if body is not None:
        cmd += ["-X", "POST", "-H", "content-type: application/json", "-d", json.dumps(body)]
    for i in range(tries):
        r = subprocess.run(cmd, capture_output=True, text=True)
        try:
            return json.loads(r.stdout)
        except json.JSONDecodeError:
            if i == tries - 1:
                raise RuntimeError(f"Bad response from {url[:120]}: {r.stdout[:200]!r}")


def fetch_kalshi():
    out, cur = [], ""
    while True:
        q = {"status": "open", "limit": 200, "with_nested_markets": "true"}
        if cur:
            q["cursor"] = cur
        d = get("https://api.elections.kalshi.com/trade-api/v2/events", q)
        out += [e for e in d.get("events", []) if e.get("category") in config.KALSHI_CATEGORIES]
        cur = d.get("cursor")
        if not cur or not d.get("events"):
            return out


def fetch_polymarket():
    seen, out = set(), []
    for tag in config.POLYMARKET_TAGS:
        off = 0
        while off < 5000:
            page = get("https://gamma-api.polymarket.com/events",
                       {"tag_slug": tag, "closed": "false", "limit": 100, "offset": off})
            if not page:
                break
            for e in page:
                if e["id"] not in seen:
                    seen.add(e["id"])
                    out.append(e)
            off += 100
    return out


def load_raw(cached):
    os.makedirs(RAW, exist_ok=True)
    kf, pf = os.path.join(RAW, "kalshi.json"), os.path.join(RAW, "polymarket.json")
    if cached and os.path.exists(kf) and os.path.exists(pf):
        return json.load(open(kf)), json.load(open(pf))
    k, p = fetch_kalshi(), fetch_polymarket()
    json.dump(k, open(kf, "w"))
    json.dump(p, open(pf, "w"))
    return k, p


# ---------------------------------------------------------------- prices
def kprice(m):
    """Kalshi: bid/ask midpoint, or last trade when the spread is wider than 10 cents."""
    b, a, l = fnum(m.get("yes_bid_dollars")), fnum(m.get("yes_ask_dollars")), fnum(m.get("last_price_dollars"))
    vol = fnum(m.get("volume_fp")) or 0
    prev = fnum(m.get("previous_price_dollars"))
    spread = (a - b) if (a is not None and b is not None) else 1
    if b is not None and a and spread <= 0.1:
        p = (a + b) / 2
    elif l and vol > 0:
        p = l
    else:
        p = ((b or 0) + (a or 0)) / 2
    d = round(l - prev, 4) if (l is not None and prev) else None
    return p, spread > 0.1 or vol < 500, vol, d


def pprice(m):
    try:
        return float(json.loads(m["outcomePrices"])[0])
    except (KeyError, TypeError, ValueError, IndexError):
        return None


def ptoken(m):
    try:
        return json.loads(m["clobTokenIds"])[0]
    except (KeyError, TypeError, ValueError, IndexError):
        return None


def p_active(e):
    return [m for m in e.get("markets", []) if m.get("active") and not m.get("closed") and m.get("outcomePrices")]


def party_of(*texts):
    t = " ".join(x or "" for x in texts).lower()
    if re.search(r"democrat|\(d\)", t):
        return "D"
    if re.search(r"republican|\(r\)|\bgop\b", t):
        return "R"
    if re.search(r"independent|\(i\)", t):
        return "I"
    return None


# ---------------------------------------------------------------- cycles
def even_cycle(year):
    return year if year % 2 == 0 else year - 1


def k_cycle(e, settles_after=False):
    """Election year for a Kalshi event. Races keep odd years (e.g. Kentucky governor 2027);
    markets that settle after the election (seat counts, balance of power, ballot measures)
    pass settles_after=True and are pulled back to the even election year."""
    fix = even_cycle if settles_after else (lambda y: y)
    rules = (e.get("markets") or [{}])[0].get("rules_primary") or ""
    m = re.search(r"\b(20\d\d) (?:general |midterm |presidential |U\.S\. )?elections?\b", rules)
    if m:
        return int(m.group(1))
    m = re.search(r"\((20\d\d)\)", e.get("title", "")) or re.search(r"In (20\d\d)", e.get("sub_title") or "")
    if m:
        return fix(int(m.group(1)))
    m = re.search(r"-(\d{4}|\d{2})(?:[A-Z]{3}\d{0,2}|[A-Z]{0,4})?$", e["event_ticker"])
    if m:
        y = int(m.group(1))
        return fix(y if y > 1000 else 2000 + y)
    close = (e.get("markets") or [{}])[0].get("close_time") or ""
    return even_cycle(int(close[:4])) if close[:4].isdigit() else None


SETTLES_AFTER = re.compile(r"^(KXBALANCEPOWERCOMBO|RSENATESEATS|KXRHOUSESEATS|KXHOUSEPOPVOTEMARGIN|"
                           r"KXSTATEBALLOTMEASURE|KXCABALLOTMEASURES|KXFLPROPERTYTAX|CONTROL[SH])")


def p_cycle(e):
    m = re.search(r"(20\d\d)", e["slug"])
    if m and 2020 < int(m.group(1)) < 2100:
        return even_cycle(int(m.group(1)))
    end = e.get("endDate") or ""
    return even_cycle(int(end[:4])) if end[:4].isdigit() else None


def election_day(cycle):
    if cycle in config.ELECTION_DAYS:
        return config.ELECTION_DAYS[cycle]
    d = datetime.date(cycle, 11, 2)  # Tuesday after the first Monday in November
    while d.weekday() != 1:
        d += datetime.timedelta(days=1)
    return d.isoformat()


# ---------------------------------------------------------------- data model
class Cycle:
    def __init__(self, year):
        self.year = year
        self.races = {}
        self.big = {"bop": {}, "senate": {"maj": 50}, "house": {"maj": 218}, "pv": {}, "ballots": []}
        self.pres = {}

    def race(self, office, st=None, dist=None):
        if office in ("senate-control", "house-control"):
            rid, label = f"{self.year}-{office}", ("Senate control" if office == "senate-control" else "House control")
            kind, path = "control", f"/{self.year}/{office.split('-')[0]}/control/"
        elif office == "house":
            d = "AL" if dist == "AL" else str(int(dist))
            rid = f"{self.year}-house-{st.lower()}-{d.lower()}"
            label = f"{st}-{'AL' if d == 'AL' else d.zfill(2)}"
            kind, path = "house", f"/{self.year}/house/{st.lower()}-{d.lower()}/"
            dist = d
        else:
            rid = f"{self.year}-{office}-{slug(ST[st])}"
            label = f"{ST[st]} {'Senate' if office == 'senate' else 'Governor'}"
            kind, path = office, f"/{self.year}/{office}/{slug(ST[st])}/"
        return self.races.setdefault(rid, {"id": rid, "cycle": self.year, "kind": kind, "st": st or "US",
                                           "state": ST.get(st, "United States"), "dist": dist, "label": label,
                                           "path": path, "k": None, "p": None})


CYCLES = {}


def cyc(year):
    if year not in CYCLES:
        CYCLES[year] = Cycle(year)
    return CYCLES[year]


def k_outcomes(e):
    out = []
    for m in e["markets"]:
        p, _thin, vol, d = kprice(m)
        par = party_of(m.get("subtitle")) or {"D": "D", "R": "R", "I": "I"}.get(m["ticker"].rsplit("-", 1)[-1])
        out.append({"id": m["ticker"], "n": m.get("yes_sub_title") or m["ticker"], "pa": par,
                    "p": round(p, 4), "d": d, "v": round(vol)})
    return out


def p_outcomes(e):
    out = []
    for m in p_active(e):
        p = pprice(m)
        if p is None or (p <= 0.0006 and float(m.get("volume") or 0) < 1):
            continue
        name = m.get("groupItemTitle") or m.get("question")
        par = party_of(name, m.get("question"))
        name = re.sub(r"\s*\((D|R|I)\)\s*$", "", name).replace("Sen. ", "").replace("Gov. ", "")
        if name in ("Democratic Party", "Democrats", "Democratic"):
            name = "Democrats"
        if name in ("Republican Party", "Republicans", "Republican"):
            name = "Republicans"
        out.append({"tok": ptoken(m), "n": name, "pa": par, "p": round(p, 4),
                    "d": m.get("oneDayPriceChange"), "v": round(float(m.get("volume") or 0))})
    return out


def kalshi_url(series):
    return f"https://kalshi.com/markets/{series.lower()}"


def poly_url(slug_):
    return f"https://polymarket.com/event/{slug_}"


# ---- bins (seat counts, popular vote)
def parse_seat_bin(label):
    L = label.strip().lower().replace("–", "-")
    if m := re.match(r"^(below|<)\s*(\d+)$", L):
        return None, int(m.group(2)) - 1
    if m := re.match(r"^(≤|<=)\s*(\d+)$", L):
        return None, int(m.group(2))
    if m := re.match(r"^above\s*(\d+)$", L):
        return int(m.group(1)) + 1, None
    if m := re.match(r"^(\d+)\s*(\+|or more|and above)$", L):
        return int(m.group(1)), None
    if m := re.match(r"^(\d+)\s*-\s*(\d+)$", L):
        return int(m.group(1)), int(m.group(2))
    if m := re.match(r"^(\d+)$", L):
        return int(m.group(1)), int(m.group(1))
    raise ValueError(label)


def parse_pv_bin(label):
    L = label.lower()
    nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", L)]
    if "republicans win" in L:
        return -100, 0
    sign = -1 if L.startswith("republican") else 1
    lo, hi = (nums[0], 100) if ("+" in L or "above" in L) else (nums[0], nums[1])
    return (lo, hi) if sign > 0 else (-hi, -lo)


def finish_bins(bins, url, v):
    bins.sort(key=lambda b: (b["lo"] if b["lo"] is not None else -999))
    t = sum(b["p"] for b in bins) or 1
    for b in bins:
        b["p"] = round(b["p"] / t, 4)
    return {"bins": bins, "url": url, "v": round(v)}


def k_bins(e, parser):
    bins = []
    for m in e["markets"]:
        lo, hi = parser(m["yes_sub_title"])
        bins.append({"id": m["ticker"], "l": m["yes_sub_title"], "lo": lo, "hi": hi, "p": kprice(m)[0]})
    return finish_bins(bins, kalshi_url(e["series_ticker"]), sum(fnum(m.get("volume_fp")) or 0 for m in e["markets"]))


def p_bins(e, parser):
    bins = []
    for m in p_active(e):
        lo, hi = parser(m["groupItemTitle"])
        bins.append({"tok": ptoken(m), "l": m["groupItemTitle"], "lo": lo, "hi": hi, "p": pprice(m) or 0})
    return finish_bins(bins, poly_url(e["slug"]), e.get("volume") or 0)


def norm(d):
    t = sum(d.values()) or 1
    return {k: round(v / t, 4) for k, v in d.items()}


# ---------------------------------------------------------------- classify Kalshi
UNMATCHED = []
UNMATCHED_K = {}


def classify_kalshi(kev):
    for e in kev:
        s, t, et = e["series_ticker"], e["title"], e["event_ticker"]
        if not e.get("markets"):
            continue
        year = k_cycle(e, settles_after=bool(SETTLES_AFTER.match(s)))
        if not year or year < NOW.year - (NOW.year % 2):
            continue
        C = cyc(year)
        tl = t.lower()
        primaryish = re.search(r"nominee|primary|caucus|runoff", tl)

        if s in ("CONTROLS", "CONTROLH"):
            r = C.race("senate-control" if s == "CONTROLS" else "house-control")
        elif re.match(r"^(KX)?SENATE(PARTY)?-?[A-Z]{2,3}$", s) and not primaryish and \
                (m := re.match(r"^(.+?) Senate (winner|race)", t)) and m.group(1).lower() in NAME2AB:
            r = C.race("senate", NAME2AB[m.group(1).lower()])
            if re.match(r"^(KX)?SENATE[A-Z]{2}S$", s):  # special election
                r["special"] = True
        elif re.match(r"^(GOVPARTY|KXGOV)-?[A-Z]{2}$", s) and not primaryish and \
                (m := re.match(r"^(.+?) [Gg]overnor", t)) and m.group(1).lower() in NAME2AB:
            r = C.race("governor", NAME2AB[m.group(1).lower()])
        elif (m := re.match(r"^(?:KX)?HOUSE(?:PARTY-?)?([A-Z]{2})(\d+|AL)$", s)) and m.group(1) in ST and not primaryish:
            r = C.race("house", m.group(1), m.group(2))
        elif s == "KXHOUSERACE" and (m := re.match(r"^KXHOUSERACE-([A-Z]{2})(\d+|AL)-", et)) and m.group(1) in ST:
            r = C.race("house", m.group(1), m.group(2))
        elif s in ("KXPRESPERSON", "KXPRESPARTY", "KXPRESNOMD", "KXPRESNOMR"):
            key = {"KXPRESPERSON": "winner", "KXPRESPARTY": "party", "KXPRESNOMD": "nomD", "KXPRESNOMR": "nomR"}[s]
            C.pres.setdefault(key, {})["k"] = {"o": sorted(k_outcomes(e), key=lambda o: -o["p"]),
                                              "url": kalshi_url(s), "t": et}
            continue
        elif s == "KXBALANCEPOWERCOMBO":
            d = {m["ticker"].rsplit("-", 1)[-1]: kprice(m)[0] for m in e["markets"]}
            C.big["bop"]["k"] = {"ids": {m["ticker"].rsplit("-", 1)[-1]: m["ticker"] for m in e["markets"]},
                                 "o": norm({k: d.get(k, 0) for k in ["DD", "DR", "RD", "RR"]}),
                                 "url": kalshi_url(s), "v": round(sum(fnum(m.get("volume_fp")) or 0 for m in e["markets"]))}
            continue
        elif s == "RSENATESEATS":
            C.big["senate"]["k"] = k_bins(e, parse_seat_bin)
            continue
        elif s == "KXRHOUSESEATS":
            C.big["house"]["k"] = k_bins(e, parse_seat_bin)
            continue
        elif s == "KXHOUSEPOPVOTEMARGIN":
            C.big["pv"]["k"] = k_bins(e, parse_pv_bin)
            continue
        elif s.startswith("KXSTATEBALLOTMEASURE") or s.startswith("KXCABALLOTMEASURES") or s == "KXFLPROPERTYTAX":
            st = NAME2AB.get((e.get("sub_title") or "").lower()) or ("CA" if "CABALLOT" in s else "FL" if "FLPROPERTY" in s else None)
            if not st:
                continue
            for m in e["markets"]:
                mm = re.search(r"If (?:the )?(.+?) passes", m.get("rules_primary") or "")
                name = mm.group(1) if mm else m["yes_sub_title"]
                name = re.sub(r"\s+in (the state of )?" + ST[st] + "$", "", name)
                name = re.sub(r"^" + ST[st] + r"\s+", "", name).strip()
                p, thin, vol, _d = kprice(m)
                C.big["ballots"].append({"id": m["ticker"], "src": "k", "st": st, "n": name, "p": round(p, 4),
                                         "thin": thin, "v": round(vol), "url": kalshi_url(s)})
            continue
        else:
            if e.get("category") == "Elections" and US_WORDS.search(t) and not primaryish:
                v = round(sum(fnum(m.get("volume_fp")) or 0 for m in e["markets"]))
                u = UNMATCHED_K.setdefault(s, {"src": "kalshi", "ref": s, "title": t, "cycle": year,
                                               "url": kalshi_url(s), "v": 0, "events": 0})
                u["v"] += v
                u["events"] += 1
            continue

        oc = k_outcomes(e)
        if oc and not (r["k"] and len(r["k"]["o"]) >= len(oc)):  # prefer the party market over a person market
            r["k"] = {"o": oc, "url": kalshi_url(s), "t": et}


# ---------------------------------------------------------------- classify Polymarket
P_PATTERNS = [
    (r"^which-party-will-win-the-senate-in-(\d{4})$", "senate-control"),
    (r"^which-party-will-win-the-house-in-(\d{4})$", "house-control"),
    (r"^([a-z-]+?)-senate-election-winner(?:-(?:\d{4}|\d{1,3}))?$", "senate"),
    (r"^([a-z-]+?)-governor-(?:election-)?winner(?:-\d{4})?$", "governor"),
    (r"^([a-z-]+?)-governor-election-\d{4}$", "governor"),
    (r"^([a-z]{2})-(\d{2}|al)-house-election-winner(?:-\d{4})?$", "house"),
    (r"^which-party-will-win-the-house-race-for-the-([a-z]{2})-(\d{2})-seat$", "house"),
    (r"^presidential-election-winner-\d{4}$", "pres:winner"),
    (r"^which-party-wins-\d{4}-us-presidential-election$", "pres:party"),
    (r"^democratic-presidential-nominee-\d{4}$", "pres:nomD"),
    (r"^republican-presidential-nominee-\d{4}$", "pres:nomR"),
    (r"^balance-of-power-\d{4}-midterms$", "big:bop"),
    (r"^republican-senate-seats-after-the-\d{4}-midterm-elections(?:-\d+)?$", "big:senate"),
    (r"^republican-house-seats-after-the-\d{4}-midterm-elections(?:-\d+)?$", "big:house"),
    (r"^\d{4}-midterms-house-popular-vote-margin-of-victory(?:-\d+)?$", "big:pv"),
    (r"(^will-.*-pass$|passes-ballot-measure|^will-michigan-vote-to-rewrite|^idaho-passes)", "ballot"),
]
BOP_MAP = {"Democrats Sweep": "DD", "R Senate, D House": "DR", "D Senate, R House": "RD", "Republicans Sweep": "RR"}


def classify_polymarket(pev):
    for e in pev:
        sl = e["slug"]
        year = p_cycle(e)
        if not year or year < NOW.year - (NOW.year % 2):
            continue
        hit = None
        for pat, what in P_PATTERNS:
            if m := re.search(pat, sl):
                hit = (m, what)
                break
        if not hit:
            if US_WORDS.search(e.get("title", "")) and (e.get("volume") or 0) >= 1000:
                UNMATCHED.append({"src": "polymarket", "ref": sl, "title": e.get("title"), "cycle": year,
                                  "url": poly_url(sl), "v": round(e.get("volume") or 0)})
            continue
        m, what = hit
        C = cyc(year)
        if what.startswith("pres:"):
            C.pres.setdefault(what[5:], {})["p"] = {"o": sorted(p_outcomes(e), key=lambda o: -o["p"]),
                                                    "url": poly_url(sl), "v": round(e.get("volume") or 0)}
            continue
        if what == "big:bop":
            ms = p_active(e)
            d = {BOP_MAP[x["groupItemTitle"]]: pprice(x) for x in ms if x.get("groupItemTitle") in BOP_MAP}
            C.big["bop"]["p"] = {"toks": {BOP_MAP[x["groupItemTitle"]]: ptoken(x) for x in ms if x.get("groupItemTitle") in BOP_MAP},
                                 "o": norm(d), "url": poly_url(sl), "v": round(e.get("volume") or 0)}
            continue
        if what in ("big:senate", "big:house"):
            C.big[what[4:]]["p"] = p_bins(e, parse_seat_bin)
            continue
        if what == "big:pv":
            C.big["pv"]["p"] = p_bins(e, parse_pv_bin)
            continue
        if what == "ballot":
            ms = p_active(e)
            st = next((ab for nm, ab in NAME2AB.items() if nm in e["title"].lower()), None)
            if len(ms) != 1 or not st:
                continue
            name = re.sub(r"^(Will (the )?)", "", e["title"]).rstrip("?")
            name = re.sub(r"\s*pass(es)?$", "", name)
            name = re.sub(r"^" + ST[st] + r"\s+(passes\s+)?", "", name)
            name = re.sub(r"^(Ballot measure |Vote to |To )", "", name, flags=re.I)
            name = re.sub(r"^(.+?), Texas passes ballot measure ", r"\1: ", name)
            name = name[0].upper() + name[1:]
            v = float(e.get("volume") or 0)
            C.big["ballots"].append({"tok": ptoken(ms[0]), "src": "p", "st": st, "n": name,
                                     "p": round(pprice(ms[0]), 4), "thin": v < 500, "v": round(v), "url": poly_url(sl)})
            continue
        if what in ("senate-control", "house-control"):
            r = C.race(what)
        elif what == "house":
            st = m.group(1).upper()
            if st not in ST:
                continue
            r = C.race("house", st, m.group(2).upper())
        else:
            st = NAME2AB.get(m.group(1).replace("-", " "))
            if not st:
                continue
            r = C.race(what, st)
        oc = p_outcomes(e)
        if oc:
            r["p"] = {"o": oc, "url": poly_url(sl), "v": round(e.get("volume") or 0)}


# ---------------------------------------------------------------- finishing
GENERIC = re.compile(r"^(democrat|democrats|democratic party|republican|republicans|republican party|independent|other|democratic|party [a-z])$", re.I)


def finish_cycle(C):
    # party for person-only outcomes: match names seen elsewhere in the same race
    for r in C.races.values():
        seen = {}
        for src in ("k", "p"):
            for o in (r[src] or {}).get("o", []):
                if o["pa"] and not GENERIC.match(o["n"]):
                    seen[o["n"].lower().split()[-1]] = o["pa"]
        hints = config.PARTY_HINTS.get(r["id"], {})
        for src in ("k", "p"):
            s = r[src]
            if not s:
                continue
            for o in s["o"]:
                last = o["n"].lower().split()[-1] if o["n"].split() else ""
                if not o["pa"]:
                    o["pa"] = seen.get(last) or hints.get(last)
            s["o"].sort(key=lambda o: -o["p"])
            tot = sum(o["p"] for o in s["o"]) or 1
            s["D"] = round(sum(o["p"] for o in s["o"] if o["pa"] == "D") / tot, 4)
            s["R"] = round(sum(o["p"] for o in s["o"] if o["pa"] == "R") / tot, 4)
            if src == "k":
                s["v"] = sum(o["v"] for o in s["o"])
        # consensus numbers for the index / history
        srcs = [r[x] for x in ("k", "p") if r[x]]
        r["D"] = round(sum(x["D"] for x in srcs) / len(srcs), 4)
        r["R"] = round(sum(x["R"] for x in srcs) / len(srcs), 4)
    # presidency: tag winner candidates with the party of the nominee market they appear in
    party_by_name = {}
    for key, pa in (("nomD", "D"), ("nomR", "R")):
        for src in ("k", "p"):
            for o in C.pres.get(key, {}).get(src, {}).get("o", []):
                party_by_name[name_key(o["n"])] = pa
    for src in ("k", "p"):
        for o in C.pres.get("winner", {}).get(src, {}).get("o", []):
            o["pa"] = o.get("pa") or party_by_name.get(name_key(o["n"]))
        for o in C.pres.get("party", {}).get(src, {}).get("o", []):
            o["pa"] = o.get("pa") or party_of(o["n"])
    C.races = {k: r for k, r in C.races.items() if r["k"] or r["p"]}


def cycle_payload(C):
    return {"meta": {"generated": NOW.isoformat(), "cycle": C.year, "election_day": election_day(C.year)},
            "races": sorted(C.races.values(), key=lambda r: r["id"]),
            "big": C.big, "pres": C.pres}


def sql_str(s):
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def sql_num(x):
    return "NULL" if x is None else repr(round(float(x), 4))


def race_points(C):
    """(race_id, row fields, k_d, k_r, p_d, p_r) for every race in a cycle, plus the presidential party race."""
    out = []
    for r in C.races.values():
        k, p = r["k"] or {}, r["p"] or {}
        out.append((r["id"], dict(kind=r["kind"], st=r["st"], state=r["state"], dist=r["dist"], label=r["label"],
                                  path=r["path"], d=r["D"], r=r["R"], lead="D" if r["D"] >= r["R"] else "R",
                                  vol=(k.get("v") or 0) + (p.get("v") or 0)),
                    k.get("D"), k.get("R"), p.get("D"), p.get("R")))
    party = C.pres.get("party", {})
    if party:
        def share(src, pa):
            o = party.get(src, {}).get("o", [])
            tot = sum(x["p"] for x in o) or 1
            return sum(x["p"] for x in o if x.get("pa") == pa) / tot if o else None
        kd, kr, pd, pr = share("k", "D"), share("k", "R"), share("p", "D"), share("p", "R")
        out.append((f"{C.year}-president", dict(kind="president", st="US", state="United States", dist=None,
                                                label=f"{C.year} Presidential election", path=f"/{C.year}/president/",
                                                d=kd if kd is not None else pd, r=kr if kr is not None else pr, lead=None,
                                                vol=party.get("p", {}).get("v") or 0),
                    kd, kr, pd, pr))
    return out


SUFFIXES = {"jr", "sr", "ii", "iii", "iv"}


def name_key(n):
    """Match a candidate across exchanges by last name + first initial:
    "J.D. Vance" == "JD Vance"; "Donald J. Trump" == "Donald Trump"; "Donald Trump Jr." stays separate."""
    words = re.sub(r"[^a-z ]", " ", n.lower().replace(".", " ")).split()
    if not words:
        return ""
    suffix = words[-1] if len(words) > 1 and words[-1] in SUFFIXES else ""
    core = words[:-1] if suffix else words
    last = core[-1]
    return f"{last}{' ' + suffix if suffix else ''}|{core[0][0] if len(core) > 1 else ''}"


def cycle_from_payload(d):
    C = Cycle(d["meta"]["cycle"])
    C.races = {r["id"]: r for r in d.get("races", [])}
    C.big = d.get("big", C.big)
    C.pres = d.get("pres", {})
    return C


def outcome_markets(C):
    """Every non-race market whose history is kept: presidential candidates, balance of power,
    seat counts, the House popular vote and ballot measures. One entry per market per exchange."""
    y, ms = C.year, []
    ref = lambda src, o: o.get("id") if src == "k" else o.get("tok")  # noqa: E731
    for key in ("winner", "nomD", "nomR"):
        for src in ("k", "p"):
            s = C.pres.get(key, {}).get(src)
            if s:
                ms.append({"group": f"{y}-pres-{key}", "src": src, "kind": "share",
                           "items": [(name_key(o["n"]), ref(src, o), o["p"]) for o in s["o"] if name_key(o["n"])]})
    for src in ("k", "p"):
        b = C.big.get("bop", {}).get(src)
        if b:
            refs = b.get("ids" if src == "k" else "toks", {})
            ms.append({"group": f"{y}-bop", "src": src, "kind": "share", "items": [(k, refs.get(k), v) for k, v in b["o"].items()]})
    for big, group, maj, derive in (("senate", "senate-seats", 50, "senate-R"), ("house", "house-seats", 218, "house-R"),
                                    ("pv", "popvote", 0, "popvote-D")):
        for src in ("k", "p"):
            g = C.big.get(big, {}).get(src)
            if g:
                ms.append({"group": f"{y}-{group}", "src": src, "kind": "bins", "maj": maj, "derive": derive,
                           "bins": [(b["l"], b["lo"], b["hi"]) for b in g["bins"]],
                           "items": [(f"{src}:{b['l']}", ref(src, b), b["p"]) for b in g["bins"]]})
    for src in ("k", "p"):
        items = [(f"{b['st']}: {b['n']}", ref(src, b), b["p"]) for b in C.big.get("ballots", []) if b["src"] == src]
        if items:
            ms.append({"group": f"{y}-ballots", "src": src, "kind": "raw", "items": items})
    return ms


def market_values(m, price):
    """{(group, outcome): value} for one market, given price(ref, live_price) -> price or None."""
    got = [(o, price(r, p)) for o, r, p in m["items"]]
    got = [(o, v) for o, v in got if v is not None]
    if not got:
        return {}
    if m["kind"] == "raw":
        return {(m["group"], o): v for o, v in got}
    tot = sum(v for _, v in got) or 1
    out = {(m["group"], o): v / tot for o, v in got}
    if m["kind"] == "bins":
        share = dict((o, v / tot) for o, v in got)
        maj, t = m["maj"], 0.0
        for (label, lo, hi), (o, _r, _p) in zip(m["bins"], m["items"]):
            v = share.get(o)
            if v is None:
                continue
            if m["derive"] == "popvote-D":
                t += v if lo is not None and lo >= 0 else 0
            elif lo is not None and lo >= maj:
                t += v
            elif lo is not None and hi is not None and lo < maj <= hi:
                t += v * (hi - maj + 1) / (hi - lo + 1)
        # derived headline series, e.g. ("2026-majority", "senate-R") = chance Republicans hold 50+ seats
        out[(f"{m['group'][:4]}-majority", m["derive"])] = t
    return out


def outcome_points(C):
    """{(group, outcome): (kalshi, polymarket)} for the current prices; tiny outcomes (<0.2%) skipped."""
    acc = {}
    for m in outcome_markets(C):
        for key, v in market_values(m, lambda r, p: p).items():
            acc.setdefault(key, [None, None])[0 if m["src"] == "k" else 1] = v
    return {k: tuple(v) for k, v in acc.items() if max(x or 0 for x in v) >= 0.002 or k[0].endswith("-majority")}


def previous_points(year):
    """What the site is currently showing for a cycle, so unchanged races and outcomes aren't rewritten."""
    try:
        prev = get(f"{config.SITE_URL}/api/v1/{year}.json")
        if not isinstance(prev, dict) or "races" not in prev:
            return {}, {}
        C = cycle_from_payload(prev)
        return {rid: vals for rid, _row, *vals in race_points(C)}, outcome_points(C)
    except Exception:
        return {}, {}


def changed(a, b):
    return any((x is None) != (y is None) or (x is not None and abs(x - y) >= 0.0005) for x, y in zip(a, b))


def election_windows(cycles):
    """Unix-second ranges kept at full 10-minute detail forever: the day before Election Day to 3 days after."""
    wins = []
    for C in cycles:
        d = datetime.datetime.fromisoformat(election_day(C.year) + "T00:00:00-05:00")
        wins.append((int(d.timestamp()) - 86400, int(d.timestamp()) + 4 * 86400))
    return wins


def write_d1_sql(cycles):
    ts = int(NOW.timestamp())
    lines, written, skipped, written_o, skipped_o = [], 0, 0, 0, 0
    for C in cycles:
        prev, prev_out = previous_points(C.year)
        for key, vals in outcome_points(C).items():
            if key in prev_out and not changed(vals, prev_out[key]):
                skipped_o += 1
                continue
            written_o += 1
            lines.append("INSERT OR REPLACE INTO outcome_history (group_id,outcome,ts,k,p) VALUES ("
                         + ",".join([sql_str(key[0]), sql_str(key[1]), str(ts), sql_num(vals[0]), sql_num(vals[1])]) + ");")
        for rid, row, *vals in race_points(C):
            if rid in prev and not changed(vals, prev[rid]):
                skipped += 1
                continue
            written += 1
            lines.append(
                "INSERT INTO races (id,cycle,kind,st,state,dist,label,path,d,r,k_d,p_d,lead,vol,updated_at) VALUES ("
                + ",".join([sql_str(rid), str(C.year), sql_str(row["kind"]), sql_str(row["st"]), sql_str(row["state"]),
                            sql_str(row["dist"]), sql_str(row["label"]), sql_str(row["path"]), sql_num(row["d"]),
                            sql_num(row["r"]), sql_num(vals[0]), sql_num(vals[2]), sql_str(row["lead"]),
                            sql_num(row["vol"]), str(ts)])
                # The races summary is refreshed hourly (new races are added at once) to save writes;
                # pages read odds from the cycle files and history, not from this table.
                + (") ON CONFLICT(id) DO UPDATE SET d=excluded.d,r=excluded.r,k_d=excluded.k_d,p_d=excluded.p_d,"
                   "lead=excluded.lead,vol=excluded.vol,label=excluded.label,updated_at=excluded.updated_at;"
                   if NOW.minute < 10 else ") ON CONFLICT(id) DO NOTHING;"))
            lines.append("INSERT OR REPLACE INTO race_history (race_id,ts,k_d,k_r,p_d,p_r) VALUES ("
                         + ",".join([sql_str(rid), str(ts)] + [sql_num(v) for v in vals]) + ");")
    # Tiered retention, once an hour. Only the slice that just crossed each boundary is examined,
    # so this stays cheap however much history accumulates. Election weeks are never thinned.
    if NOW.minute < 10:
        keep = " AND ".join(f"NOT (ts BETWEEN {a} AND {b})" for a, b in election_windows(cycles)) or "1"
        for newer, older, bucket in ((config.HISTORY_FULL_DAYS, config.HISTORY_HOURLY_DAYS, 3600),
                                     (config.HISTORY_HOURLY_DAYS, None, 86400)):
            hi = ts - newer * 86400
            lo = hi - 2 * 86400
            rng = f"ts >= {lo} AND ts < {hi}"
            lines.append(f"DELETE FROM race_history WHERE {rng} AND {keep} AND (race_id, ts) NOT IN "
                         f"(SELECT race_id, MAX(ts) FROM race_history WHERE {rng} GROUP BY race_id, ts / {bucket});")
            lines.append(f"DELETE FROM outcome_history WHERE {rng} AND {keep} AND (group_id, outcome, ts) NOT IN "
                         f"(SELECT group_id, outcome, MAX(ts) FROM outcome_history WHERE {rng} GROUP BY group_id, outcome, ts / {bucket});")
    open(os.path.join(OUT, "d1.sql"), "w").write("\n".join(lines) + "\n")
    print(f"history: {written} races changed, {skipped} unchanged; {written_o} outcomes changed, {skipped_o} unchanged")
    return len(lines)


def main():
    cached = "--cached" in sys.argv
    kev, pev = load_raw(cached)
    classify_kalshi(kev)
    classify_polymarket(pev)
    cycles = sorted(CYCLES.values(), key=lambda c: c.year)
    for C in cycles:
        finish_cycle(C)
    cycles = [C for C in cycles if C.races or C.pres]

    upcoming = [C for C in cycles if election_day(C.year) >= NOW.date().isoformat()]
    nxt = upcoming[0] if upcoming else cycles[-1]
    n_both = sum(1 for r in nxt.races.values() if r["k"] and r["p"])
    summary = {C.year: dict(Counter(r["kind"] for r in C.races.values()),
                            president=bool(C.pres), ballots=len(C.big["ballots"])) for C in cycles}
    print(json.dumps(summary), f"| next cycle {nxt.year}: {len(nxt.races)} races, {n_both} on both | unmatched {len(UNMATCHED)}")
    if len(nxt.races) < config.MIN_RACES_NEXT_CYCLE or n_both < config.MIN_RACES_NEXT_CYCLE // 2:
        sys.exit("Pull looks incomplete; not writing output.")

    os.makedirs(os.path.join(OUT, "cycles"), exist_ok=True)
    for C in cycles:
        json.dump(cycle_payload(C), open(os.path.join(OUT, "cycles", f"{C.year}.json"), "w"), separators=(",", ":"))
    index = {"generated": NOW.isoformat(), "next": nxt.year,
             "cycles": [{"year": C.year, "election_day": election_day(C.year), "races": len(C.races),
                         "offices": sorted({r["kind"] for r in C.races.values()} | ({"president"} if C.pres.get("winner") or C.pres.get("party") else set())),
                         "ballots": len(C.big["ballots"])} for C in cycles]}
    json.dump(index, open(os.path.join(OUT, "index.json"), "w"), indent=1)
    UNMATCHED.extend(UNMATCHED_K.values())
    UNMATCHED.sort(key=lambda u: -u["v"])
    json.dump(UNMATCHED, open(os.path.join(OUT, "unmatched.json"), "w"), indent=1)
    n = write_d1_sql(cycles)
    print(f"wrote {len(cycles)} cycle files, {n} D1 statements")


if __name__ == "__main__":
    main()
