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
-- lets the hourly retention pass touch only the slice of history crossing a boundary
CREATE INDEX IF NOT EXISTS race_history_ts ON race_history (ts);

-- Price history for non-race markets: presidential candidates and nominees, balance of power,
-- seat-count and popular-vote bins (plus derived majority odds) and ballot measures.
-- group_id like 2028-pres-winner, 2026-bop, 2026-senate-seats, 2026-majority, 2026-ballots.
CREATE TABLE IF NOT EXISTS outcome_history (
  group_id TEXT NOT NULL,
  outcome TEXT NOT NULL,        -- candidate name key, DD/DR/RD/RR, "k:<bin>"/"p:<bin>", senate-R, "ST: measure"
  ts INTEGER NOT NULL,
  k REAL, p REAL,               -- Kalshi / Polymarket value (share of the market, or pass odds for ballots)
  PRIMARY KEY (group_id, outcome, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS outcome_history_ts ON outcome_history (ts);

-- LunarCrush social pulse, one row per topic per day (topic = lowercase name, e.g. "susan collins")
CREATE TABLE IF NOT EXISTS social_history (
  topic TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- day start, unix seconds
  interactions INTEGER,
  sentiment REAL,               -- % of posts that are positive
  PRIMARY KEY (topic, ts)
) WITHOUT ROWID;
