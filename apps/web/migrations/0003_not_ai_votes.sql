-- Votes are an AI flag ('ai') or a Not AI dispute ('human'); one vote per install and post.
-- `items.n` counts networks that flagged a post as AI, `items.d` networks that voted Not AI.
ALTER TABLE votes ADD COLUMN kind TEXT NOT NULL DEFAULT 'ai';
ALTER TABLE items ADD COLUMN d INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS votes_item_kind_src ON votes (h, kind, src);

-- Daily totals of votes that added a network to a post (`counted`) and votes from a network that
-- already counted for it (`collapsed`), per app and IP family: shows how often shared networks
-- (carrier NAT, IPv6 /48s on phones) swallow real votes. Aggregates only, no ids.
CREATE TABLE IF NOT EXISTS vote_stats (
  day TEXT NOT NULL,
  app TEXT NOT NULL,
  family TEXT NOT NULL,
  counted INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app, family)
) WITHOUT ROWID;
