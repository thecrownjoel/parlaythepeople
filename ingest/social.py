#!/usr/bin/env python3
"""Social pulse from LunarCrush for candidates and political topics.

For each topic: 24h interactions, contributors, posts, sentiment and trend (topic endpoint),
a 30-day daily series (time-series endpoint), and the top posts (for Senate/governor/president).
Writes out/social.json and out/social.sql (daily rows for D1's social_history).

Needs LUNARCRUSH_API_KEY. Usage: python3 ingest/social.py [--force]
Runs at most once an hour unless --force (it's called from every 10-minute collector run).
"""
import concurrent.futures as cf
import datetime
import glob
import json
import os
import subprocess
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
import config  # noqa: E402
from ingest import name_key  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
KEY = os.environ.get("LUNARCRUSH_API_KEY", "")
BASE = "https://lunarcrush.com/api4/public"
GENERIC = {"democrats", "republicans", "democratic party", "republican party", "democrat", "republican", "independent", "other"}


def lc(path, params=None):
    url = f"{BASE}{path}" + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "--max-time", "30", "-H", f"Authorization: Bearer {KEY}", url], capture_output=True, text=True)
        try:
            return json.loads(r.stdout)
        except json.JSONDecodeError:
            time.sleep(1 + attempt)
    return {}


def topics_from_cycles():
    """{topic: {"name", "key", "kind", "races": [race paths], "posts": bool}} from the cycle files."""
    topics = {}

    def add(name, kind, path=None, posts=False):
        n = name.strip()
        if not n or n.lower() in GENERIC or len(n.split()) < 2 and kind != "topic":
            return
        t = topics.setdefault(n.lower(), {"name": n, "key": name_key(n), "kind": kind, "races": [], "posts": False})
        if path and path not in t["races"]:
            t["races"].append(path)
        t["posts"] = t["posts"] or posts

    for f in sorted(glob.glob(os.path.join(OUT, "cycles", "*.json"))):
        c = json.load(open(f))
        for r in c["races"]:
            if r["kind"] == "control":
                continue
            outs = [o for s in ("k", "p") for o in ((r.get(s) or {}).get("o") or [])]
            shares = {}
            for s in ("k", "p"):
                o = (r.get(s) or {}).get("o") or []
                tot = sum(x["p"] for x in o) or 1
                for x in o:
                    shares[x["n"]] = max(shares.get(x["n"], 0), x["p"] / tot)
            lead = max(shares.values()) if shares else 1
            if r["kind"] == "house" and lead > config.SOCIAL_HOUSE_MAX_LEAD:
                continue
            for o in outs:
                if shares.get(o["n"], 0) >= 0.03:
                    add(o["n"], "candidate", r["path"], posts=r["kind"] in ("senate", "governor"))
        winner = (c.get("pres") or {}).get("winner") or {}
        names = {}
        for s in ("k", "p"):
            for o in (winner.get(s) or {}).get("o") or []:
                names[o["n"]] = max(names.get(o["n"], 0), o["p"])
        for n, _p in sorted(names.items(), key=lambda x: -x[1])[: config.SOCIAL_PRES_TOP]:
            add(n, "candidate", f"/{c['meta']['cycle']}/president/", posts=True)
    for t in config.SOCIAL_EXTRA_TOPICS:
        add(t, "topic")
    return topics


def fetch(topic, meta):
    tid = urllib.parse.quote(topic)
    d = {}
    for attempt in range(3):  # empty answers happen under load; retry before giving up on a topic
        d = (lc(f"/topic/{tid}/v1") or {}).get("data") or {}
        if d.get("interactions_24h"):
            break
        time.sleep(1.5 * (attempt + 1))
    if not d.get("interactions_24h"):
        return topic, None
    ts = (lc(f"/topic/{tid}/time-series/v2", {"bucket": "day", "interval": "1m"}) or {}).get("data") or []
    series = [[p["time"], p.get("interactions") or 0, p.get("sentiment")] for p in ts if p.get("time")]
    posts = []
    if meta["posts"]:
        for p in ((lc(f"/topic/{tid}/posts/v1") or {}).get("data") or [])[:40]:
            if not p.get("post_link"):
                continue
            posts.append({"t": (p.get("post_title") or p.get("post_description") or "")[:220], "u": p["post_link"],
                          "by": p.get("creator_display_name") or p.get("creator_name"), "av": p.get("creator_avatar"),
                          "f": p.get("creator_followers"), "i": p.get("interactions_24h") or 0,
                          "s": p.get("post_sentiment"), "net": p.get("post_type"), "at": p.get("post_created")})
        posts.sort(key=lambda x: -x["i"])
        posts = posts[: config.SOCIAL_POSTS_PER_TOPIC]
    last7 = sum(p[1] for p in series[-7:]) if series else 0
    prev7 = sum(p[1] for p in series[-14:-7]) if len(series) >= 14 else 0
    return topic, {
        "name": d.get("title") or meta["name"], "key": meta["key"], "kind": meta["kind"], "races": meta["races"],
        "i24": d.get("interactions_24h") or 0, "contributors": d.get("num_contributors") or 0, "posts24": d.get("num_posts") or 0,
        "trend": d.get("trend"), "sentiment": next((p[2] for p in reversed(series) if p[2] is not None), None),
        "wow": round((last7 - prev7) / prev7, 3) if prev7 else None,
        "series": series[-30:], "top": posts,
        "link": f"https://lunarcrush.com/topic/{urllib.parse.quote(topic.replace(' ', '-'))}",
    }


def main():
    if not KEY:
        sys.exit("LUNARCRUSH_API_KEY is not set")
    prev = os.path.join(OUT, "social.json")
    if "--force" not in sys.argv and datetime.datetime.now(datetime.timezone.utc).minute >= 15:
        print("social: skipped (runs once an hour)")
        return
    topics = topics_from_cycles()
    out = {}
    with cf.ThreadPoolExecutor(6) as ex:  # well under LunarCrush's 500 calls/minute
        for topic, data in ex.map(lambda kv: fetch(*kv), topics.items()):
            if data:
                out[topic] = data
    # different spellings ("J.D. Vance", "JD Vance") can resolve to the same LunarCrush topic: keep one
    by_title = {}
    for topic, d in list(out.items()):
        k = (d["name"].lower(), d["i24"])
        if k in by_title:
            keep = out[by_title[k]]
            keep["races"] = sorted(set(keep["races"]) | set(d["races"]))
            del out[topic]
        else:
            by_title[k] = topic
    gen = int(time.time())
    json.dump({"generated": gen, "source": "LunarCrush", "topics": out}, open(prev, "w"), separators=(",", ":"))
    # daily rows for long-term history (last 2 days per topic; the first run backfills 30 days)
    first = "--backfill" in sys.argv
    rows = []
    for topic, d in out.items():
        for t, inter, sent in (d["series"] if first else d["series"][-2:]):
            rows.append(f"('{topic.replace(chr(39), chr(39) * 2)}',{int(t)},{int(inter)},{'NULL' if sent is None else float(sent)})")
    with open(os.path.join(OUT, "social.sql"), "w") as fh:
        for i in range(0, len(rows), 200):
            fh.write("INSERT OR REPLACE INTO social_history (topic,ts,interactions,sentiment) VALUES " + ",".join(rows[i:i + 200]) + ";\n")
    print(f"social: {len(out)} of {len(topics)} topics have data; {len(rows)} history rows")


if __name__ == "__main__":
    main()
