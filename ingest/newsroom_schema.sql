-- The Parlay Newsroom (docs/newsroom-architecture.md), on parlay-accounts (binding ACCOUNTS):
--   npx wrangler d1 execute parlay-accounts --remote --file ingest/newsroom_schema.sql

-- One row per writer on staff, AI or human. The byline (name, slug, bio, photo) lives in EmDash; this holds the rest.
CREATE TABLE IF NOT EXISTS newsroom_writers (
  id TEXT PRIMARY KEY,
  byline_id TEXT,                   -- EmDash byline
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'ai',  -- ai | human
  age INTEGER,
  bio TEXT,
  photo_media_id TEXT,              -- EmDash media id of the portrait
  beats TEXT NOT NULL DEFAULT '[]',       -- json: ["senate", "money", ...]
  geography TEXT NOT NULL DEFAULT '[]',   -- json: ["US"] or state codes ["OH", "MI"]; a city goes in `places`
  places TEXT NOT NULL DEFAULT '[]',      -- json: ["Cleveland"]: extra local news searches
  perspective INTEGER NOT NULL DEFAULT 0, -- -2 strong D … 0 neutral … 2 strong R
  formats TEXT NOT NULL DEFAULT '["brief"]',
  cadence TEXT NOT NULL DEFAULT '{}',     -- json: {per_week, daily_cap, days: [0-6], hours: [start, end] Eastern, breaking}
  triggers TEXT NOT NULL DEFAULT '{}',    -- json: {move_pts, outside_usd, money_usd, poll_gap_pts}
  voice TEXT,                       -- style instructions
  samples TEXT,                     -- 2-3 sample paragraphs in the writer's voice
  sources TEXT NOT NULL DEFAULT '{}',     -- json: {feeds: [...rss urls], block: [...domains]}
  approval TEXT NOT NULL DEFAULT 'drafts', -- drafts | auto (auto: formats listed in auto_formats publish on their own)
  auto_formats TEXT NOT NULL DEFAULT '[]',
  budget_cents INTEGER NOT NULL DEFAULT 1000, -- monthly AI cap
  active INTEGER NOT NULL DEFAULT 1,
  vacation_until INTEGER,           -- unix seconds
  tips INTEGER NOT NULL DEFAULT 0,  -- human writers: email story tips from their beat
  email TEXT,                       -- human writers: where tips go
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

-- Candidate stories, collected hourly from our own data and the news.
CREATE TABLE IF NOT EXISTS newsroom_signals (
  id TEXT PRIMARY KEY,              -- stable per story, e.g. move:2026-senate-maine:20367
  kind TEXT NOT NULL,               -- move | flip | money | whale | outside | poll | news | calendar | tip
  key TEXT,                         -- race id, candidate or topic
  title TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',  -- json
  score REAL NOT NULL DEFAULT 0,    -- 0-100
  geography TEXT,                   -- state code or US
  beats TEXT NOT NULL DEFAULT '[]',
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS newsroom_signals_seen ON newsroom_signals (seen_at);

-- A story given to a writer, and where it is in the pipeline.
CREATE TABLE IF NOT EXISTS newsroom_assignments (
  id TEXT PRIMARY KEY,
  writer_id TEXT NOT NULL,
  signal_id TEXT,
  format TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | researching | writing | checking | ready | published | dropped | killed
  pair_id TEXT,                     -- debate pairs share one
  workflow_id TEXT,
  reason TEXT,                      -- why it was dropped or killed, or the editor's note
  note TEXT,                        -- the editor's brief for a manual assignment
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS newsroom_assignments_writer ON newsroom_assignments (writer_id, created);
CREATE INDEX IF NOT EXISTS newsroom_assignments_status ON newsroom_assignments (status, updated);

-- What each story was written from, the check, and what it cost.
CREATE TABLE IF NOT EXISTS newsroom_drafts (
  assignment_id TEXT PRIMARY KEY,
  post_id TEXT,                     -- EmDash post id
  post_slug TEXT,
  headline TEXT,
  dek TEXT,
  body TEXT,                        -- markdown, as written
  label TEXT,                       -- news | perspective
  source_log TEXT,                  -- json: [{id, claim, value, source, url}]
  check_report TEXT,                -- json: {verdict, claims: [...], notes}
  cost_usd REAL NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

-- Reading lists: default feeds by state and beat (writer_id null) or a writer's own.
CREATE TABLE IF NOT EXISTS newsroom_sources (
  id TEXT PRIMARY KEY,
  writer_id TEXT,
  kind TEXT NOT NULL,               -- rss | gnews | gdelt | block
  url_or_query TEXT NOT NULL,
  geography TEXT,
  beat TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS newsroom_corrections (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  note TEXT NOT NULL,
  by TEXT,
  ts INTEGER NOT NULL
);

-- Every model call the newsroom makes, for budgets.
CREATE TABLE IF NOT EXISTS newsroom_costs (
  writer_id TEXT NOT NULL,
  assignment_id TEXT,
  step TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  tokens INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS newsroom_costs_writer ON newsroom_costs (writer_id, ts);

-- Global settings (one row per key, json values).
CREATE TABLE IF NOT EXISTS newsroom_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
