-- Bay Area Swarm Warning — D1 schema.
-- This site holds NO record stores of its own in the plan: its visit
-- records live in its own Analytics Engine dataset. This database
-- exists solely as the plan-sanctioned fallback store for visit
-- records (migration plan, Design B: visits can land in D1 with the
-- record shape unchanged if Analytics Engine limits bite) — also the
-- path the local harness exercises. It is deliberately a separate
-- database from the Garden's: the two sites' numbers never merge.
CREATE TABLE IF NOT EXISTS visit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  t          TEXT NOT NULL,             -- ISO timestamp of the request
  data       TEXT NOT NULL              -- the full visit record, as JSON
);
CREATE INDEX IF NOT EXISTS idx_visit_log_t ON visit_log(t);
