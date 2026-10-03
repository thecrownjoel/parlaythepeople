# Parlay the People

Kalshi and Polymarket odds for every U.S. presidential, Senate, House and governor race, side by side, with price history. Built on [EmDash](https://github.com/emdash-cms/emdash) (Astro on Cloudflare Workers) so the site also has a full blog/CMS at `/_emdash/admin`.

## How it fits together

| Piece | Where | What it does |
|---|---|---|
| Collector | `ingest/ingest.py` (GitHub Actions, every 10 min) | Pulls every open U.S. election market from both exchanges, files it by year/office/place, flags unrecognised markets in `unmatched.json` |
| Publisher | `ingest/publish.sh` | Uploads cycle files to R2 (`ballottape-data`) and upserts races + price history into D1 (`ballottape-markets`) |
| Site | `src/` (Cloudflare Worker `parlaythepeople`) | EmDash blog + data pages: `/[year]/`, `/[year]/president/`, `/[year]/[office]/[place]/`, `/api/v1/…`, `/llms.txt` |

New election cycles need no code: the collector reads each market's election year and the site builds pages for whatever cycles exist. To follow a new kind of market, add a rule in `ingest/ingest.py` (see `classify_kalshi` / `P_PATTERNS`) and check `unmatched.json` for what isn't covered yet.

## Commands

```bash
python3 ingest/ingest.py && ./ingest/publish.sh   # refresh data by hand
npx pnpm build && npx wrangler deploy            # deploy the site
```
