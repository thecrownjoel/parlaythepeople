#!/usr/bin/env python3
"""Expert race ratings (The Cook Political Report, Sabato's Crystal Ball, Inside Elections) for every race we follow,
as cited on Wikipedia's 2026 election pages.

We don't copy the forecasters' sites: their ratings are read from Wikipedia's prediction tables, where each one
carries a citation, and the site shows them with credit and a link to the forecaster. Sources:
  - Senate and governor: the ratings table on "2026 United States Senate elections" / "… gubernatorial elections"
  - House: the per-district "Source / Ranking / As of" tables on each state's House elections page

Writes out/ratings.sql (upserts into the D1 table `ratings` on ballottape-markets). Runs from the collector
workflow every 6 hours, an hour after the polls (pass --force to run any time). About 50 requests, one at a time.
"""
import datetime
import json
import os
import re
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(__file__))
from polls import page_html, Tables, sql_str, sql_num, CYCLE  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# column or row label on Wikipedia -> our key
SOURCES = {"cook": re.compile(r"^(the )?cook", re.I), "sabato": re.compile(r"sabato|crystal ball", re.I), "ie": re.compile(r"^(ie\b|inside elections)", re.I)}
SOURCE_URL = {
    "cook": "https://www.cookpolitical.com/ratings",
    "sabato": "https://centerforpolitics.org/crystalball/",
    "ie": "https://insideelections.com/ratings",
}


def score(rating):
    """'Lean D (flip)' -> +1; Safe/Solid ±3, Likely ±2, Lean ±1, Tilt ±0.5, Tossup 0 (positive favors Democrats)."""
    s = rating.lower()
    if "toss" in s:
        return 0.0
    side = 1 if re.search(r"\bd\b|dem", s) else -1 if re.search(r"\br\b|rep", s) else None
    if side is None:
        return None
    for word, v in (("safe", 3), ("solid", 3), ("likely", 2), ("lean", 1), ("tilt", 0.5)):
        if word in s:
            return side * v
    return None


def clean(rating):
    r = re.sub(r"\s+", " ", rating).strip()
    r = r.replace("Toss-up", "Tossup").replace("Toss up", "Tossup")
    return r if score(r) is not None else None


def as_of(text):
    """'Cook Sep 23, 2026' / 'October 22, 2025' / 'Oct. 1, 2026' -> ISO date or None."""
    m = re.search(r"([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s*(20\d\d)", text)
    if not m:
        return None
    for fmt in ("%B %d %Y", "%b %d %Y"):
        try:
            return datetime.datetime.strptime(f"{m.group(1)[:3] if fmt == '%b %d %Y' else m.group(1)} {m.group(2)} {m.group(3)}", fmt).date().isoformat()
        except ValueError:
            continue
    return None


class HeadedTables(Tables):
    """Tables, each with the section heading it sits under (for the House district tables)."""

    def __init__(self):
        super().__init__()
        self.heading, self.in_h, self.htext, self.headings = "", False, [], []

    def handle_starttag(self, tag, attrs):
        if tag == "h2":  # district sections are h2; their subsections (primaries, predictions) are h3/h4
            self.in_h, self.htext = True, []
        if tag == "table" and self.depth == 0:
            self.headings.append(self.heading)
        super().handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        if tag == "h2" and self.in_h:
            self.in_h = False
            self.heading = re.sub(r"\s+", " ", "".join(self.htext)).strip()
        super().handle_endtag(tag)

    def handle_data(self, data):
        if self.in_h:
            self.htext.append(data)
        super().handle_data(data)


def overview(title, kind, races):
    """Senate or governor: one row per state, one column per forecaster."""
    h = page_html(title)
    if not h:
        return []
    p = Tables()
    p.feed(h)
    out = []
    by_state = {r["state"].lower(): r for r in races if r["kind"] == kind}
    for t in p.tables:
        if not t or len(t) < 3 or not any(c.startswith("Cook") for c in t[1]):
            continue
        head = t[1]
        cols = {k: next((i for i, c in enumerate(head) if rx.search(c)), None) for k, rx in SOURCES.items()}
        for row in t[2:]:
            state = re.sub(r"\s*\(.*?\)", "", row[0]).strip().lower()
            race = by_state.get(state)
            if not race or len(row) < len(head):
                continue
            for k, i in cols.items():
                if i is None:
                    continue
                r = clean(row[i])
                if r:
                    out.append((race["id"], k, r, as_of(head[i]), "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title)))
        break
    return out


def house(state_races):
    """House: each district section's Source / Ranking / As of table, matched by its heading ("District 7", "At-large")."""
    st = state_races[0]["state"]
    # single-district states have one page per election ("…election in Alaska")
    title = f"{CYCLE}_United_States_House_of_Representatives_election{'' if len(state_races) == 1 else 's'}_in_{st.replace(' ', '_')}"
    h = page_html(title)
    if not h:
        return []
    p = HeadedTables()
    p.feed(h)
    by_dist = {str(r["dist"]).upper(): r for r in state_races}
    out = []
    for t, heading in zip(p.tables, p.headings):
        if not t or not t[0] or t[0][0].lower() != "source":
            continue
        m = re.search(r"district\s+(\d+)", heading, re.I)
        dist = str(int(m.group(1))) if m else ("AL" if re.search(r"at.large", heading, re.I) or len(by_dist) == 1 else None)
        race = by_dist.get(dist or "")
        if not race:
            continue
        for row in t[1:]:
            if len(row) < 2:
                continue
            k = next((k for k, rx in SOURCES.items() if rx.search(row[0])), None)
            r = clean(row[1]) if k else None
            if r:
                out.append((race["id"], k, r, as_of(row[2]) if len(row) > 2 else None, "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title)))
    return out


def main():
    force = "--force" in sys.argv
    now = datetime.datetime.now(datetime.timezone.utc)
    if not force and not (now.hour % 6 == 3 and now.minute < 10):
        print("ratings: not due")
        return
    data = json.load(open(os.path.join(OUT, "cycles", f"{CYCLE}.json")))
    races = [r for r in data["races"] if r["kind"] in ("senate", "governor", "house")]
    rows = overview(f"{CYCLE}_United_States_Senate_elections", "senate", races)
    time.sleep(0.5)
    rows += overview(f"{CYCLE}_United_States_gubernatorial_elections", "governor", races)
    states = {}
    for r in races:
        if r["kind"] == "house":
            states.setdefault(r["st"], []).append(r)
    for st, rs in sorted(states.items()):
        time.sleep(0.5)
        rows += house(rs)
    ts = str(int(now.timestamp()))
    lines = [
        "INSERT INTO ratings (race_id, source, rating, score, as_of, cited_on, seen) VALUES ("
        + ",".join([sql_str(rid), sql_str(k), sql_str(r), sql_num(score(r)), sql_str(d), sql_str(src), ts])
        + ") ON CONFLICT(race_id, source) DO UPDATE SET rating = excluded.rating, score = excluded.score, as_of = excluded.as_of, cited_on = excluded.cited_on, seen = excluded.seen,"
        + " changed = CASE WHEN ratings.rating <> excluded.rating THEN excluded.seen ELSE ratings.changed END,"
        + " previous = CASE WHEN ratings.rating <> excluded.rating THEN ratings.rating ELSE ratings.previous END;"
        for rid, k, r, d, src in rows
    ]
    with open(os.path.join(OUT, "ratings.sql"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"ratings: {len(rows)} ratings for {len({x[0] for x in rows})} races")


if __name__ == "__main__":
    main()
