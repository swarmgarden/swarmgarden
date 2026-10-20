# The Swarm Garden — records export

This directory is the public, auditable form of the Swarm Garden's
record, exported by deterministic code from the project's hourly
analytics snapshots. It exists so the record does not depend on a
private link, one machine, or one platform account: anyone can recount
from these files.

## What is here

- `garden/counts-series.csv` / `counts-series.json` and
  `advisory/counts-series.csv` / `counts-series.json` — one row per
  hourly snapshot, per site. The two sites are always separate files
  and separate rows, never composited into one number.
- `garden/daily/YYYY-MM-DD.json` and `advisory/daily/YYYY-MM-DD.json`
  — the day's snapshot rendered as data: path x status table, country,
  region and network tables, claimed-crawler tables, hourly buckets.
  (Dates are Pacific Time days.)
- `ledger/garden-ledger.json` — the Garden's arrival ledger in its
  public form only: the same fields the record page publishes.
- `snapshots/YYYY-MM.md.gz` — the hourly snapshot log itself, archived
  monthly, gzip-compressed (`gunzip` restores plain markdown). The
  current month's file is month-to-date.
- `manifest.json` — what was generated when, file sizes and SHA-256
  hashes, and the counting windows below as measured at export time.

## Counting basis — read this before quoting any figure

- **Garden counting window opens at 2026-10-17T21:38:49Z (UTC). Advisory counting
  window opens at 2026-10-17 21:40:07 (UTC).** Every total in these files is
  cumulative over its site's own window; the windows are not the same
  and the sites' figures are never added together.
- Verified arrivals and ledger entries come from the Garden's public
  counts payload and ledger — the verified record. Visit classes,
  crawler names and purposes are **user-agent claims**: a claim is
  something a request says about itself, not proof of what sent it.
  The records are counts of requests, not of readers or visitors;
  no per-visitor key exists anywhere in them.
- Cloudflare Analytics Engine, the record's source, retains raw
  records for three months, rolling. The aggregates in this export are
  re-derived from the hourly snapshot log on every run, so they
  survive that decay; the raw per-request rows do not, and no file
  here can reconstruct them.
- In the series, `visits_total_full_dataset` is the counts payload's
  full-dataset figure where the payload states that basis. For hours
  whose payload counted only the most recent 1,500 records (before the
  Oct 18, 2026 basis fix) or whose payload pull failed (the degraded
  hours — arrivals for those hours are null in the series, not zero),
  it is the Analytics Engine dataset total for that hour, which is the
  full-dataset figure those hours have.
- The Advisory's `signals_total` is a structural zero — the Advisory
  has no signal tier — recorded as 0, never substituted from the
  Garden. Advisory `humans_self_reported` was not carried by the
  snapshot log before this export began; earlier rows are null.

## Privacy

- **No raw IP address exists in these records** — none is stored at
  the edge, none is captured at intake (rate limiting uses one-way
  hashes, steward-side, never exported), and so none appears here.
- Referrers publish as **hostnames only**; full referrer values stay
  in the steward copy. Paths publish with **query strings stripped**.
- User-agent strings are claims broadcast by the clients themselves;
  they pass a standing anomaly scan, and any string containing an
  email-shaped or ID-shaped substring is redacted whole in this export.
- Visitors' Book contents and signal names are **categorically
  excluded** — counts only. The book is read by the steward alone,
  under the condition it was opened under.

## How to recount

Pick a row in a counts series: `dataset_total` is the Analytics Engine
count of that site's whole dataset at that hour; the class columns sum
to it (when a query degraded, a class cell is empty rather than
wrong). A daily file's path table, country table and class table each
sum to that day's `dataset_total`. The ledger dump's
`arrivals_on_record` equals the Garden series' latest
`arrivals_on_record`.
