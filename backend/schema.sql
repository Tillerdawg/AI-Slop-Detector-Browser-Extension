-- D1 schema for the future community-ratings layer.
-- Apply with: wrangler d1 execute ai-slop-detector --file=schema.sql

CREATE TABLE IF NOT EXISTS votes (
  video_id     TEXT NOT NULL,
  channel_id   TEXT,
  vote         TEXT NOT NULL CHECK (vote IN ('ai', 'human')),
  client_id    TEXT NOT NULL,          -- random UUID generated client-side, not tied to any identity
  created_at   INTEGER NOT NULL,       -- unix ms
  PRIMARY KEY (video_id, client_id)    -- one vote per (video, anonymous client)
);

CREATE INDEX IF NOT EXISTS idx_votes_video ON votes (video_id);
CREATE INDEX IF NOT EXISTS idx_votes_channel ON votes (channel_id);

-- Lightweight per-IP-hash rate limiting to blunt naive vote-stuffing.
-- Store only a salted hash of the IP, never the raw address.
CREATE TABLE IF NOT EXISTS rate_limit (
  ip_hash      TEXT NOT NULL,
  window_start INTEGER NOT NULL,   -- unix ms, floored to the rate-limit window
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_hash, window_start)
);
