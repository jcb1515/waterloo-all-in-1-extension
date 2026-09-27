CREATE TABLE IF NOT EXISTS calendar_feed_aliases (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL,
  feed_group TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feed_aliases_feed_group
ON calendar_feed_aliases (feed_id, feed_group);
