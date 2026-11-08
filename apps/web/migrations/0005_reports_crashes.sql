-- "Report this site" from the shield and ad blocker panels: the page address and the choice,
-- with the app and version for triage. Kept until triaged, at most 90 days.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  feature TEXT NOT NULL,
  problem TEXT NOT NULL,
  app TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_status ON reports (status, created_at);
CREATE INDEX IF NOT EXISTS reports_host ON reports (host, status);

-- Opt-in crash reports; the report itself is in R2 under `key`. Kept 90 days.
CREATE TABLE IF NOT EXISTS crashes (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  app TEXT NOT NULL,
  version TEXT NOT NULL,
  process TEXT NOT NULL,
  size INTEGER NOT NULL,
  key TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS crashes_time ON crashes (created_at);
