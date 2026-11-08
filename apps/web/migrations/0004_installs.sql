-- Daily update checks per app and version: a plain counter, no ids. Each install checks at most
-- once per day, so a day's total is roughly that day's active installs.
CREATE TABLE IF NOT EXISTS installs (
  day TEXT NOT NULL,
  app TEXT NOT NULL,
  version TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app, version)
) WITHOUT ROWID;
