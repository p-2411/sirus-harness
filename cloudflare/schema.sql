CREATE TABLE IF NOT EXISTS installations (
  installation_hash TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS installations_last_seen_idx
ON installations(last_seen);
