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

-- The human self-report (added Oct 18 2026, Caitria's ruling): this
-- site's own "Count me as a human" press count, in this site's own
-- database — a SEPARATE record from the Garden's, so the two sites'
-- numbers never merge. A press is a claim, counted in its own
-- six-digit sequence (the presses table's AUTOINCREMENT id, padded
-- at issue — this Worker has no sequencer Durable Object) and
-- published as "Humans, self-reported". It is not an arrival and
-- moves no other count. The dedupe table holds, for one day only,
-- the one-way digest of the presser's network beside the number
-- issued; rows are pruned once their day has passed. The raw
-- address is never stored. site_state is this site's garden_state
-- (the steward pause flag); human_rate holds the fixed-window rate
-- counters in the sequencer's key shapes.
CREATE TABLE IF NOT EXISTS site_state (
  key        TEXT PRIMARY KEY,          -- 'human' -> { paused, by, at }
  data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS human_presses (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,  -- the sequence itself
  number     TEXT,                               -- zero-padded form of seq, set at issue
  pressed_at TEXT NOT NULL,
  day        TEXT NOT NULL,                      -- UTC date, YYYY-MM-DD
  data       TEXT NOT NULL                       -- the full press record, as JSON
);
CREATE INDEX IF NOT EXISTS idx_human_presses_day ON human_presses(day);
CREATE TABLE IF NOT EXISTS human_press_dedupe (
  digest TEXT NOT NULL,                 -- truncated SHA-256 of the network address (one-way)
  day    TEXT NOT NULL,                 -- UTC date of the press, YYYY-MM-DD
  number TEXT NOT NULL,                 -- the press number issued that day
  PRIMARY KEY (digest, day)
);
CREATE TABLE IF NOT EXISTS human_rate (
  key       TEXT NOT NULL,              -- hum-m:<digest> / hum-h:<digest>
  bucket_ms INTEGER NOT NULL,           -- the fixed window's start, epoch ms
  count     INTEGER NOT NULL,
  PRIMARY KEY (key, bucket_ms)
);

-- Refused-POST attempts (added Oct 18 2026, lens spec B-b): the knock
-- record — this site's own table in its own D1, never merged with the
-- Garden's. One row per REFUSED non-GET/HEAD request to a published
-- channel (here: the human press), plus unrouted POSTs answered 404
-- (channel 'unrouted'). Successful POSTs are never written. Request
-- bodies are never stored; no address is stored. Written by
-- shared/attempts.mjs from the router; read by the keyed stats page.
CREATE TABLE IF NOT EXISTS api_attempts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  t       TEXT NOT NULL,                -- ISO timestamp of the attempt
  route   TEXT NOT NULL,                -- the path as called
  channel TEXT NOT NULL,                -- human-press|render-claim|unrouted (this site's channels)
  method  TEXT NOT NULL,
  status  INTEGER NOT NULL,             -- the HTTP status returned
  code    TEXT NOT NULL DEFAULT '',     -- refusal code from the response JSON, best-effort
  cls     TEXT NOT NULL DEFAULT '',     -- the UA's claimed class (shared taxonomy)
  cname   TEXT NOT NULL DEFAULT '',     -- the UA's claimed dictionary name, if any
  country TEXT NOT NULL DEFAULT '',     -- edge facts, as on the visit record
  asn     TEXT NOT NULL DEFAULT '',
  as_org  TEXT NOT NULL DEFAULT ''
);

-- Render claims (added Oct 18 2026, lens spec B-d): a page's own
-- script posts its path to /api/v1/render-claim after rendering;
-- the claim is published as "render-signalled" — evidence a
-- browser executed the page. A claim, forgeable in principle; not
-- an arrival; never in the visit datasets or the counts. This
-- site's own table in its own D1 — the Garden holds the same
-- shape, gated shut, and the two never merge. The rate table
-- holds the fixed-window per-network counters (ren-m: / ren-h: +
-- one-way digest) in the human rate table's shapes; no raw
-- address is stored anywhere. Written by shared/render.mjs from
-- the route; read by the keyed stats page.
CREATE TABLE IF NOT EXISTS render_claims (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  t       TEXT NOT NULL,                -- ISO timestamp of the claim
  path    TEXT NOT NULL,                -- the page path the claim names
  cls     TEXT NOT NULL DEFAULT '',     -- the UA's claimed class (shared taxonomy)
  country TEXT NOT NULL DEFAULT '',     -- edge facts, as on the visit record
  asn     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_render_claims_t ON render_claims(t);
CREATE TABLE IF NOT EXISTS render_rate (
  key       TEXT NOT NULL,              -- ren-m:<digest> / ren-h:<digest>
  bucket_ms INTEGER NOT NULL,           -- the fixed window's start, epoch ms
  count     INTEGER NOT NULL,
  PRIMARY KEY (key, bucket_ms)
);
