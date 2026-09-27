-- Rendered ICS cache: POST/PUT renders each public feed once and stores it
-- here; GET is a single row read. One row per public feed id (the main feed
-- id plus every group alias id) keeps each value under D1's ~2 MB row limit.
CREATE TABLE IF NOT EXISTS calendar_renders (
  feed_id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL,
  ics TEXT NOT NULL,
  etag TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calendar_renders_calendar_id
ON calendar_renders (calendar_id);
