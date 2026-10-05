-- Reader accounts, plans and AI usage (D1 database parlay-accounts, binding ACCOUNTS). Safe to re-run.
-- Kept apart from the market data: this is the only database holding personal information (email addresses).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- random id
  email TEXT NOT NULL UNIQUE,       -- lowercased
  created INTEGER NOT NULL,         -- unix seconds
  last_seen INTEGER,
  org_id TEXT                       -- Team / Organization the user belongs to (its plan applies), or null
);

-- One-time sign-in links. Only a hash of the token is stored; links expire after 15 minutes and work once.
CREATE TABLE IF NOT EXISTS login_tokens (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  next TEXT                         -- where to go after signing in
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS login_tokens_email ON login_tokens (email, expires);

-- Signed-in browsers. The cookie holds a random token; only its hash is stored.
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  ua TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- Passkeys (WebAuthn credentials) a user has registered.
CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY,              -- credential id (base64url)
  user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,         -- base64url COSE public key
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,                  -- comma-separated
  name TEXT,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);

-- Short-lived WebAuthn challenges (registration and sign-in ceremonies).
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,              -- random id handed to the browser in a cookie
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires INTEGER NOT NULL
) WITHOUT ROWID;

-- Teams and organizations share one plan and one credit pool.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  seats INTEGER NOT NULL DEFAULT 5,
  created INTEGER NOT NULL
);

-- The plan in force for a user or an org (subject = 'u:<user id>' or 'o:<org id>'). No row = free.
-- Granted by hand until billing is connected; the Stripe columns are filled by the webhook later.
CREATE TABLE IF NOT EXISTS subscriptions (
  subject TEXT PRIMARY KEY,
  plan TEXT NOT NULL,               -- free | pro | team | enterprise (see src/lib/plans.ts)
  status TEXT NOT NULL DEFAULT 'active',   -- active | trialing | past_due | canceled
  period_start INTEGER NOT NULL,    -- current credit period (unix seconds)
  period_end INTEGER NOT NULL,
  extra_credits INTEGER NOT NULL DEFAULT 0,  -- bought or granted on top of the plan, kept until used
  stripe_customer TEXT,
  stripe_subscription TEXT,
  note TEXT,                        -- e.g. "granted by hand: pilot with X campaign"
  updated INTEGER NOT NULL
) WITHOUT ROWID;

-- Every metered AI action: what it cost us (tokens, neurons) and what it cost the user (credits).
CREATE TABLE IF NOT EXISTS usage_events (
  ts INTEGER NOT NULL,
  subject TEXT NOT NULL,            -- who is billed: 'u:<id>' | 'o:<id>' | 'a:<hashed ip>' for anonymous
  user_id TEXT,
  action TEXT NOT NULL,             -- ask | deep | report | briefing
  credits INTEGER NOT NULL,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,                    -- estimated from list prices (src/lib/plans.ts)
  ok INTEGER
);
CREATE INDEX IF NOT EXISTS usage_subject_ts ON usage_events (subject, ts);
CREATE INDEX IF NOT EXISTS usage_ts ON usage_events (ts);

-- Races a signed-in user follows (synced across browsers; the site also keeps them in the browser).
CREATE TABLE IF NOT EXISTS watchlist (
  user_id TEXT NOT NULL,
  race_id TEXT NOT NULL,
  added INTEGER NOT NULL,
  name TEXT,                        -- race name as shown on the follow button (added Oct 2026: ALTER TABLE watchlist ADD COLUMN name TEXT)
  PRIMARY KEY (user_id, race_id)
) WITHOUT ROWID;

-- "Get Pro" requests from the pricing page, until billing is connected (a plan is then granted by hand).
CREATE TABLE IF NOT EXISTS pro_requests (
  ts INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  org TEXT,                         -- campaign / firm / newsroom, as the reader typed it
  note TEXT,
  handled INTEGER NOT NULL DEFAULT 0
);

-- Briefings and alerts for paid plans. One row per user; no row = the defaults below.
CREATE TABLE IF NOT EXISTS alert_prefs (
  user_id TEXT PRIMARY KEY,
  briefing INTEGER NOT NULL DEFAULT 1,     -- daily morning briefing on followed races
  alerts INTEGER NOT NULL DEFAULT 1,       -- move and big-bet alerts on followed races
  move_pts REAL NOT NULL DEFAULT 5,        -- alert when Democratic odds move this many points in 24 hours
  whale_usd REAL NOT NULL DEFAULT 10000,   -- alert on a single trade this large
  updated INTEGER NOT NULL
) WITHOUT ROWID;

-- What each alert email already covered, so nothing is sent twice.
CREATE TABLE IF NOT EXISTS alerts_sent (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,                       -- move:<race>:<day> | whale:<src>:<trade id>
  ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
) WITHOUT ROWID;

-- Every daily briefing written, readable again from the account page.
CREATE TABLE IF NOT EXISTS briefings (
  user_id TEXT NOT NULL,
  day INTEGER NOT NULL,                    -- unix day
  ts INTEGER NOT NULL,
  races INTEGER,
  body TEXT,                               -- markdown
  sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
) WITHOUT ROWID;

-- PDF race reports (files in R2 DATA under reports/<user id>/).
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  race_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  r2_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_user ON reports (user_id, ts);

-- Notes on races, shared by everyone on a team (subject 'o:<org id>') or kept by a solo Pro member ('u:<user id>').
CREATE TABLE IF NOT EXISTS race_notes (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  race_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS race_notes_race ON race_notes (subject, race_id, ts);
CREATE INDEX IF NOT EXISTS race_notes_recent ON race_notes (subject, ts);
