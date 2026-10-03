#!/usr/bin/env bash
# Uploads the collector's output to Cloudflare: cycle files to R2, races + history to D1.
set -euo pipefail
cd "$(dirname "$0")/.."
WR="npx --yes wrangler@4"
for f in ingest/out/cycles/*.json; do
  $WR r2 object put "ballottape-data/cycles/$(basename "$f")" --file "$f" --content-type application/json --remote >/dev/null
done
$WR r2 object put ballottape-data/index.json --file ingest/out/index.json --content-type application/json --remote >/dev/null
[ -f ingest/out/news.json ] && $WR r2 object put ballottape-data/news.json --file ingest/out/news.json --content-type application/json --remote >/dev/null
$WR r2 object put ballottape-data/unmatched.json --file ingest/out/unmatched.json --content-type application/json --remote >/dev/null
$WR d1 execute ballottape-markets --remote --file ingest/schema.sql >/dev/null
$WR d1 execute ballottape-markets --remote --file ingest/out/d1.sql >/dev/null
echo "published $(ls ingest/out/cycles | wc -l | tr -d ' ') cycles"
