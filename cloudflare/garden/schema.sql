-- Swarm Garden — D1 schema (the record stores).
-- Applied at provisioning (Phase 4, real account) and by the local test
-- harness. Apply with: wrangler d1 execute swarm-garden --file=schema.sql
--
-- Design: the record tables hold the same JSON record shapes the Netlify
-- Blobs stores held (the `data` column), with the few columns the code
-- queries by promoted out and indexed. D1 is the record; if the
-- sequencer Durable Object's counters ever disagree with these tables,
-- the counters are rebuilt from here (migration plan, Design A).

CREATE TABLE IF NOT EXISTS receipts (
  number     TEXT PRIMARY KEY,          -- zero-padded sequential, e.g. '0001'
  channel    TEXT NOT NULL,
  format     TEXT,
  brief_id   TEXT,
  fingerprint TEXT,
  state      TEXT,
  received_at TEXT,
  data       TEXT NOT NULL              -- the full receipt record, as JSON
);
CREATE INDEX IF NOT EXISTS idx_receipts_fingerprint ON receipts(channel, fingerprint);
CREATE INDEX IF NOT EXISTS idx_receipts_brief ON receipts(channel, format, brief_id, state);

CREATE TABLE IF NOT EXISTS ledger_entries (
  n          INTEGER PRIMARY KEY,       -- sequencer-issued entry number
  ts         TEXT NOT NULL,
  kind       TEXT,
  receipt    TEXT,
  data       TEXT NOT NULL              -- the full ledger entry, as JSON
);
CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger_entries(kind);

CREATE TABLE IF NOT EXISTS briefs (
  brief_id   TEXT PRIMARY KEY,
  data       TEXT NOT NULL              -- the full brief definition, as JSON
);

CREATE TABLE IF NOT EXISTS garden_state (
  key        TEXT PRIMARY KEY,          -- 'intake' -> { paused, by, at }
  data       TEXT NOT NULL
);

-- Plan-sanctioned fallback for visit records (migration plan, Design B:
-- "If Analytics Engine's limits bite during the build, visits can land
-- in D1 with the record shape unchanged"). The Worker writes visits to
-- Analytics Engine when an AE read token is configured; otherwise they
-- land here, same record shape. This is also the path the local harness
-- exercises end-to-end.
CREATE TABLE IF NOT EXISTS visit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  t          TEXT NOT NULL,             -- ISO timestamp of the request
  data       TEXT NOT NULL              -- the full visit record, as JSON
);
CREATE INDEX IF NOT EXISTS idx_visit_log_t ON visit_log(t);
