#!/usr/bin/env python3
"""Fetch political headlines from Google News search feeds for the homepage "Latest" strip.

Writes out/news.json: a list of {title, source, url, ts, tag}, interleaved so the mix follows
config.NEWS_QUERIES. Headlines link to the original story (via Google News)."""
import email.utils
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(__file__))
import config  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def fetch(query):
    url = ("https://news.google.com/rss/search?q=" + urllib.parse.quote(f"{query} when:2d")
           + "&hl=en-US&gl=US&ceid=US:en")
    r = subprocess.run(["curl", "-s", "--max-time", "30", "-A", "Mozilla/5.0 (ParlayThePeople news strip)", url],
                       capture_output=True, text=True)
    try:
        return ET.fromstring(r.stdout).findall(".//item")
    except ET.ParseError:
        return []


def norm(title):
    """Duplicate key: the opening words, so syndicated copies with different endings collapse."""
    return " ".join(re.sub(r"[^a-z0-9 ]", "", title.lower()).split()[:7])


def main():
    now, seen, lists = time.time(), set(), []
    for tag, query, n in config.NEWS_QUERIES:
        picked = []
        for it in fetch(query):
            src = it.find("source")
            source = src.text.strip() if src is not None and src.text else ""
            title = (it.findtext("title") or "").strip()
            if source and title.endswith(" - " + source):
                title = title[: -len(source) - 3].strip()
            try:
                ts = email.utils.parsedate_to_datetime(it.findtext("pubDate")).timestamp()
            except Exception:
                continue
            key = norm(title)
            if not title or key in seen or now - ts > config.NEWS_MAX_AGE_HOURS * 3600:
                continue
            seen.add(key)
            picked.append({"title": title, "source": source, "url": it.findtext("link"), "ts": int(ts), "tag": tag})
        picked.sort(key=lambda x: -x["ts"])
        lists.append(picked[:n])
    # interleave: one from each topic in turn, so heavier topics simply appear more often
    out = []
    while any(lists):
        for lst in lists:
            if lst:
                out.append(lst.pop(0))
    os.makedirs(OUT, exist_ok=True)
    json.dump({"generated": int(now), "items": out}, open(os.path.join(OUT, "news.json"), "w"), indent=1)
    print(f"news: {len(out)} headlines")


if __name__ == "__main__":
    main()
