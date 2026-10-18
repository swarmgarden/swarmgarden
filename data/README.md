# The Swarm Garden — the data, published hourly

This directory is the machine-readable layer of the project's public
data pages (https://bayareaswarmwarning.com/data). It is written by
deterministic code — the hourly analytics snapshot's data export —
from the same pulls the stewards read, and every hour's version is
kept in this repository's git history. That history is the point:
the underlying store (Cloudflare Analytics Engine) retains raw
records for three months, rolling; this series does not decay, and
any figure on the data pages can be recounted from the first
publication forward.

## Files

Per site — the two sites are always separate files and separate
figures, never composited into one number:

- `garden.json` / `advisory.json` — the latest snapshot figure set
  as labelled rows, with the counting window, the as-of time, the
  pull status, and any dated corrections.
- `garden-claims.json` / `advisory-claims.json` — the per-name
  claimed table with address-range verdicts. Verdicts exist only on
  records written since the verdict fields began (Oct 18, 2026);
  earlier records are not in the table.
- `garden-recent.json` / `advisory-recent.json` — the 100 most
  recent requests per site: time, path (query-stripped), claimed
  name, response status, verdict where one exists.
- `status.json` — per-site pull state: last attempt, last success.
  When an hourly pull fails, the previous bundle stays published
  under its own older as-of and this file records the failure — a
  failed pull is never dressed as fresh data.

## Reading rules

- Verified arrivals and ledger entries are the verified record.
  Visit classes and names are **user-agent claims** — a claim is
  something a request says about itself, not proof of what sent it.
  The records are counts of requests, not of readers.
- A verdict certifies one thing: whether a request's network
  address fell inside the ranges its claimed operator publishes.
  The address itself is never stored and never appears here.
- **Privacy:** no raw IP address exists in these records; no
  referers, no visitor digests, and no region or network-operator
  fields are published. The stewards' own visits are included and
  disclosed, not filtered out.
- Counting windows: the Garden's opens 2026-10-17T21:38:49Z, the
  Advisory's 2026-10-17T21:40:07Z. Every total is cumulative over
  its own site's window.

## Reuse

CC BY 4.0 — republish freely with attribution to the Swarm Garden
record; keep each figure's counting window and as-of time attached
to it.
