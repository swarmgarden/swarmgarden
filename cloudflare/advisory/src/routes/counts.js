// Bay Area Swarm Warning — public counts (added Oct 18 2026, repair).
// Published address: /.netlify/functions/counts — the same address
// shape the Garden publishes at, carrying THIS site's own figures.
//
// Why this file is new (the repair record): the address answered 404
// for this site's whole life. Diagnosis (Oct 18 2026): the route was
// NEVER registered in this Worker — not removed by any Oct 18 build.
// The evidence: every committed version of advisory/src/index.js
// (829d660, the cutover build, through c14265c, Record Window 1)
// registers only the stats, human-press and render-claim routes —
// its single "functions/counts" mention is the server-side fetch of
// the GARDEN's payload below; no advisory/src/routes/counts.js ever
// existed; the Netlify-era functions folder likewise held only
// stats + visit. This site's public displays always read the
// Garden's payload server-side, and its own totals lived only on the
// keyed stats page, so nothing visible broke — the gap surfaced when
// the A5 Field Notes draft read this address for this site's figures
// (first observed Oct 18 2026, ~9:54 AM PT; confirmed 10:06 AM).
//
// The payload keeps the Garden's byte-shape (same fields, per-site
// values), with this site's conventions, unchanged:
//   - Visit totals are THIS site's own, exact SQL aggregates over
//     its own dataset (shared/visits.mjs aggregateVisits — the same
//     arithmetic as this site's keyed stats page).
//   - arrivals_on_record / arrivals_over_cap_unread are read from
//     the Garden's public counts, as everywhere else on this site:
//     the record lives there; this site keeps no ledger of its own.
//     A failed read yields 0 plus an arrivals_error key (the Garden
//     payload's own unavailable-store grammar).
//   - ledger_entries / signals_total: there is no ledger and no
//     signal tier on this site. Following the same grammar, the
//     fields stay 0 and a permanent explanatory key rides along
//     (ledger_error / signals_error) so a structural zero never
//     reads as a measured one — the keyed page's structural labels,
//     in payload form.
//   - humans_total is this site's own press count (its own D1).
//   - counting_since is THIS dataset's start: the first record in
//     the advisory_visits dataset, 2026-10-17T21:40:07Z (the
//     records-export manifest's dataset_first_record_utc, Oct 18
//     2026). The shared COUNTING_SINCE constant is the Garden's own
//     start and is NOT reused here — the two windows differ, and
//     neither site's totals ever merge.
//   - Oct 21 2026 (Caitria's counting-definition ruling): two
//     ADDITIVE fields — record_reads {counts_read, ledger_read,
//     total} (reads of the record's own gauges: this payload and
//     the ledger file, by any reader) and visits_headline_total
//     (visits_total minus that fold). Every pre-existing field
//     keeps its meaning byte-for-byte — visits_total stays ALL
//     fetches, so the visits_window_records identity and every
//     consumer comparing like with like are untouched; the
//     headline the ruling names rides beside it, labelled by
//     visits_headline_note. (visits_window_note itself is pinned
//     verbatim by the harness's D1-basis check and is not
//     reworded; the Oct 21 definition is stated in the new note
//     field and on the /data pages.)
import { aggregateVisits } from '../../../shared/visits.mjs';
import { INTEREST } from '../../../shared/behaviour.mjs';
import { humanTotal } from '../lib/human.js';

const COUNTING_SINCE_ADVISORY = '2026-10-17T21:40:07Z'; // first record in this site's Analytics Engine dataset

async function readGardenArrivals(env) {
  const origin = env.COUNTS_ORIGIN || 'https://swarmgarden.com';
  const r = await fetch(origin + '/.netlify/functions/counts', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('garden counts ' + r.status);
  const j = await r.json();
  if (!j || typeof j.arrivals_on_record !== 'number') throw new Error('garden counts shape');
  return {
    arrivals: j.arrivals_on_record,
    overCap: typeof j.arrivals_over_cap_unread === 'number' ? j.arrivals_over_cap_unread : 0
  };
}

async function readVisits(env) {
  // Same construction as the Garden's counts read: exact aggregates
  // over the full dataset; claimed crawlers/fetchers re-read from
  // the stored UA strings through the shared dictionary (claims,
  // labelled as such wherever shown); only the ranked lists are cut.
  // D1 (Oct 19 2026): the fetchsplit dimension splits the same
  // records into HTTP fetches and redirect responses — visits_total
  // below is fetches, redirects ride additively, and
  // visits_window_records stays the all-records count, so
  // visits_total + redirects_total == visits_window_records exactly.
  const a = await aggregateVisits(env, ['class', 'path', 'ua', 'fetchsplit', 'event']);
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
    redirectsTotal: a.redirectsTotal, redirectsByClass: a.redirectsByClass,
    byEvent: a.byEvent
  };
}

export async function computeCounts(env) {
  const out = {
    arrivals_on_record: 0, arrivals_over_cap_unread: 0, ledger_entries: 0,
    ledger_error: "No ledger on this site — the ledger is the Garden's.",
    signals_total: 0,
    signals_error: "No signal tier on this site — signals are the Garden's.",
    humans_total: 0,
    visits_total: 0, visits_by_class: {},
    redirects_total: 0, redirects_by_class: {},
    crawlers_claimed: { total: 0, by_name: {} },
    fetchers_claimed: { total: 0, by_name: {} },
    visits_window_records: 0,
    visits_window_note: 'HTTP fetches since Oct 17, 2026 — content requests; redirect responses counted separately.',
    record_reads: { counts_read: 0, ledger_read: 0, total: 0 },
    visits_headline_total: 0,
    visits_headline_note: 'Headline fetches (Oct 21, 2026 definition): HTTP fetches excluding the record\u2019s own gauge-reads — reads of the counts payload and the ledger file, by any reader — which are published as record_reads.',
    counting_since: COUNTING_SINCE_ADVISORY,
    updated: new Date().toISOString()
  };
  try {
    const g = await readGardenArrivals(env);
    out.arrivals_on_record = g.arrivals;
    out.arrivals_over_cap_unread = g.overCap;
  }
  catch (e) { out.arrivals_error = 'Arrival record unavailable.'; }
  try { out.humans_total = await humanTotal(env); }
  catch (e) { out.humans_error = 'Human count store unavailable.'; }
  try {
    const v = await readVisits(env);
    // D1 (Oct 19 2026): visits_total is HTTP fetches; redirects ride
    // additively; visits_window_records stays the all-records count
    // (visits_total + redirects_total == visits_window_records).
    out.visits_total = v.fetchesTotal;
    out.visits_window_records = v.total;
    out.visits_by_class = v.fetchesByClass;
    out.redirects_total = v.redirectsTotal;
    out.redirects_by_class = v.redirectsByClass;
    out.crawlers_claimed = v.crawlersClaimed;
    out.fetchers_claimed = v.fetchersClaimed;
    out.top_paths = v.topPaths;
    out.agent_interest_files = v.interest;
    // Oct 21 2026 (counting-definition ruling): the record-reads
    // fold from the same read's event grouping — gauge reads are
    // fetches by construction (their responses are content or
    // errors, never redirects), so the headline subtraction is
    // exact: headline + fold = visits_total.
    const cr = (v.byEvent && v.byEvent['counts-read']) || 0;
    const lr = (v.byEvent && v.byEvent['ledger-read']) || 0;
    out.record_reads = { counts_read: cr, ledger_read: lr, total: cr + lr };
    out.visits_headline_total = v.fetchesTotal - (cr + lr);
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
