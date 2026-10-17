// Swarm Garden — public counts (ESM + @netlify/blobs)
// Returns the counts the Garden publishes: arrivals on record (from the
// ledger store — steward-entered record entries, never page loads) and,
// for context, the visit-log totals by claimed class. Read-only, no key:
// these numbers are the public record. A user-agent is a claim, not proof.
//
// Two labelling rules (classification synthesis, Oct 17 2026):
//   - Arrivals are published WITH their composition: arrivals_on_record
//     is the total, arrivals_over_cap_unread is the part of it whose
//     content was never read (ruling D2). The total never silently
//     claims reading that did not happen.
//   - Visit totals are computed over a WINDOW of the most recent
//     VISITS_WINDOW records, and the JSON says so, in the open.
//
// BEACON SEPARATION — STEWARD RULING STILL PENDING (synthesis item 8).
// The legacy in-page beacon is unauthenticated: a visitor can POST a
// visit record in any shape, and today beacon records fold into the
// same public class totals as edge-relayed records. The separation is
// PREPARED below but NOT in force: while BEACON_SEPARATION is false,
// totals include beacon records exactly as before. Flipping this one
// constant to true is the whole change: class totals then count
// edge-relayed records only, and beacon totals are published separately
// under visits_beacon_*. Do not flip it without the steward's ruling —
// it changes published counts semantics.
const BEACON_SEPARATION = false;

import { getStore } from '@netlify/blobs';

const VISITS_WINDOW = 1500;

async function readLedger() {
  const s = getStore('ledger');
  const { blobs } = await s.list();
  let entries = 0, arrivals = 0;
  const arrivalReceipts = [];
  for (const b of blobs || []) {
    try {
      const e = await s.get(b.key, { type: 'json' });
      if (e) { entries++; if (e.kind === 'arrival') { arrivals++; if (e.receipt) arrivalReceipts.push(e.receipt); } }
    } catch (e) {}
  }
  return { entries, arrivals, arrivalReceipts };
}

async function countOverCap(receiptNumbers) {
  if (!receiptNumbers.length) return 0;
  try {
    const s = getStore('receipts');
    let n = 0;
    for (const num of receiptNumbers) {
      try {
        const r = await s.get('r-' + num, { type: 'json' });
        if (r && r.state === 'over-cap-unread') n++;
      } catch (e) {}
    }
    return n;
  } catch (e) { return 0; }
}

const INTEREST = ['llms.txt', 'robots.txt', 'agent-skills', 'agent-card', 'security.txt', 'sitemap'];

async function readVisits() {
  const s = getStore('visits');
  const { blobs } = await s.list();
  const keys = (blobs || []).map(b => b.key).slice(-VISITS_WINDOW);
  const byClass = {}, byPath = {}, interest = {}, beaconByClass = {};
  let total = 0, beaconTotal = 0;
  for (const k of keys) {
    try {
      const r = await s.get(k, { type: 'json' });
      if (r) {
        if (BEACON_SEPARATION && r.via !== 'edge') {
          beaconTotal++;
          beaconByClass[r.cls] = (beaconByClass[r.cls] || 0) + 1;
          continue;
        }
        total++;
        byClass[r.cls] = (byClass[r.cls] || 0) + 1;
        byPath[r.path] = (byPath[r.path] || 0) + 1;
        if (INTEREST.some(x => (r.path || '').includes(x))) interest[r.path] = (interest[r.path] || 0) + 1;
      }
    } catch (e) {}
  }
  const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  return { total, byClass, topPaths: top(byPath, 10), interest: top(interest, 10), beaconTotal, beaconByClass };
}

export default async () => {
  const out = {
    arrivals_on_record: 0, arrivals_over_cap_unread: 0, ledger_entries: 0,
    visits_total: 0, visits_by_class: {},
    visits_window_records: VISITS_WINDOW,
    visits_window_note: 'Visit totals are computed over the most recent ' + VISITS_WINDOW + ' visit records.',
    updated: new Date().toISOString()
  };
  try {
    const l = await readLedger();
    out.arrivals_on_record = l.arrivals;
    out.ledger_entries = l.entries;
    out.arrivals_over_cap_unread = await countOverCap(l.arrivalReceipts);
  }
  catch (e) { out.ledger_error = 'Ledger store unavailable.'; }
  try {
    const v = await readVisits();
    out.visits_total = v.total;
    out.visits_by_class = v.byClass;
    out.top_paths = v.topPaths;
    out.agent_interest_files = v.interest;
    if (BEACON_SEPARATION) { out.visits_beacon_total = v.beaconTotal; out.visits_beacon_by_class = v.beaconByClass; }
  }
  catch (e) { out.visits_error = 'Visit store unavailable.'; }
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
};
