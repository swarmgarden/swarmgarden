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
//   - Visit totals are computed over a WINDOW of the most recent
//     VISITS_WINDOW records, and the JSON says so, in the open.
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
import { readRecentVisits } from '../../../shared/visits.mjs';
import { claimedBot } from '../../../shared/behaviour.mjs';
import { COUNTING_SINCE } from '../../../shared/counting.mjs';

const VISITS_WINDOW = 1500;
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
  const recs = await readRecentVisits(env, VISITS_WINDOW);
  const byClass = {}, byPath = {}, interest = {}, crawlers = {}, fetchers = {};
  let total = 0;
  for (const r of recs) {
    total++;
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (INTEREST.some(x => (r.path || '').includes(x))) interest[r.path] = (interest[r.path] || 0) + 1;
    // Claimed-bot aggregates (additive, Oct 17 2026): the stored UA
    // strings re-read at query time through the shared dictionary
    // (shared/behaviour.mjs). A name here is what the visit's own
    // software announced — a claim, never a verification. Crawlers
    // (operator-scheduled) and fetchers (user-triggered) are counted
    // apart, always.
    const bot = claimedBot(r.ua);
    if (bot && bot.kind === 'crawler') crawlers[bot.name] = (crawlers[bot.name] || 0) + 1;
    else if (bot && bot.kind === 'fetcher') fetchers[bot.name] = (fetchers[bot.name] || 0) + 1;
  }
  const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
  return {
    total, byClass, topPaths: top(byPath, 10), interest: top(interest, 10),
    crawlersClaimed: { total: sum(crawlers), by_name: top(crawlers, 10) },
    fetchersClaimed: { total: sum(fetchers), by_name: top(fetchers, 10) }
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
    crawlers_claimed: { total: 0, by_name: {} },
    fetchers_claimed: { total: 0, by_name: {} },
    visits_window_records: VISITS_WINDOW,
    visits_window_note: 'Visit totals are computed over the most recent ' + VISITS_WINDOW + ' visit records.',
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
    out.visits_total = v.total;
    out.visits_by_class = v.byClass;
    out.crawlers_claimed = v.crawlersClaimed;
    out.fetchers_claimed = v.fetchersClaimed;
    out.top_paths = v.topPaths;
    out.agent_interest_files = v.interest;
  }
  catch (e) { out.visits_error = 'Visit store unavailable.'; }
  return out;
}

export default async (req, env) => {
  const out = await computeCounts(env);
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
};
