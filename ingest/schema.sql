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

-- Money traded per race over time (cumulative and 24h, per exchange), written when it changes.
-- Kalshi volume is in contracts ($1 each at settlement); Polymarket volume is in dollars.
CREATE TABLE IF NOT EXISTS volume_history (
  race_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  k_v REAL, p_v REAL,           -- cumulative volume
  k_v24 REAL, p_v24 REAL,       -- trailing 24-hour volume
  k_oi REAL, p_liq REAL,        -- Kalshi open interest, Polymarket liquidity
  PRIMARY KEY (race_id, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS volume_history_ts ON volume_history (ts);

-- Every headline the news strip has carried.
CREATE TABLE IF NOT EXISTS news (
  url TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT, tag TEXT,
  published INTEGER,            -- unix seconds (publisher time)
  first_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS news_published ON news (published);

-- Top social posts about each candidate/topic (LunarCrush), refreshed as their interactions grow.
CREATE TABLE IF NOT EXISTS social_posts (
  url TEXT NOT NULL,
  topic TEXT NOT NULL,
  title TEXT, author TEXT, network TEXT,
  interactions INTEGER, sentiment REAL,
  posted_at INTEGER, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (url, topic)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS social_posts_topic ON social_posts (topic, posted_at);

-- Hourly LunarCrush readings per topic (social_history keeps the daily series).
CREATE TABLE IF NOT EXISTS social_hourly (
  topic TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- hour, unix seconds
  i24 INTEGER, contributors INTEGER, posts24 INTEGER, sentiment REAL, trend TEXT,
  PRIMARY KEY (topic, ts)
) WITHOUT ROWID;

-- The Parlay estimate for each race, logged hourly so it can be scored after the election.
-- market_d = the markets' two-party Democratic share; model_d = the model's probability the Democrat wins.
CREATE TABLE IF NOT EXISTS forecasts (
  race_id TEXT NOT NULL,
  ts INTEGER NOT NULL,          -- hour, unix seconds
  market_d REAL, model_d REAL,
  version TEXT,                 -- model version (see ingest/model/coef.json)
  PRIMARY KEY (race_id, ts)
) WITHOUT ROWID;

-- AI analyst usage per visitor per day (hashed IP), for the free daily limit; and every question asked.
CREATE TABLE IF NOT EXISTS ai_usage (
  who TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (who, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ai_log (
  ts INTEGER NOT NULL, who TEXT, question TEXT, tools TEXT, ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, ok INTEGER
);
CREATE INDEX IF NOT EXISTS ai_log_ts ON ai_log (ts);

-- Which exchange contracts belong to which race and party (kept so races can be resolved after their
-- markets close and drop out of the live data), and each race's result once the exchanges settle it.
CREATE TABLE IF NOT EXISTS race_contracts (
  race_id TEXT NOT NULL, src TEXT NOT NULL, market TEXT NOT NULL, party TEXT, name TEXT,
  PRIMARY KEY (race_id, src, market)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS race_results (
  race_id TEXT PRIMARY KEY,
  winner TEXT NOT NULL,          -- D | R | I
  decided_at INTEGER NOT NULL,   -- when we saw it settle (unix seconds)
  source TEXT                    -- k, p or kp (both agreed)
);

-- Public polls per race, read from Wikipedia's 2026 election pages by ingest/polls.py (text CC BY-SA 4.0;
-- each poll cites its pollster's release there). The site computes its own average (src/lib/polls.ts).
CREATE TABLE IF NOT EXISTS polls (
  race_id TEXT NOT NULL,
  pollster TEXT NOT NULL,       -- as listed, with sponsor's party when partisan, e.g. "Trafalgar Group (R)"
  partisan TEXT,                -- D | R | null
  start_date TEXT, end_date TEXT NOT NULL,   -- ISO dates of fieldwork
  sample INTEGER, pop TEXT,     -- respondents; LV likely voters | RV registered | A adults
  d REAL, r REAL, other REAL, undecided REAL,  -- shares 0-1
  d_name TEXT, r_name TEXT,     -- the two candidates the poll tested
  source TEXT,                  -- Wikipedia page the row came from
  seen INTEGER,                 -- last collected (unix seconds)
  PRIMARY KEY (race_id, pollster, end_date, pop)
);
CREATE INDEX IF NOT EXISTS polls_race_end ON polls (race_id, end_date);

-- Every other politics market (ingest/politics.py): one price per event per hour (kept forever),
-- and when each event first appeared on either exchange (new listings).
CREATE TABLE IF NOT EXISTS politics_history (
  event_id TEXT NOT NULL,       -- k:<Kalshi event ticker> | p:<Polymarket event id>
  ts INTEGER NOT NULL,          -- unix seconds, on the hour
  p REAL,                       -- the leading outcome's price, 0-1
  PRIMARY KEY (event_id, ts)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS politics_first_seen (
  event_id TEXT PRIMARY KEY,
  title TEXT, topic TEXT, src TEXT,
  first_seen INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS politics_first_seen_ts ON politics_first_seen (first_seen);

-- Campaign finance from the FEC's bulk files (ingest/fec.py, daily): every House and Senate candidate running this cycle,
-- with totals through their latest report, and outside spending for or against them. Replaced each day.
CREATE TABLE IF NOT EXISTS fec_candidates (
  cand_id TEXT NOT NULL, cycle INTEGER NOT NULL,
  name TEXT, party TEXT, office TEXT, state TEXT, district TEXT, ici TEXT,  -- ici: I incumbent, C challenger, O open seat
  receipts REAL, disbursements REAL, cash REAL, debts REAL,
  indiv REAL, pac REAL, party_contrib REAL, self_funding REAL,             -- where the money came from
  coverage_end TEXT, updated INTEGER,
  PRIMARY KEY (cand_id, cycle)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fec_candidates_seat ON fec_candidates (cycle, office, state, district);
CREATE TABLE IF NOT EXISTS fec_outside (
  cand_id TEXT NOT NULL, cycle INTEGER NOT NULL,
  support REAL, oppose REAL, n INTEGER,
  top_spenders TEXT,            -- up to 5: "name~support~oppose|…"
  updated INTEGER,
  PRIMARY KEY (cand_id, cycle)
) WITHOUT ROWID;
-- Outside spenders (super PACs, parties, groups) by whom their spending helped, from independent expenditures.
CREATE TABLE IF NOT EXISTS fec_spenders (
  spe_id TEXT NOT NULL, cycle INTEGER NOT NULL, name TEXT,
  helps_d REAL, helps_r REAL, other REAL, n INTEGER,   -- helps_*: general-election spending; other: primaries and unaffiliated
  top_cands TEXT,               -- up to 5 FEC candidate ids they spent the most on, "|"-separated
  updated INTEGER,
  PRIMARY KEY (spe_id, cycle)
) WITHOUT ROWID;
-- Outside spending by week (Monday), by the party it helped.
CREATE TABLE IF NOT EXISTS fec_ie_weeks (
  cycle INTEGER NOT NULL, week TEXT NOT NULL, helps_d REAL, helps_r REAL,
  PRIMARY KEY (cycle, week)
) WITHOUT ROWID;
-- Every committee that raised $100K+ this cycle: party committees, super PACs, PACs (FEC committee summary file).
CREATE TABLE IF NOT EXISTS fec_committees (
  cmte_id TEXT NOT NULL, cycle INTEGER NOT NULL, name TEXT,
  type TEXT,                    -- X/Y party, O super PAC, U single-candidate IE, V/W hybrid PAC, N/Q PAC, I independent expenditor
  dsgn TEXT, receipts REAL, indiv REAL, disbursements REAL, cash REAL, debts REAL,
  contrib_to_others REAL, indep_exp REAL, coord_exp REAL, coverage_end TEXT, updated INTEGER,
  PRIMARY KEY (cmte_id, cycle)
) WITHOUT ROWID;
-- OpenFEC detail for the candidates in competitive races (refreshed every few days): donors by size, money by state, each report.
CREATE TABLE IF NOT EXISTS fec_detail (
  cand_id TEXT NOT NULL, cycle INTEGER NOT NULL,
  small REAL, large REAL, pac REAL, party REAL, self_funding REAL,
  by_state TEXT,                -- {"ME": dollars, …}
  reports TEXT,                 -- [[coverage end date, raised in period, spent in period, cash on hand], …]
  updated INTEGER,
  PRIMARY KEY (cand_id, cycle)
) WITHOUT ROWID;
