#!/usr/bin/env python3
"""Every other politics market: everything in Kalshi's Politics and Elections categories and Polymarket's
politics tags that isn't already on a race page (cabinet picks, Supreme Court, shutdowns, approval ratings,
world leaders, mayors, primaries…).

Runs every collector run, after ingest.py (it reuses ingest.py's raw pulls in out/raw/ and its cycle files to
skip markets already covered). Writes:
  out/politics.json     the board for /politics/ and the homepage: events by topic, with outcomes and money
  out/politics.sql      D1: one price point per event per hour (sparklines) and when each event first appeared
                        (new listings; after an election this is how next-cycle markets surface right away)
"""
import datetime
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ingest  # noqa: E402  (its top level only sets up constants; main() doesn't run)

OUT = os.path.join(HERE, "out")
RAW = os.path.join(OUT, "raw")
NOW = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
# Polymarket's Politics and Elections categories (and their sub-tags, which don't always carry the parent tag)
POLY_TAGS = ["politics", "geopolitics", "elections", "global-elections", "world-elections", "trump", "courts", "congress"]
MAX_OUTCOMES = 6           # outcomes kept per event on the board (n_out has the full count)

# Topics, checked in order; the first whose words appear in the title (or Polymarket tag labels) wins.
TOPICS = [
    ("world", "World politics", r"\b(ukraine|russia|putin|zelensk|israel|gaza|hamas|netanyahu|iran|china|xi jinping|taiwan|north korea|nato|eu\b|european|uk\b|britain|starmer|canada|carney|mexico|france|macron|germany|japan|india|modi|venezuela|maduro|ceasefire|war\b|prime minister|pope|syria|brazil|argentina|milei|south korea|australia|spain|sánchez|italy|meloni|poland|turkey|erdogan|hungary|orb[aá]n|\bpm\b|nobel peace|strait of hormuz)"),
    ("trump", "Trump and the White House", r"\b(trump|white house|executive order|pardon|impeach|approval rating|vance|melania|oval office|third term|25th amendment)"),
    ("courts", "Courts and the law", r"\b(supreme court|scotus|justice\b|ruling|indict|trial|convict|sentenc|court\b|lawsuit|attorney general|doj\b|fbi\b|epstein)"),
    ("congress", "Congress", r"\b(congress|shutdown|filibuster|speaker|bill\b|act\b|legislation|debt ceiling|reconciliation|senate (vote|confirm|pass)|house (vote|pass)|majority leader)"),
    ("cabinet", "Cabinet and appointments", r"\b(cabinet|secretary of|secretary\b|nominee for|nominated|fed chair|chair of|ambassador|press secretary|confirmed as|confirmation)"),
    ("policy", "Policy and the economy", r"\b(tariff|tax|deport|immigration|border|doge|budget|spending|medicare|medicaid|social security|minimum wage|recession|inflation|interest rate|fed\b|crypto|ai\b|tiktok)"),
    ("parties", "Parties and 2028", r"\b(dnc|rnc|party|2028|nomination|primary|caucus|run for president|announce|democratic|republican)"),
    ("elections", "Other elections", r"\b(election|mayor|governor|runoff|referendum|ballot|vote share|wins? the|seat\b)"),
]


# Markets the site already covers on race and presidential pages under other ids (control of Congress, the
# 2028 nominations and winner): left off this board so it stays "everything else".
COVERED_TITLES = re.compile(r"balance of power|congress balance|control (of )?the (house|senate)|which party (wins|will win)|"
                            r"20(28|32) (democratic|republican) presidential nominee|presidential election winner 20(28|32)|"
                            r"(senate|house) (control|majority)", re.I)


def topic_of(text):
    t = text.lower()
    for key, _, rx in TOPICS:
        if re.search(rx, t):
            return key
    return "more"


def covered_ids():
    """Kalshi market tickers and Polymarket condition ids already on race and presidential pages."""
    k, p = set(), set()
    def walk(x):
        if isinstance(x, dict):
            if isinstance(x.get("id"), str) and "-" in x["id"] and x.get("pa") is not None:
                k.add(x["id"])
            if isinstance(x.get("cid"), str):
                p.add(x["cid"])
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    for f in glob.glob(os.path.join(OUT, "cycles", "*.json")):
        walk(json.load(open(f)))
    return k, p


def fetch_poly_tags():
    seen, out = set(), []
    for tag in POLY_TAGS:
        off = 0
        while off < 20000:
            page = ingest.get("https://gamma-api.polymarket.com/events", {"tag_slug": tag, "closed": "false", "limit": 100, "offset": off})
            if not isinstance(page, list) or not page:  # an error object (e.g. past the offset limit) ends this tag
                break
            for e in page:
                if isinstance(e, dict) and e.get("id") and e["id"] not in seen:
                    seen.add(e["id"])
                    out.append(e)
            off += 100
    return out


def fnum(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def kalshi_event(e, covered):
    ms = [m for m in e.get("markets") or [] if m.get("status") in (None, "active", "open")]
    if not ms or all(m.get("ticker") in covered for m in ms):
        return None
    outs = []
    for m in ms:
        p, _thin, _vol, d = ingest.kprice(m)
        if p is None:
            continue
        name = "Yes" if len(ms) == 1 else (m.get("yes_sub_title") or m.get("title") or "Yes")
        outs.append({"n": str(name)[:80], "p": round(p, 3), "d": round(d, 3) if d else None})
    if not outs:
        return None
    outs.sort(key=lambda o: -o["p"])
    vol = sum(fnum(m.get("volume_fp")) or 0 for m in ms)
    vol24 = sum(fnum(m.get("volume_24h_fp")) or 0 for m in ms)
    title = e.get("title") or ""
    return {
        "id": f"k:{e['event_ticker']}", "src": "k", "title": title, "sub": e.get("sub_title") or None,
        "url": ingest.kalshi_url(e.get("series_ticker") or e["event_ticker"]), "img": None,
        "topic": topic_of(title), "vol": round(vol), "vol24": round(vol24),
        "ends": (min((m.get("close_time") or "9999") for m in ms))[:10],
        "multi": len(outs) > 1, "o": outs[:MAX_OUTCOMES], "n_out": len(outs),
    }


def poly_event(e, covered):
    ms = [m for m in e.get("markets") or [] if not m.get("closed") and m.get("active", True)]
    if not ms or all(m.get("conditionId") in covered for m in ms):
        return None
    outs = []
    for m in ms:
        try:
            prices = json.loads(m.get("outcomePrices") or "[]")
            yes = float(prices[0]) if prices else None
        except (ValueError, TypeError):
            yes = None
        if yes is None:
            continue
        name = m.get("groupItemTitle") or ("Yes" if len(ms) == 1 else m.get("question") or "Yes")
        outs.append({"n": str(name)[:80], "p": round(yes, 3), "d": round(fnum(m.get("oneDayPriceChange")) or 0, 3) or None})
    if not outs:
        return None
    outs.sort(key=lambda o: -o["p"])
    labels = " ".join(t.get("label", "") for t in e.get("tags") or [])
    title = e.get("title") or ""
    return {
        "id": f"p:{e['id']}", "src": "p", "title": title, "sub": None,
        "url": ingest.poly_url(e.get("slug") or ""), "img": e.get("image") or e.get("icon"),
        "topic": topic_of(f"{title} {labels}"), "vol": round(fnum(e.get("volume")) or 0), "vol24": round(fnum(e.get("volume24hr")) or 0),
        "ends": (e.get("endDate") or "")[:10] or None,
        "multi": len(outs) > 1, "o": outs[:MAX_OUTCOMES], "n_out": len(outs),
    }


def main():
    kraw = json.load(open(os.path.join(RAW, "kalshi.json")))
    praw = json.load(open(os.path.join(RAW, "polymarket.json")))
    extra = fetch_poly_tags()
    seen = {e["id"] for e in praw}
    praw += [e for e in extra if e["id"] not in seen]
    ck, cp = covered_ids()
    events = [x for x in (kalshi_event(e, ck) for e in kraw) if x] + [x for x in (poly_event(e, cp) for e in praw) if x]
    # every market, however thinly traded: the site represents all of both exchanges' politics and elections
    events = [e for e in events if not COVERED_TITLES.search(e["title"])]
    events.sort(key=lambda e: (-e["vol24"], -e["vol"]))
    by_topic = {}
    for e in events:
        by_topic.setdefault(e["topic"], 0)
        by_topic[e["topic"]] += 1
    topics = [{"key": k, "name": n, "count": by_topic.get(k, 0)} for k, n, _ in TOPICS] + [{"key": "more", "name": "More politics", "count": by_topic.get("more", 0)}]
    board = {"generated": NOW.isoformat(), "events": events, "topics": [t for t in topics if t["count"]],
             "totals": {"events": len(events), "vol": sum(e["vol"] for e in events), "vol24": sum(e["vol24"] for e in events),
                        "kalshi": sum(1 for e in events if e["src"] == "k"), "polymarket": sum(1 for e in events if e["src"] == "p")}}
    json.dump(board, open(os.path.join(OUT, "politics.json"), "w"), separators=(",", ":"))

    # D1: an hourly point per event (leading outcome), kept forever, and first-seen times
    # (archive.py also stores the whole board, every outcome, every run in R2)
    hour = int(NOW.timestamp()) // 3600 * 3600
    q = lambda s: "'" + str(s).replace("'", "''") + "'"
    lines = []
    for e in events:
        # first reading of each hour; later runs in the hour are ignored (no write cost)
        lines.append(f"INSERT OR IGNORE INTO politics_history (event_id, ts, p) VALUES ({q(e['id'])}, {hour}, {e['o'][0]['p']});")
        lines.append(f"INSERT OR IGNORE INTO politics_first_seen (event_id, title, topic, src, first_seen) VALUES ({q(e['id'])}, {q(e['title'][:200])}, {q(e['topic'])}, {q(e['src'])}, {int(NOW.timestamp())});")
    open(os.path.join(OUT, "politics.sql"), "w").write("\n".join(lines) + "\n")
    print(f"politics: {len(events)} events ({board['totals']['kalshi']} Kalshi, {board['totals']['polymarket']} Polymarket), "
          f"${board['totals']['vol24']:,} traded in 24h; topics {by_topic}")


if __name__ == "__main__":
    main()
