#!/usr/bin/env python3
"""Congress.gov: every sitting member of Congress and the bills they sponsor, plus the bills moving this week.

Uses the api.data.gov key the FEC collector already has (FEC_API_KEY; any api.data.gov key works on Congress.gov,
1,000 requests an hour). Each collector run (every 10 minutes) fetches:
  - the current-member list (3 requests)
  - detail and the 20 latest sponsored bills for a rotating slice of members (2 requests each, BATCH members), so
    every member is refreshed about every 9 hours
  - the 100 most recently updated bills (1 request), for "what Congress did this week" and the newsroom

Writes out/congress.sql (upserts into ballottape-markets: congress_members, congress_bills). Pass --all to refresh
every member at once (about 1,100 requests: run by hand, at most once an hour).
"""
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
API = "https://api.congress.gov/v3"
KEY = os.environ.get("CONGRESS_API_KEY") or os.environ.get("FEC_API_KEY") or ""
BATCH = int(os.environ.get("CONGRESS_BATCH", "10"))
NOW = datetime.datetime.now(datetime.timezone.utc)
SLOT_MIN = 10   # collector cadence, minutes
STATE_CODE = {"Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
              "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS", "Kentucky": "KY",
              "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN", "Mississippi": "MS", "Missouri": "MO",
              "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY",
              "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR", "Pennsylvania": "PA", "Rhode Island": "RI",
              "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT", "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
              "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "District of Columbia": "DC", "Puerto Rico": "PR", "Guam": "GU",
              "American Samoa": "AS", "Virgin Islands": "VI", "Northern Mariana Islands": "MP"}


def api(path, **params):
    params.update({"format": "json", "api_key": KEY})
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "--max-time", "60", "-A", "ParlayThePeople/1.0 (https://parlaythepeople.com)", url], capture_output=True, text=True)
        try:
            d = json.loads(r.stdout)
        except json.JSONDecodeError:
            d = {}
        if d and "error" not in d:
            time.sleep(0.5)
            return d
        time.sleep(10 * (attempt + 1))  # rate limited or busy
    return None


def q(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def members():
    out, offset = [], 0
    while True:
        d = api("/member", currentMember="true", limit=250, offset=offset)
        if not d:
            break
        out += d.get("members", [])
        if not d.get("pagination", {}).get("next"):
            break
        offset += 250
    return out


def chamber_of(m):
    terms = (m.get("terms") or {}).get("item") or m.get("terms") or []
    last = terms[-1] if terms else {}
    return ("senate" if "Senate" in (last.get("chamber") or "") else "house"), min((t.get("startYear") or 9999) for t in terms) if terms else None


def member_rows(m, detail, bills):
    chamber, since = chamber_of(m)
    det = detail.get("member", {}) if detail else {}
    dep = det.get("depiction") or m.get("depiction") or {}
    st = next((t.get("stateCode") for t in reversed(det.get("terms", [])) if t.get("stateCode")), None) or STATE_CODE.get(m.get("state"))
    party = (det.get("partyHistory") or [{}])[-1].get("partyAbbreviation") or (m.get("partyName") or "?")[:1]
    leadership = "; ".join(f"{x.get('type')} ({x.get('congress')})" for x in det.get("leadership", []) if x.get("current")) or None
    row = {
        "bioguide": m["bioguideId"], "name": det.get("directOrderName") or m.get("name"), "first": det.get("firstName"), "last": det.get("lastName"),
        "party": party, "state": st, "state_name": m.get("state"), "district": m.get("district"), "chamber": chamber, "since": since,
        "birth_year": int(det["birthYear"]) if str(det.get("birthYear") or "").isdigit() else None,
        "photo": dep.get("imageUrl"), "photo_credit": dep.get("attribution"), "website": det.get("officialWebsiteUrl"),
        "phone": (det.get("addressInformation") or {}).get("phoneNumber"), "office": (det.get("addressInformation") or {}).get("officeAddress"),
        "leadership": leadership,
        "sponsored": (det.get("sponsoredLegislation") or {}).get("count"), "cosponsored": (det.get("cosponsoredLegislation") or {}).get("count"),
        "updated": int(NOW.timestamp()),
    }
    sql = [f"INSERT INTO congress_members ({','.join(row)}) VALUES ({','.join(q(v) for v in row.values())}) ON CONFLICT(bioguide) DO UPDATE SET "
           + ", ".join(f"{k} = excluded.{k}" for k in row if k != "bioguide") + ";"]
    for b in bills:
        sql.append(bill_sql(b, sponsor=m["bioguideId"]))
    return sql


def bill_id(b):
    return f"{b.get('congress')}-{str(b.get('type') or '').lower()}-{b.get('number')}"


def bill_sql(b, sponsor=None):
    la = b.get("latestAction") or {}
    pa = b.get("policyArea") or {}
    row = {
        "id": bill_id(b), "congress": b.get("congress"), "type": (b.get("type") or "").upper(), "number": str(b.get("number") or ""),
        "title": (b.get("title") or "")[:500], "introduced": b.get("introducedDate"), "policy_area": pa.get("name"),
        "latest_action": (la.get("text") or "")[:500], "latest_action_date": la.get("actionDate"),
        "sponsor": sponsor, "updated": int(NOW.timestamp()),
    }
    keep = ["title", "policy_area", "latest_action", "latest_action_date", "updated"] + (["sponsor"] if sponsor else []) + (["introduced"] if row["introduced"] else [])
    return (f"INSERT INTO congress_bills ({','.join(row)}) VALUES ({','.join(q(v) for v in row.values())}) ON CONFLICT(id) DO UPDATE SET "
            + ", ".join(f"{k} = excluded.{k}" for k in keep) + ";")


def main():
    if not KEY:
        print("congress: no api.data.gov key (FEC_API_KEY or CONGRESS_API_KEY); skipping")
        return
    ms = sorted(members(), key=lambda m: m["bioguideId"])
    if not ms:
        print("congress: member list unavailable")
        return
    if "--all" in sys.argv:
        batch = ms
    else:
        slots = -(-len(ms) // BATCH)
        slot = int(NOW.timestamp() // (SLOT_MIN * 60)) % slots
        batch = ms[slot * BATCH:(slot + 1) * BATCH]
    sql = []
    for m in batch:
        detail = api(f"/member/{m['bioguideId']}")
        spons = api(f"/member/{m['bioguideId']}/sponsored-legislation", limit=20) or {}
        bills = [b for b in spons.get("sponsoredLegislation", []) if b.get("type") and b.get("number")]
        sql += member_rows(m, detail, bills)
    # the member list itself refreshes names, parties and districts for everyone (cheap; no extra requests)
    for m in ms:
        if m in batch:
            continue
        chamber, since = chamber_of(m)
        dep = m.get("depiction") or {}
        # the list gives "Last, First"; the detail refresh fills first/last/name properly
        last = (m.get("name") or "").split(",")[0].strip() or None
        sql.append("INSERT INTO congress_members (bioguide, name, last, party, state, state_name, district, chamber, since, photo, photo_credit, updated) VALUES ("
                   + ",".join(q(v) for v in [m["bioguideId"], m.get("name"), last, (m.get("partyName") or "?")[:1], STATE_CODE.get(m.get("state")), m.get("state"), m.get("district"), chamber, since, dep.get("imageUrl"), dep.get("attribution"), int(NOW.timestamp())])
                   + ") ON CONFLICT(bioguide) DO UPDATE SET party = excluded.party, state = COALESCE(excluded.state, congress_members.state), state_name = excluded.state_name, district = excluded.district, chamber = excluded.chamber, photo = excluded.photo;")
    recent = api("/bill", limit=100, sort="updateDate desc") or {}
    for b in recent.get("bills", []):
        if b.get("type") and b.get("number"):
            sql.append(bill_sql(b))
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "congress.sql"), "w") as f:
        f.write("\n".join(sql) + "\n")
    print(f"congress: {len(ms)} members listed, {len(batch)} refreshed in detail, {len(recent.get('bills', []))} recent bills")


if __name__ == "__main__":
    main()
