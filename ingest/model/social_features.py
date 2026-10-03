#!/usr/bin/env python3
"""LunarCrush history for the candidates in decided races, to test whether social data improves the model.

For each Senate, House and governor race in out/model/races.json (presidential-state races are skipped:
Trump/Harris buzz is national, not per state), fetches each named candidate's daily interactions and
sentiment for the 120 days before Election Day. Writes out/model/social.json:
{race key: {"D": {day: [interactions, sentiment]}, "R": {...}}}.

Needs LUNARCRUSH_API_KEY (run it in GitHub Actions: .github/workflows/model.yml).
"""
import concurrent.futures as cf
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from social import lc  # noqa: E402  (uses LUNARCRUSH_API_KEY)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "out", "model")
GENERIC = re.compile(r"^(democrat|democrats|democratic|republican|republicans|republican party|democratic party|.*\bparty\b.*|other)$", re.I)


def history(name, t0, t1):
    d = lc(f"/topic/{name.lower()}/time-series/v2", {"bucket": "day", "start": t0, "end": t1}) or {}
    out = {}
    for p in d.get("data") or []:
        ts = p.get("time")
        if ts:
            out[str(int(ts) // 86400)] = [p.get("interactions") or 0, p.get("sentiment")]
    return out


def main():
    races = [r for r in json.load(open(os.path.join(OUT, "races.json"))) if r["office"] != "president"]
    jobs = []
    for r in races:
        ed = int(datetime.datetime.fromisoformat(r["eday"] + "T12:00:00+00:00").timestamp())
        for pa, n in (r.get("names") or {}).items():
            n = re.sub(r"\s+(jr|sr)\.?$", "", (n or "").strip(), flags=re.I)
            if n and not GENERIC.match(n) and len(n.split()) >= 2:
                jobs.append((r["key"], pa, n, ed - 120 * 86400, ed))
    out = {}
    with cf.ThreadPoolExecutor(4) as ex:
        for (key, pa, n, *_), h in zip(jobs, ex.map(lambda j: history(j[2], j[3], j[4]), jobs)):
            if h:
                out.setdefault(key, {})[pa] = h
    both = sum(1 for v in out.values() if "D" in v and "R" in v)
    json.dump(out, open(os.path.join(OUT, "social.json"), "w"), separators=(",", ":"))
    print(f"social history: {len(jobs)} candidates in {len(races)} races; {both} races with both candidates")


if __name__ == "__main__":
    main()
