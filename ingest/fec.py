#!/usr/bin/env python3
"""Campaign finance from the FEC's bulk files (no key needed), once a day.

For each cycle the site follows (2026, 2028):
  cn<yy>.zip                    candidate master: who is running for what, this cycle
  weball<yy>.zip                every candidate's totals: raised, spent, cash on hand, debts, through the last report
  independent_expenditure_<yyyy>.csv   outside spending for or against each candidate (super PACs, parties, groups)

Writes:
  out/fec.sql                  D1 (ballottape-markets): fec_candidates, fec_outside (replaced each run)
  out/fec_raw/*                the files as downloaded (archive.py stores them in R2 under archive/raw/)

Runs in the first collector run after 07:00 UTC unless --force. House and Senate only: governors and other state
offices file with their states, not the FEC.
"""
import csv
import datetime
import glob
import hashlib
import json
import time
import urllib.parse
import io
import os
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
RAWDIR = os.path.join(OUT, "fec_raw")
BULK = "https://www.fec.gov/files/bulk-downloads"
CYCLES = [2026, 2028]
API = "https://api.open.fec.gov/v1"
API_KEY = os.environ.get("FEC_API_KEY", "")
ROTATE = 3   # OpenFEC detail: each focus candidate is refreshed every ROTATE days, a third of them a day
NOW = datetime.datetime.now(datetime.timezone.utc)


def fetch(url):
    r = subprocess.run(["curl", "-sL", "--max-time", "300", "--fail", url], capture_output=True)
    if r.returncode:
        raise RuntimeError(f"download failed: {url}")
    return r.stdout


def keep(name, data):
    """Keep a raw download for archive.py to store in R2."""
    os.makedirs(RAWDIR, exist_ok=True)
    open(os.path.join(RAWDIR, f"fec-{name}"), "wb").write(data)


def unzip_one(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    return z.read(z.namelist()[0]).decode("latin-1")


def num(x):
    try:
        return round(float(x), 2)
    except (TypeError, ValueError):
        return 0.0


def q(s):
    return "NULL" if s is None or s == "" else "'" + str(s).replace("'", "''") + "'"


def cycle_rows(cycle):
    yy = str(cycle)[2:]
    cn_raw = fetch(f"{BULK}/{cycle}/cn{yy}.zip")
    wb_raw = fetch(f"{BULK}/{cycle}/weball{yy}.zip")
    keep(f"cn{yy}.zip", cn_raw)
    keep(f"weball{yy}.zip", wb_raw)
    # candidate master: CAND_ID|CAND_NAME|CAND_PTY_AFFILIATION|CAND_ELECTION_YR|CAND_OFFICE_ST|CAND_OFFICE|CAND_OFFICE_DISTRICT|CAND_ICI|CAND_STATUS|...
    running = {}
    for line in unzip_one(cn_raw).splitlines():
        f = line.split("|")
        if len(f) < 9 or f[5] not in ("H", "S") or f[3] != str(cycle):
            continue
        running[f[0]] = {"office": f[5], "state": f[4], "district": f[6] if f[5] == "H" else None, "ici": f[7], "status": f[8]}
    # totals: CAND_ID|CAND_NAME|CAND_ICI|PTY_CD|CAND_PTY_AFFILIATION|TTL_RECEIPTS|TRANS_FROM_AUTH|TTL_DISB|TRANS_TO_AUTH|COH_BOP|COH_COP|
    #         CAND_CONTRIB|CAND_LOANS|OTHER_LOANS|CAND_LOAN_REPAY|OTHER_LOAN_REPAY|DEBTS_OWED_BY|TTL_INDIV_CONTRIB|CAND_OFFICE_ST|CAND_OFFICE_DISTRICT|
    #         SPEC_ELECTION|PRIM_ELECTION|RUN_ELECTION|GEN_ELECTION|GEN_ELECTION_PRECENT|OTHER_POL_CMTE_CONTRIB|POL_PTY_CONTRIB|CVG_END_DT|...
    rows = []
    for line in unzip_one(wb_raw).splitlines():
        f = line.split("|")
        if len(f) < 28 or f[0] not in running:
            continue
        m = running[f[0]]
        cvg = f[27]
        cvg = f"{cvg[6:10]}-{cvg[0:2]}-{cvg[3:5]}" if len(cvg) == 10 else None
        rows.append({
            "cand_id": f[0], "cycle": cycle, "name": f[1], "party": f[4] or None, "office": m["office"], "state": m["state"],
            "district": m["district"], "ici": f[2] or m["ici"], "receipts": num(f[5]), "disbursements": num(f[7]),
            "cash": num(f[10]), "debts": num(f[16]), "indiv": num(f[17]), "pac": num(f[25]), "party_contrib": num(f[26]),
            "self": num(f[11]) + num(f[12]), "coverage_end": cvg,
        })
    return rows


def outside_rows(cycle, real=None):
    """Outside spending per candidate, per spender and per week. Junk filings are dropped: any single expenditure of
    $100M or more, and spending on candidates whose own campaigns raised under $5,000 (`real` = the ids that count)."""
    raw = fetch(f"{BULK}/{cycle}/independent_expenditure_{cycle}.csv")
    keep(f"independent_expenditure_{cycle}.csv", raw)
    latest = {}  # (spender, transaction) -> row from the newest filing, so amendments replace what they amend
    for r in csv.DictReader(io.StringIO(raw.decode("latin-1"))):
        if not r.get("cand_id") or r.get("sup_opp") not in ("S", "O") or num(r.get("exp_amo")) >= 100_000_000:
            continue
        if real is not None and r["cand_id"] not in real:
            continue
        k = (r.get("spe_id"), r.get("tran_id"))
        if k not in latest or num(r.get("file_num")) >= num(latest[k].get("file_num")):
            latest[k] = r
    by = {}
    spenders, weeks = {}, {}
    for r in latest.values():
        amt = num(r.get("exp_amo"))
        pty = (r.get("cand_pty_aff") or "").upper()
        side = "D" if pty.startswith("DEMOCRAT") else "R" if pty.startswith("REPUBLICAN") else None
        # which party it helped, for general-election spending only: opposing a Republican in a primary isn't helping a Democrat
        general = (r.get("ele_type") or "G").upper().startswith("G")
        helps = None if not side or not general else (side if r["sup_opp"] == "S" else ("R" if side == "D" else "D"))
        sp = spenders.setdefault(r.get("spe_id") or r.get("spe_nam"), {"name": r.get("spe_nam") or "Unknown", "D": 0.0, "R": 0.0, "other": 0.0, "n": 0, "cands": {}})
        sp["D" if helps == "D" else "R" if helps == "R" else "other"] += amt
        sp["n"] += 1
        sp["cands"][r["cand_id"]] = sp["cands"].get(r["cand_id"], 0) + amt
        d = r.get("dissem_dt") or r.get("exp_date") or ""
        try:
            day = datetime.datetime.strptime(d, "%d-%b-%y").date()
        except ValueError:
            day = None
        if day and helps:
            wk = (day - datetime.timedelta(days=day.weekday())).isoformat()
            w = weeks.setdefault(wk, {"D": 0.0, "R": 0.0})
            w[helps] += amt
        c = by.setdefault(r["cand_id"], {"support": 0.0, "oppose": 0.0, "n": 0, "spenders": {}})
        amt = num(r.get("exp_amo"))
        c["support" if r["sup_opp"] == "S" else "oppose"] += amt
        c["n"] += 1
        s = c["spenders"].setdefault(r.get("spe_nam") or "Unknown", [0.0, 0.0])
        s[0 if r["sup_opp"] == "S" else 1] += amt
    out = []
    outside_rows.spenders = spenders
    outside_rows.weeks = weeks
    for cid, c in by.items():
        top = sorted(c["spenders"].items(), key=lambda kv: -(kv[1][0] + kv[1][1]))[:5]
        out.append({"cand_id": cid, "cycle": cycle, "support": round(c["support"], 2), "oppose": round(c["oppose"], 2), "n": c["n"],
                    "top": "|".join(f"{n.replace('|', ' ')}~{round(s)}~{round(o)}" for n, (s, o) in top)})
    return out


def committee_rows(cycle):
    """Party committees, super PACs and other PACs from the committee summary file (webk), those that raised $100K+."""
    yy = str(cycle)[2:]
    raw = fetch(f"{BULK}/{cycle}/webk{yy}.zip")
    keep(f"webk{yy}.zip", raw)
    out = []
    # CMTE_ID|CMTE_NM|CMTE_TP|CMTE_DSGN|CMTE_FILING_FREQ|TTL_RECEIPTS|TRANS_FROM_AFF|INDV_CONTRIB|OTHER_POL_CMTE_CONTRIB|CAND_CONTRIB|CAND_LOANS|
    # TTL_LOANS_RECEIVED|TTL_DISB|TRANF_TO_AFF|INDV_REFUNDS|OTHER_POL_CMTE_REFUNDS|CAND_LOAN_REPAY|LOAN_REPAY|COH_BOP|COH_COP|DEBTS_OWED_BY|
    # NONFED_TRANS_RECEIVED|CONTRIB_TO_OTHER_CMTE|IND_EXP|PTY_COORD_EXP|NONFED_SHARE_EXP|CVG_END_DT
    for line in unzip_one(raw).splitlines():
        f = line.split("|")
        if len(f) < 27 or num(f[5]) < 100_000:
            continue
        cvg = f[26]
        out.append({"id": f[0], "name": f[1], "type": f[2], "dsgn": f[3], "receipts": num(f[5]), "indiv": num(f[7]), "disb": num(f[12]),
                    "cash": num(f[19]), "debts": num(f[20]), "contrib": num(f[22]), "ie": num(f[23]), "coord": num(f[24]),
                    "cvg": f"{cvg[6:10]}-{cvg[0:2]}-{cvg[3:5]}" if len(cvg) == 10 else None})
    return out


def api(path, **params):
    params["api_key"] = API_KEY
    for attempt in range(3):
        r = subprocess.run(["curl", "-s", "--max-time", "60", f"{API}{path}?{urllib.parse.urlencode(params)}"], capture_output=True, text=True)
        try:
            d = json.loads(r.stdout)
        except json.JSONDecodeError:
            d = {}
        if "results" in d:
            return d["results"]
        time.sleep(2 * (attempt + 1))  # rate limited or busy
    return None


def same_candidate(fec, market):
    words = lambda s: [w for w in "".join(ch if ch.isalpha() or ch in " ,-" else " " for ch in s.lower()).replace(",", " ").replace("-", " ").split() if w]
    m = [w for w in words(market) if w not in ("jr", "sr", "ii", "iii", "iv")]
    if not m:
        return False
    surname = "".join(words(fec.split(",")[0]))
    if surname == m[-1] or surname.endswith(m[-1]):
        return True
    allw = set(words(fec))
    return len(m) > 1 and m[-1] in allw and m[0] in allw


def focus_candidates(cands, cycle):
    """FEC ids of the candidates the markets name in Senate races and competitive House races (the leader under 85%)."""
    path = os.path.join(OUT, "cycles", f"{cycle}.json")
    if not os.path.exists(path):
        return []
    seats = {}
    for c in cands:
        seats.setdefault((c["office"], c["state"], c["district"]), []).append(c)
    ids = []
    for r in json.load(open(path)).get("races", []):
        if r.get("kind") not in ("senate", "house"):
            continue
        office = "S" if r["kind"] == "senate" else "H"
        dist = None if office == "S" else (r["dist"].zfill(2) if (r.get("dist") or "").isdigit() else "00")
        if office == "H" and max(r.get("D") or 0, r.get("R") or 0) >= 0.85:
            continue
        names = {o["n"] for s in ("k", "p") for o in ((r.get(s) or {}).get("o") or []) if o.get("pa") in ("D", "R")}
        field = seats.get((office, r["st"], dist), [])
        for n in names:
            hit = sorted([c for c in field if same_candidate(c["name"], n)], key=lambda c: -c["receipts"])
            if hit:
                ids.append(hit[0]["cand_id"])
    return sorted(set(ids))


def detail_rows(ids, cycle, today):
    """OpenFEC for a third of the focus candidates each day: small vs. large donors, money by state, and each report."""
    out = []
    for cid in [i for i in ids if int(hashlib.md5(i.encode()).hexdigest(), 16) % ROTATE == today % ROTATE]:
        tot = api(f"/candidate/{cid}/totals/", cycle=cycle, election_full="true")
        t = (tot or [{}])[0] if tot is not None else None
        states = api("/schedules/schedule_a/by_state/by_candidate/", candidate_id=cid, cycle=cycle, election_full="true", per_page=100)
        cm = api(f"/candidate/{cid}/committees/", cycle=cycle, designation="P")
        reports = api(f"/committee/{cm[0]['committee_id']}/reports/", cycle=cycle, per_page=60, sort="coverage_end_date") if cm else []
        if t is None and states is None:
            continue
        out.append({
            "cand_id": cid, "cycle": cycle,
            "small": num((t or {}).get("individual_unitemized_contributions")), "large": num((t or {}).get("individual_itemized_contributions")),
            "pac": num((t or {}).get("other_political_committee_contributions")), "party": num((t or {}).get("political_party_committee_contributions")),
            "self": num((t or {}).get("candidate_contribution")) + num((t or {}).get("loans_made_by_candidate")),
            "by_state": json.dumps({s["state"]: round(num(s["total"])) for s in (states or []) if s.get("state")}, separators=(",", ":")),
            "reports": json.dumps([[r["coverage_end_date"][:10], round(num(r.get("total_receipts_period"))), round(num(r.get("total_disbursements_period"))), round(num(r.get("cash_on_hand_end_period")))]
                                   for r in sorted(reports or [], key=lambda r: r.get("coverage_end_date") or "") if r.get("coverage_end_date")], separators=(",", ":")),
        })
    return out


def main():
    if "--force" not in sys.argv and not (NOW.hour == 7 and NOW.minute < 10):
        print("fec: skipped (runs once a day, 07:00 UTC)")
        return
    now = int(NOW.timestamp())
    lines = []
    for cycle in CYCLES:
        try:
            cands = cycle_rows(cycle)
        except Exception as e:
            print(f"fec {cycle}: candidates failed ({e})")
            continue
        lines.append(f"DELETE FROM fec_candidates WHERE cycle = {cycle};")
        for r in cands:
            lines.append("INSERT INTO fec_candidates (cand_id,cycle,name,party,office,state,district,ici,receipts,disbursements,cash,debts,"
                         "indiv,pac,party_contrib,self_funding,coverage_end,updated) VALUES ("
                         + ",".join([q(r["cand_id"]), str(cycle), q(r["name"]), q(r["party"]), q(r["office"]), q(r["state"]), q(r["district"]),
                                     q(r["ici"]), str(r["receipts"]), str(r["disbursements"]), str(r["cash"]), str(r["debts"]), str(r["indiv"]),
                                     str(r["pac"]), str(r["party_contrib"]), str(r["self"]), q(r["coverage_end"]), str(now)]) + ");")
        n_out = 0
        try:
            outs = outside_rows(cycle, {c["cand_id"] for c in cands if c["receipts"] >= 5000})
            lines.append(f"DELETE FROM fec_outside WHERE cycle = {cycle};")
            for r in outs:
                lines.append("INSERT INTO fec_outside (cand_id,cycle,support,oppose,n,top_spenders,updated) VALUES ("
                             + ",".join([q(r["cand_id"]), str(cycle), str(r["support"]), str(r["oppose"]), str(r["n"]), q(r["top"]), str(now)]) + ");")
            n_out = len(outs)
        except Exception as e:
            print(f"fec {cycle}: outside spending failed ({e})")
        spenders, weeks = getattr(outside_rows, "spenders", {}), getattr(outside_rows, "weeks", {})
        if spenders:
            lines.append(f"DELETE FROM fec_spenders WHERE cycle = {cycle};")
            for sid, sp in spenders.items():
                if sp["D"] + sp["R"] + sp["other"] < 10_000:
                    continue
                top = "|".join(c for c, _ in sorted(sp["cands"].items(), key=lambda kv: -kv[1])[:5])
                lines.append("INSERT INTO fec_spenders (spe_id,cycle,name,helps_d,helps_r,other,n,top_cands,updated) VALUES ("
                             + ",".join([q(sid), str(cycle), q(sp["name"]), str(round(sp["D"], 2)), str(round(sp["R"], 2)), str(round(sp["other"], 2)), str(sp["n"]), q(top), str(now)]) + ");")
            lines.append(f"DELETE FROM fec_ie_weeks WHERE cycle = {cycle};")
            for wk, w in sorted(weeks.items()):
                lines.append(f"INSERT INTO fec_ie_weeks (cycle,week,helps_d,helps_r) VALUES ({cycle},{q(wk)},{round(w['D'], 2)},{round(w['R'], 2)});")
        try:
            cmtes = committee_rows(cycle)
            lines.append(f"DELETE FROM fec_committees WHERE cycle = {cycle};")
            for c in cmtes:
                lines.append("INSERT INTO fec_committees (cmte_id,cycle,name,type,dsgn,receipts,indiv,disbursements,cash,debts,contrib_to_others,indep_exp,coord_exp,coverage_end,updated) VALUES ("
                             + ",".join([q(c["id"]), str(cycle), q(c["name"]), q(c["type"]), q(c["dsgn"]), str(c["receipts"]), str(c["indiv"]), str(c["disb"]), str(c["cash"]),
                                         str(c["debts"]), str(c["contrib"]), str(c["ie"]), str(c["coord"]), q(c["cvg"]), str(now)]) + ");")
        except Exception as e:
            cmtes = []
            print(f"fec {cycle}: committees failed ({e})")
        n_detail = 0
        if API_KEY:
            for d in detail_rows(focus_candidates(cands, cycle), cycle, now // 86400):
                lines.append("INSERT OR REPLACE INTO fec_detail (cand_id,cycle,small,large,pac,party,self_funding,by_state,reports,updated) VALUES ("
                             + ",".join([q(d["cand_id"]), str(cycle), str(d["small"]), str(d["large"]), str(d["pac"]), str(d["party"]), str(d["self"]), q(d["by_state"]), q(d["reports"]), str(now)]) + ");")
                n_detail += 1
        print(f"fec {cycle}: {len(cands)} House and Senate candidates, outside spending on {n_out}, {len(spenders)} outside spenders, "
              f"{len(cmtes)} committees, OpenFEC detail for {n_detail}{'' if API_KEY else ' (no FEC_API_KEY)'}")
    open(os.path.join(OUT, "fec.sql"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
