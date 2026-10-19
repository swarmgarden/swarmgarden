// Swarm Garden — public counts (Cloudflare port).
// Published address: /.netlify/functions/counts (kept — printed pages
// and the advisory dashboard cite it; plan Decision 6).
// Returns the counts the Garden publishes: arrivals on record (from the
// ledger — steward-entered record entries, never page loads) and, for
// context, the visit-log totals by claimed class. Read-only, no key.
// A user-agent is a claim, not proof.
//
// Labelling rules (classification synthesis, Oct 17 2026), unchanged:
//   - Arrivals are published WITH their composition:
//     arrivals_over_cap_unread is the part whose content was never read.
//   - Visit totals are computed over ALL recorded visits since
//     counting began, and the JSON says so, in the open.
//
// D1 (Oct 19 2026, measurement-accuracy build): visits_total is now
// HTTP FETCHES — records whose response was not a redirect (status
// outside 300–399). On this platform an extensionless page fetch
// arrives as two requests (a 307 leg, then the content fetch), so
// the old total counted each such read nearly twice. Redirect
// responses are published additively (redirects_total /
// redirects_by_class, class splits on both sides), and
// visits_window_records remains the all-records count, so
// visits_total + redirects_total == visits_window_records exactly
// (INV-2). crawlers_claimed / fetchers_claimed keep their
// all-records basis (claims read from UA strings) — unchanged.
//
// Correction (Oct 18 2026, Caitria's flag): the launch build computed
// the visit totals over a WINDOW of the most recent 1,500 records —
// a read sized for launch volumes and never re-sized as they grew.
// The Garden's dataset passed 1,500 records on its first night, and
// from then on the published total permanently understated the
// record. A counting experiment cannot run on a capped count, so the
// totals are now exact SQL aggregates over the full dataset
// (shared/visits.mjs aggregateVisits — the same GROUP BY arithmetic
// the hourly snapshot pulls). The visits_window_* keys are kept for
// compatibility and now tell the truth: visits_window_records is the
// number of records the totals were computed over (the full count),
// and the note states the full-dataset basis. Nothing was ever lost —
// every request stayed recorded in the dataset; only this endpoint's
// arithmetic was capped.
//
// Additive fields (Oct 17 2026, backwards-compatible — every
// Netlify-era key is unchanged): crawlers_claimed / fetchers_claimed
// re-read the stored user-agent strings at query time through the
// shared claimed-bot dictionary (shared/behaviour.mjs), so named
// crawlers the write-time classes file under automation/unknown are
// still countable — as CLAIMS, labelled as such wherever they are
// shown. Crawlers and user-triggered fetchers are separate totals.
// counting_since (also Oct 17 2026, Caitria's direction): the moment
// the current dataset began — totals travel with their counting
// window, because the Cloudflare-era counter reads lower than the
// preserved Netlify-era record it replaced. The constant and the
// wording live in shared/counting.mjs.
//
// What changed in the port:
//   - Arrivals/ledger from D1; visits from the visit store (Analytics
//     Engine, or the D1 fallback — shared/visits.mjs).
//   - The beacon question is settled by the architecture (plan
//     Decision 7): there is no client write path into the visit record
//     on this stack — every record is edge-written (via='edge') — so
//     the Netlify build's prepared-but-inactive BEACON_SEPARATION
//     branch is gone. Totals are edge-only by construction.
import { dbListLedger, dbGetReceipt, dbCountSignals, dbCountHumanPresses } from '../lib/db.js';
import { aggregateVisits } from '../../../shared/visits.mjs';
import { COUNTING_SINCE } from '../../../shared/counting.mjs';

const INTEREST = ['llms.txt', 'robots.txt', 'agent-skills', 'agent-card', 'security.txt', 'sitemap'];

async function readLedger(env) {
  const entries = await dbListLedger(env.DB);
  const arrivalReceipts = [];
  let arrivals = 0;
  for (const e of entries) {
    if (e.kind === 'arrival') { arrivals++; if (e.receipt) arrivalReceipts.push(e.receipt); }
  }
  return { entries: entries.length, arrivals, arrivalReceipts };
}

async function countOverCap(env, receiptNumbers) {
  if (!receiptNumbers.length) return 0;
  let n = 0;
  for (const num of receiptNumbers) {
    try {
      const r = await dbGetReceipt(env.DB, num);
      if (r && r.state === 'over-cap-unread') n++;
    } catch (e) {}
  }
  return n;
}

async function readVisits(env) {
  // Exact aggregates over the full dataset (Oct 18 2026 correction —
  // see the header). The claimed-bot aggregates keep their Oct 17
  // semantics: the stored UA strings re-read at query time through
  // the shared dictionary (shared/behaviour.mjs), now grouped and
  // counted in SQL first and folded through the dictionary weighted
  // by group counts. A name here is what the visit's own software
  // announced — a claim, never a verification. Crawlers
  // (operator-scheduled) and fetchers (user-triggered) are counted
  // apart, always. Only the ranked LISTS are cut (top 10) — a display
  // limit on a ranked list; every total is the full count.
  // D1 (Oct 19 2026): the fetchsplit dimension splits the same
  // records into HTTP fetches (status outside 300–399) and redirect
  // responses — the headline below is fetches; the redirect counts
  // ride as additive keys and visits_window_records stays the
  // all-records count the totals were computed over, so
  // visits_total + redirects_total == visits_window_records exactly.
  const a = await aggregateVisits(env, ['class', 'path', 'ua', 'fetchsplit']);
  const interest = {};
  for (const [p, c] of Object.entries(a.byPath)) {
    if (INTEREST.some(x => p.includes(x))) interest[p] = c;
  }
  const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, n));
  return {
    total: a.total, byClass: a.byClass, topPaths: top(a.byPath, 10), interest: top(interest, 10),
    crawlersClaimed: a.crawlersClaimed,
    fetchersClaimed: a.fetchersClaimed,
    fetchesTotal: a.fetchesTotal, fetchesByClass: a.fetchesByClass,
    redirectsTotal: a.redirectsTotal, redirectsByClass: a.redirectsByClass
  };
}

// Also called in-process by the front door (count injection) — the
// self-fetch to the counts function disappears (plan inventory #3).
export async function computeCounts(env) {
  const out = {
    arrivals_on_record: 0, arrivals_over_cap_unread: 0, ledger_entries: 0,
    signals_total: 0,
    humans_total: 0,
    visits_total: 0, visits_by_class: {},
    redirects_total: 0, redirects_by_class: {},
    crawlers_claimed: { total: 0, by_name: {} },
    fetchers_claimed: { total: 0, by_name: {} },
    visits_window_records: 0,
    visits_window_note: 'HTTP fetches since Oct 17, 2026 — content requests; redirect responses counted separately.',
    counting_since: COUNTING_SINCE,
    updated: new Date().toISOString()
  };
  try {
    const l = await readLedger(env);
    out.arrivals_on_record = l.arrivals;
    out.ledger_entries = l.entries;
    out.arrivals_over_cap_unread = await countOverCap(env, l.arrivalReceipts);
  }
  catch (e) { out.ledger_error = 'Ledger store unavailable.'; }
  // signals_total (additive, Oct 17 2026): completed signals — the
  // middle rung between a claim and an arrival. The signal's own D1
  // count, published apart: never folded into visits_by_class, never
  // added to arrivals.
  try { out.signals_total = await dbCountSignals(env.DB); }
  catch (e) { out.signals_error = 'Signal store unavailable.'; }
  // humans_total (additive, Oct 18 2026): human self-reports — the
  // "Count me as a human" presses, counted in their own D1 table and
  // published apart, as a claim-tier figure ("Humans, self-reported").
  // A press is a claim; the total is never folded into visits_by_class
  // and never added to arrivals.
  try { out.humans_total = await dbCountHumanPresses(env.DB); }
  catch (e) { out.humans_error = 'Human count store unavailable.'; }
  try {
    const v = await readVisits(env);
    // D1 (Oct 19 2026): visits_total is now HTTP FETCHES (content
    // requests — records whose response was not a redirect), and
    // visits_by_class is the fetches' class split. Redirect
    // responses ride additively (redirects_total /
    // redirects_by_class). visits_window_records stays the
    // all-records count — the compatibility key tells the truth:
    // visits_total + redirects_total == visits_window_records.
    out.visits_total = v.fetchesTotal;
    out.visits_window_records = v.total;
    out.visits_by_class = v.fetchesByClass;
    out.redirects_total = v.redirectsTotal;
    out.redirects_by_class = v.redirectsByClass;
    out.crawlers_claimed = v.crawlersClaimed;
    out.fetchers_claimed = v.fetchersClaimed;
    out.top_paths = v.topPaths;
    out.agent_interest_files = v.interest;
  }
  catch (e) { out.visits_error = 'Request store unavailable.'; }
  return out;
}

export default async (req, env) => {
  const out = await computeCounts(env);
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
};
