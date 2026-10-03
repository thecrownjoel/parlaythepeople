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


ATOM = "{http://www.w3.org/2005/Atom}"


def fetch_url(url):
    r = subprocess.run(["curl", "-s", "-L", "--max-time", "30", "-A", "Mozilla/5.0 (ParlayThePeople news strip)", url], capture_output=True)
    try:
        t = ET.fromstring(r.stdout)
        return t.findall(".//item") or t.findall(f".//{ATOM}entry")
    except ET.ParseError:
        return []


def fetch(query):
    return fetch_url("https://news.google.com/rss/search?q=" + urllib.parse.quote(f"{query} when:2d") + "&hl=en-US&gl=US&ceid=US:en")


def when(it):
    d = it.findtext("pubDate") or it.findtext(f"{ATOM}updated") or it.findtext(f"{ATOM}published")
    try:
        return email.utils.parsedate_to_datetime(d).timestamp()
    except Exception:
        try:
            import datetime
            return datetime.datetime.fromisoformat((d or "").replace("Z", "+00:00")).timestamp()
        except Exception:
            return None


def link(it):
    l = it.findtext("link")
    if l and l.strip():
        return l.strip()
    a = it.find(f"{ATOM}link")
    return a.get("href") if a is not None else None


def norm(title):
    """Duplicate key: the opening words, so syndicated copies with different endings collapse."""
    return " ".join(re.sub(r"[^a-z0-9 ]", "", title.lower()).split()[:7])


def main():
    now, seen, lists = time.time(), set(), []
    # publishers' own feeds first (their order in config sets who leads the strip)
    for label, url, n, political in config.NEWS_FEEDS:
        picked = []
        for it in fetch_url(url):
            title = (it.findtext("title") or it.findtext(f"{ATOM}title") or "").strip()
            ts, href = when(it), link(it)
            key = norm(title)
            if not title or not href or not ts or key in seen or now - ts > config.NEWS_MAX_AGE_HOURS * 3600:
                continue
            if not political and not any(w in title.lower() for w in config.NEWS_POLITICS_WORDS):
                continue
            seen.add(key)
            picked.append({"title": title, "source": label, "url": href, "ts": int(ts), "tag": label})
        picked.sort(key=lambda x: -x["ts"])
        lists.append(picked[:n])
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
