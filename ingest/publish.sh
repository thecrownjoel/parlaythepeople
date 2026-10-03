#!/usr/bin/env bash
# Uploads the collector's output to Cloudflare: cycle files to R2, races + history to D1.
set -euo pipefail
cd "$(dirname "$0")/.."
WR="npx --yes wrangler@4"
for f in ingest/out/cycles/*.json; do
  $WR r2 object put "ballottape-data/cycles/$(basename "$f")" --file "$f" --content-type application/json --remote >/dev/null
done
$WR r2 object put ballottape-data/index.json --file ingest/out/index.json --content-type application/json --remote >/dev/null
[ -f ingest/out/social.json ] && $WR r2 object put ballottape-data/social.json --file ingest/out/social.json --content-type application/json --remote >/dev/null
[ -s ingest/out/social.sql ] && $WR d1 execute ballottape-markets --remote --file ingest/out/social.sql >/dev/null && rm ingest/out/social.sql
[ -f ingest/out/kalshi_trades.json ] && $WR r2 object put ballottape-data/kalshi_trades.json --file ingest/out/kalshi_trades.json --content-type application/json --remote >/dev/null
[ -f ingest/out/news.json ] && $WR r2 object put ballottape-data/news.json --file ingest/out/news.json --content-type application/json --remote >/dev/null
$WR r2 object put ballottape-data/unmatched.json --file ingest/out/unmatched.json --content-type application/json --remote >/dev/null
$WR d1 execute ballottape-markets --remote --file ingest/schema.sql >/dev/null
$WR d1 execute ballottape-markets --remote --file ingest/out/d1.sql >/dev/null
# The permanent record (archive.py): money-traded history, headlines and social posts; every trade;
# a full snapshot of every contract each run and the raw exchange pulls hourly. A failure here
# never blocks the site update above.
[ -s ingest/out/archive.sql ] && { $WR d1 execute ballottape-markets --remote --file ingest/out/archive.sql >/dev/null || echo "archive history upload failed"; }
$WR d1 execute ballottape-trades --remote --file ingest/trades_schema.sql >/dev/null || echo "trades schema failed"
[ -s ingest/out/trades.sql ] && { $WR d1 execute ballottape-trades --remote --file ingest/out/trades.sql >/dev/null || echo "trades upload failed"; }
STAMP=$(date -u +%Y/%m/%d/%H%M)
for f in ingest/out/archive/*.json.gz; do
  [ -f "$f" ] || continue
  name=$(basename "$f" .json.gz)
  case "$name" in snap) key="archive/snap/$STAMP.json.gz" ;; *) key="archive/raw/$STAMP-${name#raw-}.json.gz" ;; esac
  $WR r2 object put "ballottape-data/$key" --file "$f" --content-type application/gzip --remote >/dev/null || echo "archive upload failed: $key"
done
echo "published $(ls ingest/out/cycles | wc -l | tr -d ' ') cycles"
