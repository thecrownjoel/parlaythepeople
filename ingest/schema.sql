-- Parlay the People market data (D1 binding MARKETS). Safe to re-run.
CREATE TABLE IF NOT EXISTS races (
  id TEXT PRIMARY KEY,          -- e.g. 2026-senate-maine, 2026-house-ca-22, 2028-president
  cycle INTEGER NOT NULL,       -- election year
  kind TEXT NOT NULL,           -- senate | governor | house | control | president
  st TEXT, state TEXT, dist TEXT,
  label TEXT NOT NULL,
  path TEXT NOT NULL,           -- canonical page path on the site
  d REAL, r REAL,               -- consensus Democratic / Republican odds (0-1)
  k_d REAL, p_d REAL,           -- Democratic odds on Kalshi / Polymarket
  lead TEXT,
  vol REAL,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS races_cycle ON races (cycle, kind);

CREATE TABLE IF NOT EXISTS race_history (
  race_id TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- unix seconds
  k_d REAL, k_r REAL, p_d REAL, p_r REAL,
  PRIMARY KEY (race_id, ts)
) WITHOUT ROWID;
