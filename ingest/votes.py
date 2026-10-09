#!/usr/bin/env python3
"""Roll-call votes in the current Congress, House and Senate, and how every member voted.

Sources (official, public domain, no key):
  House   clerk.house.gov/evs/<year>/roll<NNN>.xml    the Clerk's roll-call record (what Congress.gov shows)
  Senate  senate.gov/legislative/LIS/roll_call_lists/vote_menu_<congress>_<session>.xml, then each vote's XML
  IDs     unitedstates.github.io/congress-legislators   senate.gov's LIS ids → Congress.gov bioguide ids

Each collector run fetches up to CAP new roll calls (oldest first), so the first backfill of a Congress takes a few
hours of runs, then each run picks up whatever was voted since. Progress is read back from D1 (the highest roll call
stored per chamber and session; the collector runs on a fresh machine each time), or out/votes_state.json locally.

Writes out/votes.sql (ballottape-markets: congress_votes, congress_member_votes). --all ignores CAP.
"""
import datetime
import json
import os
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
STATE = os.path.join(OUT, "votes_state.json")
CAP = int(os.environ.get("VOTES_CAP", "60"))
NOW = datetime.datetime.now(datetime.timezone.utc)
CONGRESS = (NOW.year - 1789) // 2 + 1          # 2025-26 = 119th
SESSIONS = [(1, CONGRESS * 2 + 1787), (2, CONGRESS * 2 + 1788)]  # (session, year)
UA = "Mozilla/5.0 (compatible; ParlayThePeople/1.0; +https://parlaythepeople.com)"
POS = {"yea": "yea", "aye": "yea", "yes": "yea", "nay": "nay", "no": "nay", "present": "present", "not voting": "absent"}
MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def get(url):
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "-L", "--max-time", "60", "-A", UA, "-w", "\n%{http_code}", url], capture_output=True, text=True)
        body, _, code = r.stdout.rpartition("\n")
        if code == "200":
            time.sleep(0.3)
            return body
        if code == "404":
            return None
        time.sleep(5 * (attempt + 1))
    return None


def xml(url):
    body = get(url)
    if not body or not body.lstrip().startswith("<?xml"):
        return None  # the Clerk answers a missing roll call with an HTML page
    try:
        return ET.fromstring(body.encode("utf-8"))
    except ET.ParseError:
        return None


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def txt(el, path):
    x = el.find(path)
    return re.sub(r"\s+", " ", (x.text or "")).strip() if x is not None and x.text else None


def vote_sql(row, votes):
    """Upsert a roll call and replace its member votes. votes: [(bioguide, position, party)]."""
    tally = {(p, pos): 0 for p in "DRI" for pos in ("yea", "nay")}
    for _, pos, party in votes:
        if (party, pos) in tally:
            tally[(party, pos)] += 1
    row.update({"d_yea": tally[("D", "yea")], "d_nay": tally[("D", "nay")], "r_yea": tally[("R", "yea")], "r_nay": tally[("R", "nay")], "updated": int(NOW.timestamp())})
    sql = [f"INSERT INTO congress_votes ({','.join(row)}) VALUES ({','.join(q(v) for v in row.values())}) ON CONFLICT(id) DO UPDATE SET "
           + ", ".join(f"{k} = excluded.{k}" for k in row if k != "id") + ";",
           f"DELETE FROM congress_member_votes WHERE vote_id = {q(row['id'])};"]
    for i in range(0, len(votes), 200):
        sql.append("INSERT INTO congress_member_votes (vote_id, bioguide, position) VALUES "
                   + ",".join(f"({q(row['id'])},{q(b)},{q(p)})" for b, p, _ in votes[i:i + 200]) + ";")
    return sql


def house(state, budget):
    sql = []
    for session, year in SESSIONS:
        if year > NOW.year or budget <= 0:
            continue
        key = f"h-{CONGRESS}-{session}"
        n = state.get(key, 0)
        while budget > 0:
            doc = xml(f"https://clerk.house.gov/evs/{year}/roll{n + 1:03d}.xml")
            if doc is None:
                break
            n += 1
            budget -= 1
            meta = doc.find("vote-metadata")
            d = txt(meta, "action-date") or ""   # 24-Feb-2026
            m = re.match(r"(\d+)-(\w{3})-(\d{4})", d)
            date = f"{m.group(3)}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}" if m else None
            tot = meta.find("vote-totals/totals-by-vote")
            num = lambda p: int(txt(tot, p) or 0) if tot is not None else None
            votes = []
            for rv in doc.iter("recorded-vote"):
                leg, cast = rv.find("legislator"), (txt(rv, "vote") or "").lower()
                if leg is not None and leg.get("name-id") and cast in POS:
                    votes.append((leg.get("name-id"), POS[cast], (leg.get("party") or "")[:1]))
            row = {"id": f"h-{CONGRESS}-{session}-{n}", "chamber": "house", "congress": CONGRESS, "session": session, "roll": n, "date": date,
                   "question": txt(meta, "vote-question"), "title": txt(meta, "vote-desc"), "result": txt(meta, "vote-result"), "bill": txt(meta, "legis-num"),
                   "yea": num("yea-total"), "nay": num("nay-total"), "present": num("present-total"), "absent": num("not-voting-total")}
            sql += vote_sql(row, votes)
        state[key] = n
    return sql, budget


def lis_map():
    body = get("https://unitedstates.github.io/congress-legislators/legislators-current.json")
    try:
        return {p["id"]["lis"]: p["id"]["bioguide"] for p in json.loads(body or "[]") if p.get("id", {}).get("lis")}
    except (json.JSONDecodeError, KeyError):
        return {}


def senate(state, budget):
    sql, ids = [], None
    for session, year in SESSIONS:
        if year > NOW.year or budget <= 0:
            continue
        key = f"s-{CONGRESS}-{session}"
        menu = xml(f"https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_{CONGRESS}_{session}.xml")
        if menu is None:
            continue
        latest = max((int(txt(v, "vote_number") or 0) for v in menu.iter("vote")), default=0)
        n = state.get(key, 0)
        while n < latest and budget > 0:
            num = n + 1
            doc = xml(f"https://www.senate.gov/legislative/LIS/roll_call_votes/vote{CONGRESS}{session}/vote_{CONGRESS}_{session}_{num:05d}.xml")
            if doc is None:
                break
            ids = ids if ids is not None else lis_map()
            n, budget = num, budget - 1
            d = txt(doc, "vote_date") or ""     # January 5, 2026,  05:31 PM
            try:
                date = datetime.datetime.strptime(d.split(",")[0] + "," + d.split(",")[1], "%B %d, %Y").strftime("%Y-%m-%d")
            except (ValueError, IndexError):
                date = None
            votes = []
            for mem in doc.iter("member"):
                cast, b = (txt(mem, "vote_cast") or "").lower(), ids.get(txt(mem, "lis_member_id") or "")
                if b and cast in POS:
                    votes.append((b, POS[cast], txt(mem, "party") or ""))
            c = doc.find("count")
            cnt = lambda p: int(txt(c, p) or 0) if c is not None else None
            row = {"id": f"s-{CONGRESS}-{session}-{num}", "chamber": "senate", "congress": CONGRESS, "session": session, "roll": num, "date": date,
                   "question": txt(doc, "question") or txt(doc, "vote_question_text"), "title": txt(doc, "vote_title") or txt(doc, "vote_document_text"),
                   "result": txt(doc, "vote_result"), "bill": txt(doc, "document/document_name"),
                   "yea": cnt("yeas"), "nay": cnt("nays"), "present": cnt("present"), "absent": cnt("absent")}
            sql += vote_sql(row, votes)
        state[key] = n
    return sql, budget


def stored():
    """The last roll call already in D1 for each chamber and session, or None if D1 can't be read."""
    r = subprocess.run(["npx", "--yes", "wrangler@4", "d1", "execute", "ballottape-markets", "--remote", "--json", "--command",
                        f"SELECT chamber, session, MAX(roll) AS n FROM congress_votes WHERE congress = {CONGRESS} GROUP BY chamber, session"],
                       capture_output=True, text=True, cwd=os.path.dirname(HERE))
    try:
        return {f"{x['chamber'][0]}-{CONGRESS}-{x['session']}": x["n"] for x in json.loads(r.stdout)[0]["results"]}
    except Exception:
        return None


def main():
    os.makedirs(OUT, exist_ok=True)
    try:
        state = json.load(open(STATE))
    except (OSError, json.JSONDecodeError):
        state = {}
    if os.environ.get("CLOUDFLARE_API_TOKEN"):
        state.update(stored() or {})
    budget = 10 ** 6 if "--all" in sys.argv else CAP
    half = -(-budget // 2)
    hs, left = house(state, half)
    ss, _ = senate(state, budget - (half - left))   # the Senate gets whatever the House didn't use
    sql = hs + ss
    if sql:
        with open(os.path.join(OUT, "votes.sql"), "a") as f:   # appended: a failed upload is retried next run
            f.write("\n".join(sql) + "\n")
    json.dump(state, open(STATE, "w"))
    print(f"votes: {sum(s.startswith('INSERT INTO congress_votes') for s in sql)} roll calls; at {state}")


if __name__ == "__main__":
    main()
