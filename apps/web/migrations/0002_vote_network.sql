-- One network (IPv4 /24, IPv6 /48) counts once per post, so a single connection cannot stuff
-- votes with made-up install ids. `src` is a 16-bit keyed hash of the network prefix: one of
-- 65,536 buckets, each shared by hundreds of networks, so it does not identify anyone.
ALTER TABLE votes ADD COLUMN src TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS votes_item_src ON votes (h, src);
