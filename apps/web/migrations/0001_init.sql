-- Flagged content. `h` is sha256("noai-flag:v1:" + platform + ":" + id); the content key
-- itself is never sent to the server.
CREATE TABLE IF NOT EXISTS items (
  h TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  platform TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS items_prefix ON items (prefix);

-- One row per (item, voter). `voter` is an HMAC of the client's random install id.
CREATE TABLE IF NOT EXISTS votes (
  h TEXT NOT NULL,
  voter TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (h, voter)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS votes_voter ON votes (voter, created_at);

-- Anonymous daily download counts.
CREATE TABLE IF NOT EXISTS downloads (
  day TEXT NOT NULL,
  arch TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, arch)
) WITHOUT ROWID;
