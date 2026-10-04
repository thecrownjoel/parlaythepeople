#!/usr/bin/env python3
"""Public polls for every race we follow, from the polling tables on Wikipedia's 2026 election pages.

Wikipedia lists each published poll (pollster, field dates, sample, result) with a citation; its text is
CC BY-SA 4.0, and the site credits it wherever polls appear. For each race we find the general-election
table whose columns name both nominees (from the market data), read every poll row, and write
out/polls.sql (upserts into the D1 table `polls`). The site computes its own average (src/lib/polls.ts).

Runs from the collector workflow about every 6 hours (pass --force to run any time). Wikipedia's API asks
for a descriptive User-Agent and serial requests; this makes about 100 requests per run, one at a time.
"""
import datetime
import html
import json
import os
import re
import sys
import time
import urllib.parse
import subprocess
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
UA = "ParlayThePeople/1.0 (https://parlaythepeople.com; polls collector; contact via site)"
API = "https://en.wikipedia.org/w/api.php"
CYCLE = 2026
PARTY_WORDS = re.compile(r"\b(party|democrat|republican|democratic|independent|other|field|candidate)\b", re.I)


def page_html(title):
    """The page's rendered HTML via the MediaWiki parse API (curl, like the other collectors)."""
    q = urllib.parse.urlencode({"action": "parse", "page": title, "prop": "text", "format": "json", "formatversion": 2, "redirects": 1, "maxlag": 5})
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "--max-time", "40", "-A", UA, f"{API}?{q}"], capture_output=True)
        try:
            d = json.loads(r.stdout)
        except ValueError:
            print(f"polls: {title}: bad response (curl exit {r.returncode}), retrying", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
            continue
        if d.get("error", {}).get("code") == "maxlag":
            time.sleep(5 * (attempt + 1))
            continue
        return None if "error" in d else d["parse"]["text"]
    return None


class Tables(HTMLParser):
    """Every table.wikitable as rows of cell texts (rowspan cells repeated into later rows)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.depth, self.row, self.cell, self.in_cell = [], 0, None, None, False
        self.span = {}  # column index -> [text, rows left]
        self.skip = 0  # inside <sup> (footnote markers) or <style>

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "table":
            self.depth += 1
            if self.depth == 1 and "wikitable" in (a.get("class") or ""):
                self.tables.append([])
                self.span = {}
            elif self.depth == 1:
                self.tables.append(None)
        if not self.tables or self.tables[-1] is None or self.depth != 1:
            return
        if tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.fill_spans()
            self.in_cell, self.cell = True, []
            self.cell_rowspan = int(re.sub(r"\D", "", a.get("rowspan") or "1") or 1)
            self.cell_colspan = int(re.sub(r"\D", "", a.get("colspan") or "1") or 1)
        elif tag in ("sup", "style"):
            self.skip += 1
        elif tag == "br" and self.in_cell:
            self.cell.append(" ")

    def fill_spans(self):
        while len(self.row) in self.span:
            i = len(self.row)
            text, left = self.span[i]
            self.row.append(text)
            if left <= 1:
                del self.span[i]
            else:
                self.span[i] = [text, left - 1]

    def handle_endtag(self, tag):
        if tag == "table":
            self.depth -= 1
            return
        if not self.tables or self.tables[-1] is None or self.depth != 1:
            return
        if tag in ("sup", "style") and self.skip:
            self.skip -= 1
        elif tag in ("td", "th") and self.in_cell:
            text = re.sub(r"\s+", " ", "".join(self.cell)).strip()
            for _ in range(self.cell_colspan):
                if self.cell_rowspan > 1:
                    self.span[len(self.row)] = [text, self.cell_rowspan - 1]
                self.row.append(text)
            self.in_cell = False
        elif tag == "tr" and self.row is not None:
            self.fill_spans()
            if self.row:
                self.tables[-1].append(self.row)
            self.row = None

    def handle_data(self, data):
        if self.in_cell and not self.skip:
            self.cell.append(data)


MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"], 1)}


def parse_dates(s):
    """'September 29 – October 1, 2026' | 'September 28–30, 2026' | 'July 7, 2026' → (start, end) ISO dates."""
    s = s.replace("–", "-").replace("—", "-").replace("\xa0", " ")
    years = re.findall(r"\b(20\d\d)\b", s)
    if not years:
        return None, None
    year = int(years[-1])
    parts = [p.strip() for p in re.sub(r",?\s*20\d\d", "", s).split("-") if p.strip()]
    if not parts:
        return None, None

    def one(p, month=None):
        m = re.match(r"([A-Za-z]+)?\.?\s*(\d{1,2})?", p)
        mon = MONTHS.get((m.group(1) or "").lower(), month)
        day = int(m.group(2)) if m.group(2) else 1
        return mon, day

    m0, d0 = one(parts[0])
    m1, d1 = one(parts[-1], m0)
    if not m0 or not m1:
        return None, None
    try:
        y0 = year - 1 if m0 > m1 else year
        return datetime.date(y0, m0, d0).isoformat(), datetime.date(year, m1, d1).isoformat()
    except ValueError:
        return None, None


def pct(s):
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*%", s or "")
    return float(m.group(1)) / 100 if m else None


def last_name(n):
    parts = [p for p in re.sub(r"\(.*?\)", "", n).replace(",", " ").split() if p.lower() not in ("jr.", "jr", "sr.", "ii", "iii", "iv")]
    return parts[-1].lower() if parts else ""


def nominees(race):
    """Our leading Democrat and Republican, from both exchanges' outcomes."""
    best = {}
    for src in ("k", "p"):
        for o in (race.get(src) or {}).get("o", []):
            pa, n = o.get("pa"), o.get("n") or ""
            if pa in ("D", "R") and not PARTY_WORDS.search(n) and len(n.split()) >= 2:
                if o.get("p", 0) > best.get(pa, ("", -1))[1]:
                    best[pa] = (n, o.get("p", 0))
    return best.get("D", (None,))[0], best.get("R", (None,))[0]


def find_polls(tables, dname, rname, district=None):
    """Poll rows from the table whose header names both nominees (and, on House pages, sits under the district)."""
    dl, rl = last_name(dname), last_name(rname)
    found = []
    for t in tables:
        if not t or len(t) < 2:
            continue
        head = t[0]
        joined = " ".join(head).lower()
        if "poll source" not in joined or dl not in joined or rl not in joined:
            continue
        cols = {h.lower(): i for i, h in enumerate(head)}
        di = next((i for i, h in enumerate(head) if dl in h.lower()), None)
        ri = next((i for i, h in enumerate(head) if rl in h.lower()), None)
        oi = next((i for i, h in enumerate(head) if h.lower().startswith("other")), None)
        ui = next((i for i, h in enumerate(head) if h.lower().startswith("undecided")), None)
        si = next((i for i, h in enumerate(head) if h.lower().startswith("sample")), None)
        dti = next((i for i, h in enumerate(head) if h.lower().startswith("date")), None)
        if di is None or ri is None or dti is None:
            continue
        # a head-to-head table: only these two named candidates (plus Other / Undecided) — skip multi-candidate primaries
        named = [h for h in head[dti + 1:] if h and not re.match(r"(sample|margin|other|undecided|lead)", h, re.I)]
        if len(named) > 3:
            continue
        for row in t[1:]:
            if len(row) < len(head) or row[0] == row[-1]:  # event notes span the whole row
                continue
            d, r = pct(row[di]), pct(row[ri])
            start, end = parse_dates(row[dti])
            if d is None or r is None or not end:
                continue
            sample = row[si] if si is not None else ""
            n = re.search(r"([\d,]+)", sample)
            pop = re.search(r"\((LV|RV|A|V)\)", sample)
            pollster = re.sub(r"\s+", " ", row[0]).strip()
            sides = set(re.findall(r"\((D|R)\)", pollster))  # a joint (R)/(D) poll is bipartisan
            partisan = sides.pop() if len(sides) == 1 else None
            found.append({
                "pollster": pollster[:120], "partisan": partisan,
                "start": start, "end": end, "sample": int(n.group(1).replace(",", "")) if n else None,
                "pop": pop.group(1) if pop else None, "d": d, "r": r,
                "other": pct(row[oi]) if oi is not None else None, "undecided": pct(row[ui]) if ui is not None else None,
            })
        if found:
            break  # the first matching table is the general election head-to-head
    return found


def title_for(race):
    st = race["state"].replace(" ", "_")
    if race["kind"] == "senate":
        return f"{CYCLE}_United_States_Senate_special_election_in_{st}" if race.get("special") else f"{CYCLE}_United_States_Senate_election_in_{st}"
    if race["kind"] == "governor":
        return f"{CYCLE}_{st}_gubernatorial_election"
    if race["kind"] == "house":
        return f"{CYCLE}_United_States_House_of_Representatives_elections_in_{st}"
    return None


def sql_str(s):
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def sql_num(x):
    return "NULL" if x is None else repr(round(x, 4) if isinstance(x, float) else x)


def main():
    force = "--force" in sys.argv
    now = datetime.datetime.now(datetime.timezone.utc)
    if not force and not (now.hour % 6 == 2 and now.minute < 10):
        print("polls: not due")
        return
    data = json.load(open(os.path.join(OUT, "cycles", f"{CYCLE}.json")))
    races = [r for r in data["races"] if r["kind"] in ("senate", "governor", "house")]
    cache = {}
    lines, n_races, n_polls = [], 0, 0
    for race in races:
        dname, rname = nominees(race)
        title = title_for(race)
        if not (dname and rname and title):
            continue
        if title not in cache:
            h = page_html(title)
            p = Tables()
            if h:
                p.feed(h)
            cache[title] = [t for t in p.tables if t]
            time.sleep(0.5)
        polls = find_polls(cache[title], dname, rname)
        if not polls:
            continue
        n_races += 1
        src = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(title)
        for x in polls:
            n_polls += 1
            lines.append(
                "INSERT INTO polls (race_id, pollster, partisan, start_date, end_date, sample, pop, d, r, other, undecided, d_name, r_name, source, seen) VALUES ("
                + ",".join([sql_str(race["id"]), sql_str(x["pollster"]), sql_str(x["partisan"]), sql_str(x["start"]), sql_str(x["end"]), sql_num(x["sample"]), sql_str(x["pop"]),
                            sql_num(x["d"]), sql_num(x["r"]), sql_num(x["other"]), sql_num(x["undecided"]), sql_str(dname), sql_str(rname), sql_str(src), str(int(now.timestamp()))])
                + ") ON CONFLICT(race_id, pollster, end_date, pop) DO UPDATE SET d = excluded.d, r = excluded.r, other = excluded.other, undecided = excluded.undecided, sample = excluded.sample, seen = excluded.seen;"
            )
    with open(os.path.join(OUT, "polls.sql"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print(f"polls: {n_polls} polls for {n_races} races from {len(cache)} pages")


if __name__ == "__main__":
    main()
