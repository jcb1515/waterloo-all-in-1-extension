-- Per-IP feed-create quota. `key` is a salted SHA-256 of the client IP
-- scoped to the UTC day (`sha256(ip|YYYY-MM-DD|RATE_SALT)` truncated to 32
-- hex chars) — raw IPs are never stored. The daily cron deletes rows whose
-- day has passed.
CREATE TABLE IF NOT EXISTS create_limits (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  count INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_create_limits_day ON create_limits (day);
