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


def outside_rows(cycle):
    raw = fetch(f"{BULK}/{cycle}/independent_expenditure_{cycle}.csv")
    keep(f"independent_expenditure_{cycle}.csv", raw)
    latest = {}  # (spender, transaction) -> row from the newest filing, so amendments replace what they amend
    for r in csv.DictReader(io.StringIO(raw.decode("latin-1"))):
        if not r.get("cand_id") or r.get("sup_opp") not in ("S", "O"):
            continue
        k = (r.get("spe_id"), r.get("tran_id"))
        if k not in latest or num(r.get("file_num")) >= num(latest[k].get("file_num")):
            latest[k] = r
    by = {}
    for r in latest.values():
        c = by.setdefault(r["cand_id"], {"support": 0.0, "oppose": 0.0, "n": 0, "spenders": {}})
        amt = num(r.get("exp_amo"))
        c["support" if r["sup_opp"] == "S" else "oppose"] += amt
        c["n"] += 1
        s = c["spenders"].setdefault(r.get("spe_nam") or "Unknown", [0.0, 0.0])
        s[0 if r["sup_opp"] == "S" else 1] += amt
    out = []
    for cid, c in by.items():
        top = sorted(c["spenders"].items(), key=lambda kv: -(kv[1][0] + kv[1][1]))[:5]
        out.append({"cand_id": cid, "cycle": cycle, "support": round(c["support"], 2), "oppose": round(c["oppose"], 2), "n": c["n"],
                    "top": "|".join(f"{n.replace('|', ' ')}~{round(s)}~{round(o)}" for n, (s, o) in top)})
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
            outs = outside_rows(cycle)
            lines.append(f"DELETE FROM fec_outside WHERE cycle = {cycle};")
            for r in outs:
                lines.append("INSERT INTO fec_outside (cand_id,cycle,support,oppose,n,top_spenders,updated) VALUES ("
                             + ",".join([q(r["cand_id"]), str(cycle), str(r["support"]), str(r["oppose"]), str(r["n"]), q(r["top"]), str(now)]) + ");")
            n_out = len(outs)
        except Exception as e:
            print(f"fec {cycle}: outside spending failed ({e})")
        print(f"fec {cycle}: {len(cands)} House and Senate candidates, outside spending on {n_out}")
    open(os.path.join(OUT, "fec.sql"), "w").write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
