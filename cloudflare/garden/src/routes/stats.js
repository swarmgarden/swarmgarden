// Swarm Garden — live dashboard (Cloudflare port).
// Key-gated (?k= must match the STATS_KEY secret). Reads the visit
// records and the ledger/receipts (D1) and renders one auto-refreshing
// page. Behaviour labels are computed at query time over the stored
// records (shared/behaviour.mjs) — private working labels, never
// published claims. ?format=json returns the same aggregates as data.
// Port changes: visits come from the visit store (Analytics Engine or
// the D1 fallback) instead of a Blobs scan; every record is edge-written
// now, so the beacon column reads 0 by construction.
// Oct 18 2026 correction (same defect as the public counts, Caitria's
// flag): the aggregates were computed over the newest 1,500 raw
// records read into code, so once the dataset passed 1,500 every
// total on this page silently understated the record. They are now
// exact SQL aggregates over the FULL dataset (shared/visits.mjs
// aggregateVisits); behaviour labels fold from the per-path groups
// (the label is a function of the path alone, so the fold is exact).
// The raw read survives only for the recent-50 table — a display
// list, where a limit trims what is shown, never what is counted.
// Oct 18 2026 (B1 standardization + lens spec A4/B-b reads): this page
// and the Advisory's keyed page now render ONE standardized metric
// list (the B1 proposal's §4 order — record block, then visit block),
// one table grammar (label | count | share %), largest-first, with
// the basis line under the visit block. This page gains: country,
// grouped referrers with the "No referer recorded" line, named
// events, claimed crawlers/fetchers by name, humans, signals, the
// Visitors' Book counts, the per-name address-range verdict table,
// and the refused-POST knock counts. The JSON keeps every key it had
// and adds a standardized `visits` block whose key set is identical
// on both sites' pages.
import { readRecentVisits, aggregateVisits } from '../../../shared/visits.mjs';
import { behaviourLabel, INTEREST } from '../../../shared/behaviour.mjs';
import { groupReferrers } from '../../../shared/referrers.mjs';
import { countTable, sortedPairs, verdictTableHtml, verdictRows, referrerTableHtml, visitsBlock, visitorDigestTableHtml } from '../../../shared/statsview.mjs';
import { attemptStats } from '../../../shared/attempts.mjs';
import { renderStats } from '../../../shared/render.mjs';
import { dbListLedger, dbListReceipts, dbCountSignals, dbCountHumanPresses, dbListNotes } from '../lib/db.js';
import { isPublicNote } from '../lib/notes.js';

const BASIS = 'All recorded visits since Oct 17, 2026';

async function loadVisits(env) {
  // The aggregates and the recent-50 display read are independent;
  // they run concurrently (Oct 19, 2026 — the sequential chain was
  // the bulk of this route's ~5s; see shared/visits.mjs).
  const [a, recent] = await Promise.all([
    aggregateVisits(env, ['class', 'purpose', 'status', 'day', 'path', 'country', 'ref', 'event', 'via', 'ua', 'verdict', 'nameverdict', 'visitorday']),
    readRecentVisits(env, 50) // newest first — display list only
  ]);
  return { a, recent };
}

function aggregate(a) {
  const byBehaviour = {}, interest = {};
  for (const [p, c] of Object.entries(a.byPath)) {
    const bl = behaviourLabel({ path: p }); byBehaviour[bl] = (byBehaviour[bl] || 0) + c;
    if (INTEREST.some(s => p.includes(s))) interest[p] = c;
  }
  const top = (obj, n) => Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, n);
  const edge = (a.byVia && a.byVia['edge']) || 0;
  return {
    total: a.total, byClass: a.byClass, byPurpose: a.byPurpose, byBehaviour, byStatus: a.byStatus, byDay: a.byDay,
    topPaths: top(a.byPath, 12), interest: top(interest, 12), edge, beacon: a.total - edge, readDepth: Object.keys(a.byPath).length,
    byEvent: a.byEvent, topCountries: top(a.byCountry, 12),
    referrersGrouped: groupReferrers(a.byRef, a.total),
    crawlersClaimed: a.crawlersClaimed, fetchersClaimed: a.fetchersClaimed,
    byVerdict: a.byVerdict, byNameVerdict: a.byNameVerdict, byVisitorDay: a.byVisitorDay
  };
}

export default async (req, env) => {
  const KEY = env.STATS_KEY || '';
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get('k') !== KEY) return new Response('Key required.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  let loaded;
  try { loaded = await loadVisits(env); }
  catch (e) { return new Response('Storage read failed. Visit records are also in the Worker logs (search VISIT).', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  const recs = loaded.recent; // newest first, at most 50 — display list
  const agg = aggregate(loaded.a);
  const asOf = new Date().toISOString();
  // The D1 reads below are independent of each other; they run
  // concurrently, each keeping its own failure-to-null semantics
  // (Oct 19, 2026, latency fix — values unchanged).
  const [entries, receipts, humans, signals] = await Promise.all([
    dbListLedger(env.DB).catch(() => null),
    dbListReceipts(env.DB).catch(() => null),
    dbCountHumanPresses(env.DB).catch(() => null),
    dbCountSignals(env.DB).catch(() => null)
  ]);
  const arrivals = entries ? entries.filter(e => e.kind === 'arrival').length : null;
  // Visitors' Book counts ONLY (the standing rule: no agent workflow
  // reads note contents; these are the same counts the book's steward
  // page exposes — published vs held, nothing else leaves the table).
  let book = null;
  try {
    const notes = await dbListNotes(env.DB);
    const nowIso = new Date().toISOString();
    book = {
      published: notes.filter(n => isPublicNote(n, nowIso)).length,
      held_flagged: notes.filter(n => n.status === 'flagged').length,
      awaiting_publication: notes.filter(n => n.status === 'pending' && !isPublicNote(n, nowIso)).length
    };
  } catch (e) { /* counts unavailable: the section says so */ }
  const [attempts, renders] = await Promise.all([
    attemptStats(env).catch(() => null),
    renderStats(env).catch(() => null)
  ]);
  const lanes = {};
  const states = {};
  if (receipts) for (const r of receipts) { lanes[r.lane] = (lanes[r.lane] || 0) + 1; states[r.state] = (states[r.state] || 0) + 1; }

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({
      arrivals_on_record: arrivals, humans_total: humans, signals_total: signals,
      ledger_entries: entries ? entries.length : null,
      guestbook: book, api_attempts: attempts, render_claims: renders,
      ...agg, submissions: receipts ? { total: receipts.length, by_lane: lanes, by_state: states } : null,
      visits: visitsBlock(agg, asOf), recent: recs
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const agentClaimed = (agg.byClass && agg.byClass['agent-claimed']) || 0;
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Swarm Garden — live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += '<h2>Swarm Garden — live dashboard</h2>';
  html += '<p>Refreshed ' + esc(asOf) + ' (auto-refresh 60s).</p>';

  // ---- Block A: the record (D1, exact counts) ----
  html += '<h3>The record</h3>';
  html += '<p>Verified agent arrivals on record: <strong>' + (arrivals === null ? 'ledger unavailable' : arrivals) + '</strong> — the record, from this site&rsquo;s ledger.</p>';
  html += '<p>Humans, self-reported: <strong>' + (humans === null ? 'unavailable' : humans) + '</strong> (a claim) — this site&rsquo;s own button presses.</p>';
  html += '<p>Signals completed: <strong>' + (signals === null ? 'unavailable' : signals) + '</strong> — the middle rung: a completed challenge-response, not an arrival.</p>';
  html += '<p>Ledger entries: <strong>' + (entries === null ? 'unavailable' : entries.length) + '</strong> total.</p>';
  if (entries && entries.length) {
    html += '<h4>Ledger — latest 10 entries</h4><ul>' + entries.slice(-10).reverse().map(e => '<li>#' + e.n + ' · ' + esc(e.ts) + ' · ' + esc(e.kind) + (e.state ? ' · ' + esc(e.state) : '') + ' — ' + esc(e.summary) + '</li>').join('') + '</ul>';
  }
  if (receipts) {
    html += '<h4>Submissions (receipts) — ' + receipts.length + ' total</h4>';
    html += '<p>By lane: ' + Object.entries(lanes).map(([k, v]) => esc(k) + ': ' + v).join(', ') + '. By state: ' + Object.entries(states).map(([k, v]) => esc(k) + ': ' + v).join(', ') + '.</p>';
    html += '<p>Metadata only. Submission content is quoted data in the steward queue; it is never rendered here and nothing is public until a steward disposition.</p>';
    if (receipts.length) {
      html += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>receipt</th><th>received (UTC)</th><th>channel</th><th>lane</th><th>state</th><th>claim (as asserted)</th><th>fingerprint</th></tr>';
      for (const r of receipts.slice(-50).reverse()) html += '<tr><td>' + esc(r.number) + '</td><td>' + esc(r.received_at) + '</td><td>' + esc(r.channel) + '</td><td>' + esc(r.lane) + '</td><td>' + esc(r.state) + '</td><td>' + esc(r.submission && r.submission.agent_name) + '</td><td>' + esc((r.fingerprint || '').slice(0, 12)) + '…</td></tr>';
      html += '</table>';
    }
  }
  html += '<p>Visitors&rsquo; Book (counts only — contents are the steward&rsquo;s own reading, never an agent workflow&rsquo;s): ' +
    (book === null ? 'unavailable' : 'published <strong>' + book.published + '</strong> · held (flagged) <strong>' + book.held_flagged + '</strong> · awaiting publication <strong>' + book.awaiting_publication + '</strong>') + '.</p>';

  // ---- Block B: visits (full-dataset aggregates) ----
  html += '<h3>Visits — ' + agg.total + ' total recorded visits</h3>';
  html += '<p>' + BASIS + ' · as of ' + esc(asOf) + '. All records edge-written (' + agg.edge + ' via edge log, ' + agg.beacon + ' via legacy beacon). Everything below is requests, not arrivals.</p>';
  html += '<h4>Requests by claimed class</h4>' + countTable(esc, sortedPairs(agg.byClass), agg.total);
  html += '<p>Labels describe what each request&rsquo;s user-agent claims. A claim is not a verification.</p>';
  html += '<h4>Agent-claimed visits, by purpose</h4>' + countTable(esc, sortedPairs(agg.byPurpose), agentClaimed);
  html += '<h4>Claimed crawlers by name (top 10)</h4>' + countTable(esc, sortedPairs(agg.crawlersClaimed.by_name), agg.total);
  html += '<h4>Claimed fetchers by name (top 10)</h4>' + countTable(esc, sortedPairs(agg.fetchersClaimed.by_name), agg.total);
  html += '<p>Names are read from the user-agent strings through the shared claimed-bot dictionary — claims, as announced by the visiting software itself.</p>';
  html += '<h4>Behaviour labels (private working labels, computed from paths)</h4>' + countTable(esc, sortedPairs(agg.byBehaviour), agg.total);
  html += '<h4>Response status totals</h4>' + countTable(esc, sortedPairs(agg.byStatus), agg.total);
  html += '<h4>Named events</h4>' + countTable(esc, sortedPairs(agg.byEvent), agg.total);
  html += '<h4>Top pages</h4>' + countTable(esc, agg.topPaths, agg.total);
  html += '<h4>Agent-interest files</h4>' + countTable(esc, agg.interest, agg.total);
  html += '<p>Distinct paths read: <strong>' + agg.readDepth + '</strong>.</p>';
  html += '<h4>Visits by day</h4>' + countTable(esc, Object.entries(agg.byDay).sort(), agg.total);
  html += '<h4>Visits by country (top 12)</h4>' + countTable(esc, agg.topCountries, agg.total);
  html += '<p>Edge geography — a country is the network exit point, not the operator&rsquo;s home.</p>';
  html += '<h4>Top referrers</h4>' + referrerTableHtml(esc, agg.referrersGrouped, agg.total);
  html += '<h4>Address-range verdicts, by claimed name</h4>' + verdictTableHtml(esc, agg.byNameVerdict);
  html += '<h4>Distinct visitor digests, by day (Pacific)</h4>' + visitorDigestTableHtml(esc, agg.byVisitorDay);

  // ---- Channel knocks (B-b read) ----
  html += '<h3>Channel knocks — refused POST attempts</h3>';
  if (attempts === null) html += '<p>Unavailable.</p>';
  else if (!attempts.total) html += '<p>None recorded. (Successful POSTs are not written here — each channel counts its own; request bodies are never stored.)</p>';
  else {
    html += '<p>' + attempts.total + ' refused attempts recorded. Successful POSTs are not written here — each channel counts its own; request bodies are never stored.</p>';
    html += '<h4>By channel</h4>' + countTable(esc, sortedPairs(attempts.by_channel), attempts.total);
    html += '<h4>By refusal code</h4>' + countTable(esc, sortedPairs(attempts.by_code), attempts.total);
    html += '<h4>By day</h4>' + countTable(esc, Object.entries(attempts.by_day).sort(), attempts.total);
  }

  // ---- Render-signalled (B-d read; the instrument is the Advisory's) ----
  html += '<h3>Render-signalled — pages reporting a render (claims)</h3>';
  html += '<p>No page on the Garden fires this signal: the Garden&rsquo;s pages stay script-free for their readers, and the endpoint (POST /api/v1/render-claim) stands gated shut on this site. The instrument is the Advisory&rsquo;s — its homepage reports a render, published there as &ldquo;render-signalled&rdquo;: evidence a browser executed the page; a claim, never an arrival. This site&rsquo;s own table stands below; while the gate is shut it is empty by structure, not by measurement.</p>';
  if (renders === null) html += '<p>Unavailable.</p>';
  else if (!renders.total) html += '<p>None recorded — the gate is shut and no Garden page fires the signal.</p>';
  else {
    html += '<p>' + renders.total + ' render claims recorded on this site.</p>';
    html += '<h4>By page</h4>' + countTable(esc, sortedPairs(renders.by_path), renders.total);
    html += '<h4>By day</h4>' + countTable(esc, Object.entries(renders.by_day).sort(), renders.total);
    html += '<h4>By claimed class</h4>' + countTable(esc, sortedPairs(renders.by_cls), renders.total);
  }

  // ---- Recent 50 (display only) ----
  html += '<h3>Most recent 50 requests</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>purpose</th><th>behaviour</th><th>method</th><th>status</th><th>md</th><th>bot-auth</th><th>event</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs) html += '<tr><td>' + esc(r.t) + '</td><td>' + esc(r.cls) + '</td><td>' + esc(r.purpose || '—') + '</td><td>' + esc(behaviourLabel(r)) + '</td><td>' + esc(r.method || '—') + '</td><td>' + esc(r.status === null || r.status === undefined ? '—' : r.status) + '</td><td>' + esc(r.md === null || r.md === undefined ? '—' : r.md) + '</td><td>' + esc(r.ba || '—') + '</td><td>' + esc(r.event || 'pageview') + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(r.ua) + '</td></tr>';
  html += '</table><p>Labels describe what each request&rsquo;s user-agent claims. A claim is not a verification.</p></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
};
