-- Run once on parlay-accounts: reader discussions on race, candidate and other data pages (src/lib/comments.ts).
-- Public display names for readers (comments show a name, never an email).
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  page TEXT NOT NULL,               -- the page path, e.g. /2026/senate/maine/
  user_id TEXT NOT NULL,
  parent TEXT,                      -- a reply's parent comment id
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',  -- visible | held (flagged by the safety check) | hidden (removed by a moderator or its author)
  reason TEXT                       -- why it was held or hidden
);
CREATE INDEX IF NOT EXISTS comments_page ON comments (page, status, ts);
CREATE INDEX IF NOT EXISTS comments_user ON comments (user_id, ts);
CREATE TABLE IF NOT EXISTS comment_reports (
  comment_id TEXT NOT NULL,
  reporter TEXT NOT NULL,           -- user id, or hashed IP for readers not signed in
  ts INTEGER NOT NULL,
  PRIMARY KEY (comment_id, reporter)
) WITHOUT ROWID;
