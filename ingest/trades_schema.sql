-- Every trade on the election contracts we follow (D1 database ballottape-trades, binding TRADES). Safe to re-run.
CREATE TABLE IF NOT EXISTS trades (
  src TEXT NOT NULL,            -- k (Kalshi) | p (Polymarket)
  id TEXT NOT NULL,             -- exchange trade id (Polymarket: tx hash + asset + fill)
  market TEXT NOT NULL,         -- Kalshi ticker | Polymarket condition id
  race_id TEXT,                 -- race or market group (e.g. 2026-senate-maine, 2028-pres-winner)
  outcome TEXT,                 -- candidate / outcome name
  ts INTEGER NOT NULL,          -- unix seconds
  side TEXT,                    -- Kalshi taker side yes|no; Polymarket BUY|SELL
  yes_price REAL,               -- price of the Yes side, 0-1
  size REAL,                    -- contracts (Kalshi) / shares (Polymarket)
  usd REAL,                     -- dollars that changed hands
  wallet TEXT,                  -- Polymarket proxy wallet (public on-chain)
  PRIMARY KEY (src, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trades_market_ts ON trades (market, ts);
CREATE INDEX IF NOT EXISTS trades_race_ts ON trades (race_id, ts);
CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts);

-- Where trade collection left off for each contract: last trade time seen and the volume then.
CREATE TABLE IF NOT EXISTS trade_cursor (
  src TEXT NOT NULL,
  market TEXT NOT NULL,
  last_ts INTEGER,
  last_v REAL,
  PRIMARY KEY (src, market)
) WITHOUT ROWID;
