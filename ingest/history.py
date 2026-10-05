#!/usr/bin/env python3
"""Past elections: official results from the MIT Election Data and Science Lab (MEDSL) and OpenElections.

Sources (all public; MEDSL data is CC0):
  MEDSL on Harvard Dataverse  U.S. President 1976-2024 (state), U.S. Senate 1976-2024 (state), U.S. House 1976-2024
                              (district), County Presidential Returns 2000-2024. The House and county files sit behind
                              Dataverse's download form (name, email, institution, position): set MEDSL_EMAIL.
  OpenElections (GitHub)      2022 general election, county or precinct level, summed to counties: Senate and governor.

Writes out/history/ (uploaded to R2 DATA history/ by --publish):
  president.json             {national: {year: {D,R,T}}, states: {ST: {year: {D,R,T,dn,rn}}}}
  senate.json                {ST: [{year, special, D, R, T, dn, rn, w}]}
  house-seats.json           {year: {ST: [D seats, R seats, other]}}
  states/<ST>.json           {house: {year: {district: {D,R,T,dn,rn,w}}}, counties: {fips: {n, y: {year: [D,R,T]}}},
                              mid2022: {senate|governor: {county name: [D,R,T]}}}
Raw downloads are kept in out/history_raw/ (archive.py stores them in R2).

Usage: MEDSL_EMAIL=you@example.org python3 ingest/history.py [--publish]   (rarely: the data changes a few times a year)
"""
import csv
import io
import json
import os
import subprocess
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "history")
RAW = os.path.join(HERE, "out", "history_raw")
DV = "https://dataverse.harvard.edu/api/access/datafile"
FILES = {"president.csv": 13887042, "senate.tsv": 13887039, "house.tsv": 13592823, "county.tsv": 13573089}
GUESTBOOK = {"house.tsv", "county.tsv"}
STATES = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN",
          "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA",
          "WV", "WI", "WY"]
csv.field_size_limit(10_000_000)


def curl(args):
    r = subprocess.run(["curl", "-sL", "--max-time", "600"] + args, capture_output=True)
    return r.stdout


def download(name, fid):
    path = os.path.join(RAW, name)
    if os.path.exists(path) and os.path.getsize(path) > 10_000:
        return path
    if name in GUESTBOOK:
        email = os.environ.get("MEDSL_EMAIL")
        if not email:
            sys.exit(f"{name} needs MEDSL_EMAIL (Dataverse's download form asks for an email)")
        gb = json.dumps({"guestbookResponse": {"name": "Parlay the People", "email": email, "institution": "Parlay the People", "position": "Research"}})
        signed = json.loads(curl(["-X", "POST", "-H", "Content-Type: application/json", "-d", gb, f"{DV}/{fid}?format=original"]))["data"]["signedUrl"]
        data = curl([signed])
    else:
        data = curl([f"{DV}/{fid}?format=original"])
    if len(data) < 10_000:
        sys.exit(f"{name}: download failed ({data[:200]!r})")
    open(path, "wb").write(data)
    return path


def rows(path):
    with open(path, newline="", encoding="utf-8") as fh:
        sample = fh.read(4096)
        fh.seek(0)
        yield from csv.DictReader(fh, delimiter="\t" if sample.count("\t") > sample.count(",") else ",")


def party_of(p):
    p = (p or "").upper()
    if p.startswith("DEMOCRAT") or "FARMER" in p or p in ("DFL", "DEM"):
        return "D"
    if p.startswith("REPUBLICAN") or p in ("REP", "GOP"):
        return "R"
    return "O"


# rows in the files that aren't candidates (ranked-choice exhausted ballots, blanks, over/under votes, scattered write-ins)
NOT_CANDIDATES = ("EXHAUSTED", "BLANK", "OVERVOTE", "OVER VOTE", "UNDERVOTE", "UNDER VOTE", "SCATTER", "WRITEIN", "WRITE-IN", "VOID", "NONE OF THESE")


def race_result(cands):
    """{candidate: [party set, votes]} -> D/R totals, total votes for real candidates, the main D and R names, the winner's party."""
    cands = {n: v for n, v in cands.items() if n not in ("", "?", "NA") and not any(w in n.upper() for w in NOT_CANDIDATES)}
    out = {"D": 0, "R": 0, "dn": None, "rn": None, "T": sum(v[1] for v in cands.values())}
    best = {}
    for name, (parties, votes) in cands.items():
        p = "D" if "D" in parties else "R" if "R" in parties else "O"
        if p in ("D", "R"):
            out[p] += votes
            if votes > best.get(p, (0,))[0]:
                best[p] = (votes, name)
    out["dn"], out["rn"] = best.get("D", (0, None))[1], best.get("R", (0, None))[1]
    top = max(cands.items(), key=lambda kv: kv[1][1]) if cands else None
    out["w"] = ("D" if "D" in top[1][0] else "R" if "R" in top[1][0] else "O") if top else None
    return out


def title(n):
    return " ".join(w.capitalize() if not w.startswith("MC") else "Mc" + w[2:].capitalize() for w in (n or "").replace('"', "").split()) if n else None


def president():
    by = defaultdict(lambda: defaultdict(lambda: [set(), 0]))
    total = {}
    for r in rows(download("president.csv", FILES["president.csv"])):
        if r.get("writein") == "True":
            continue
        k = (int(r["year"]), r["state_po"])
        c = by[k][r["candidate"]]
        c[0].add(party_of(r.get("party_simplified") or r.get("party_detailed")))
        c[1] += int(float(r["candidatevotes"] or 0))
        total[k] = int(float(r["totalvotes"] or 0))
    states, national = defaultdict(dict), defaultdict(lambda: {"D": 0, "R": 0, "T": 0})
    for (year, st), cands in by.items():
        res = race_result(cands)
        states[st][year] = {"D": res["D"], "R": res["R"], "T": res["T"], "dn": title(res["dn"]), "rn": title(res["rn"])}
        for f in ("D", "R"):
            national[year][f] += res[f]
        national[year]["T"] += res["T"]
    return {"national": dict(sorted(national.items())), "states": states}


def senate():
    by = defaultdict(lambda: defaultdict(lambda: [set(), 0]))
    meta = {}
    for r in rows(download("senate.tsv", FILES["senate.tsv"])):
        if (r.get("stage") or "").lower() != "gen" or r.get("writein") == "True":
            continue
        k = (int(r["year"]), r["state_po"], r.get("special") == "True")
        c = by[k][r["candidate"] or "?"]
        c[0].add(party_of(r.get("party_simplified") or r.get("party_detailed")))
        c[1] += int(float(r["candidatevotes"] or 0))
        meta[k] = int(float(r["totalvotes"] or 0))
    out = defaultdict(list)
    for (year, st, special), cands in sorted(by.items()):
        res = race_result(cands)
        out[st].append({"year": year, "special": special, "D": res["D"], "R": res["R"], "T": res["T"], "dn": title(res["dn"]), "rn": title(res["rn"]), "w": res["w"]})
    return out


def house():
    by = defaultdict(lambda: defaultdict(lambda: [set(), 0]))
    meta = {}
    for r in rows(download("house.tsv", FILES["house.tsv"])):
        if (r.get("stage") or "").upper() != "GEN" or r.get("writein") == "TRUE" or r.get("special") == "TRUE" or r.get("runoff") == "TRUE":
            continue
        dist = str(int(r["district"])) if (r["district"] or "0").isdigit() else "0"
        k = (int(r["year"]), r["state_po"], dist)
        c = by[k][r["candidate"] or "?"]
        c[0].add(party_of(r.get("party")))
        c[1] += int(float(r["candidatevotes"] or 0))
        meta[k] = int(float(r["totalvotes"] or 0))
    per_state = defaultdict(lambda: defaultdict(dict))
    seats = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))
    for (year, st, dist), cands in by.items():
        res = race_result(cands)
        per_state[st][year][dist] = {"D": res["D"], "R": res["R"], "T": res["T"], "dn": title(res["dn"]), "rn": title(res["rn"]), "w": res["w"]}
        seats[year][st]["DRO".index(res["w"] or "O")] += 1
    return per_state, seats


def counties():
    # some years report only by voting mode (election day, absentee…): use TOTAL rows where they exist, else add the modes
    tot = defaultdict(lambda: defaultdict(int))
    modes = defaultdict(lambda: defaultdict(int))
    names, has_total = {}, set()
    for r in rows(download("county.tsv", FILES["county.tsv"])):
        fips = (r.get("county_fips") or "").replace(".0", "").zfill(5)
        if not fips.strip("0") or fips == "000NA":
            continue
        k = (r["state_po"], fips, int(r["year"]))
        names[fips] = r["county_name"].title()
        p = party_of(r.get("party"))
        v = int(float(r["candidatevotes"] or 0) if r["candidatevotes"] not in ("", "NA") else 0)
        if (r.get("mode") or "TOTAL").upper() == "TOTAL":
            has_total.add(k)
            tot[k][p] += v
        else:
            modes[k][p] += v
    out = defaultdict(lambda: defaultdict(lambda: {"n": "", "y": {}}))
    for k in set(tot) | set(modes):
        st, fips, year = k
        src = tot[k] if k in has_total else modes[k]
        c = out[st][fips]
        c["n"] = names[fips]
        c["y"][year] = [src["D"], src["R"], src["D"] + src["R"] + src["O"]]
    return out


def midterm2022(st):
    """OpenElections 2022 general: Senate and governor by county (county file, or precincts summed)."""
    base = f"https://raw.githubusercontent.com/openelections/openelections-data-{st.lower()}/master/2022"
    for name in (f"20221108__{st.lower()}__general__county.csv", f"20221108__{st.lower()}__general__precinct.csv"):
        data = curl(["--fail", f"{base}/{name}"])
        if len(data) > 1000:
            break
    else:
        return None
    open(os.path.join(RAW, f"openelections-{name}"), "wb").write(data)
    out = {"senate": defaultdict(lambda: [0, 0, 0]), "governor": defaultdict(lambda: [0, 0, 0])}
    for r in csv.DictReader(io.StringIO(data.decode("utf-8", "replace"))):
        office = (r.get("office") or "").lower()
        key = "senate" if office in ("u.s. senate", "us senate", "united states senator", "u.s. senator") else "governor" if office.startswith("governor") else None
        county = (r.get("county") or "").strip().title()
        if not key or not county:
            continue
        try:
            v = int(float((r.get("votes") or "0").replace(",", "")))
        except ValueError:
            continue
        p = party_of(r.get("party"))
        row = out[key][county]
        row["DRO".index(p) if p in "DR" else 2] += v
    for k in out:
        for row in out[k].values():
            row[2] += row[0] + row[1]  # third slot: total votes
    res = {k: dict(v) for k, v in out.items() if v}
    return res or None


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(os.path.join(OUT, "states"), exist_ok=True)
    pres = president()
    json.dump(pres, open(os.path.join(OUT, "president.json"), "w"), separators=(",", ":"))
    sen = senate()
    json.dump(sen, open(os.path.join(OUT, "senate.json"), "w"), separators=(",", ":"))
    hs, seats = house()
    json.dump(seats, open(os.path.join(OUT, "house-seats.json"), "w"), separators=(",", ":"))
    cty = counties()
    mid = 0
    for st in STATES:
        m = midterm2022(st) if st != "DC" else None
        mid += bool(m)
        json.dump({"house": hs.get(st, {}), "counties": cty.get(st, {}), "mid2022": m}, open(os.path.join(OUT, "states", f"{st}.json"), "w"), separators=(",", ":"))
    print(f"history: president {len(pres['national'])} elections, senate {sum(len(v) for v in sen.values())} races, "
          f"house {len(seats)} elections, counties in {len(cty)} states, OpenElections 2022 for {mid} states")
    if "--publish" in sys.argv:
        wr = ["npx", "--yes", "wrangler@4", "r2", "object", "put"]
        site = os.path.dirname(HERE)
        files = ["president.json", "senate.json", "house-seats.json"] + [f"states/{st}.json" for st in STATES]
        for f in files:
            subprocess.run(wr + [f"ballottape-data/history/{f}", "--file", os.path.join(OUT, f), "--content-type", "application/json", "--remote"], cwd=site, capture_output=True)
        for f in os.listdir(RAW):
            subprocess.run(["gzip", "-kf", os.path.join(RAW, f)])
            subprocess.run(wr + [f"ballottape-data/archive/raw/history/{f}.gz", "--file", os.path.join(RAW, f + ".gz"), "--content-type", "application/gzip", "--remote"], cwd=site, capture_output=True)
        print(f"history: published {len(files)} files to R2")


if __name__ == "__main__":
    main()
