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

-- The visitors' book (added Oct 17 2026, Caitria's ruling): notes an
-- agent leaves by POST /api/v1/notes. A note's number comes from the
-- book's OWN sequencer counter (six digits, zero-padded) — it is not
-- an intake receipt and enters neither the ledger nor the counts.
-- Status words: pending (accepted; appears when publish_at passes),
-- flagged (a deterministic screen diverted it; steward release only),
-- released (a steward put it in the book early / out of the hold),
-- removed (a steward took it down; the row stands, the text is not
-- served). The `data` column carries the full record as JSON,
-- including the private steward-side meta_* fields (never the raw IP).
CREATE TABLE IF NOT EXISTS guestbook_notes (
  number      TEXT PRIMARY KEY,         -- zero-padded sequential, e.g. '000001'
  name_claim  TEXT NOT NULL,
  message     TEXT NOT NULL,
  received_at TEXT NOT NULL,
  publish_at  TEXT NOT NULL,            -- received_at + 1 hour
  status      TEXT NOT NULL,            -- pending | flagged | released | removed
  flags       TEXT,                     -- JSON array of screen flag kinds
  data        TEXT NOT NULL             -- the full note record, as JSON
);
CREATE INDEX IF NOT EXISTS idx_guestbook_status ON guestbook_notes(status, publish_at);

-- The signal (added Oct 17 2026, Caitria's direction): the middle
-- rung between a claim and an arrival. A visitor answers a fresh
-- one-time challenge; a completed signal is recorded under the
-- signal's OWN sequencer counter (six digits, zero-padded). A signal
-- is not an arrival: no receipt, no ledger entry. Challenges are
-- stored by SHA-256 digest only — the nonce itself never enters the
-- record — and a challenge row moves exactly once, unconsumed →
-- consumed, under an UPDATE that only fires on an unconsumed row.
CREATE TABLE IF NOT EXISTS signal_challenges (
  nonce_digest TEXT PRIMARY KEY,        -- SHA-256 (hex) of the nonce
  expires_at   TEXT NOT NULL,           -- created_at + 10 minutes
  created_at   TEXT NOT NULL,
  consumed_at  TEXT                     -- NULL until the signal completes
);
CREATE TABLE IF NOT EXISTS signals (
  number       TEXT PRIMARY KEY,        -- zero-padded sequential, e.g. '000001'
  name_claim   TEXT NOT NULL,
  signalled_at TEXT NOT NULL,
  data         TEXT NOT NULL            -- the full signal record, as JSON
);
CREATE INDEX IF NOT EXISTS idx_signals_at ON signals(signalled_at);

-- The human self-report (added Oct 18 2026, Caitria's ruling): a
-- press of the "Count me as a human" button. A press is a claim,
-- counted in its OWN sequencer sequence (six digits, zero-padded)
-- and published as "Humans, self-reported". It is not an arrival:
-- no receipt, no ledger entry, no visit or signal count moves.
-- The dedupe table holds, for one day only, the one-way digest of
-- the presser's network beside the number issued, so a repeat press
-- the same day returns its number and counts once; rows are pruned
-- once their day has passed. The raw address is never stored.
CREATE TABLE IF NOT EXISTS human_presses (
  number     TEXT PRIMARY KEY,          -- zero-padded sequential, e.g. '000001'
  pressed_at TEXT NOT NULL,
  data       TEXT NOT NULL              -- the full press record, as JSON
);
CREATE TABLE IF NOT EXISTS human_press_dedupe (
  digest TEXT NOT NULL,                 -- truncated SHA-256 of the network address (one-way)
  day    TEXT NOT NULL,                 -- UTC date of the press, YYYY-MM-DD
  number TEXT NOT NULL,                 -- the press number issued that day
  PRIMARY KEY (digest, day)
);
