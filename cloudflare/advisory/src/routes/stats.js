// Bay Area Swarm Warning — live dashboard (Cloudflare port).
// Key-gated (?k= must match the STATS_KEY secret). Arrivals are read
// from the Garden's public counts endpoint (the record lives there).
// Port changes, per the migration plan's advisory amendment
// (Caitria, Oct 17 2026):
//   - Visit records are classified by the project's SINGLE-SOURCE
//     taxonomy (shared/taxonomy.mjs) at write time — this site's stale
//     hand-copied classifier (which even contained the forged-by-
//     definition 'google-extended'/'applebot-extended' UA tokens) is
//     NOT carried over.
//   - Records carry the full Oct 17 field set (method, status,
//     Markdown-preference, bot-auth presence/verdict, country from the
//     edge, referrer, named event), in this site's OWN Analytics
//     Engine dataset — never merged with the Garden's records.
//   - The dashboard also aggregates purpose, behaviour (computed at
//     query time), status, countries, referrers and named events, so
//     "are people visiting, where from, human or automation — with the
//     basis stated" is answerable from this page. Classifications are
//     reported with their basis, never as certainty.
// ?format=json returns the same aggregates as data.
// Oct 18 2026 correction (same defect as the Garden's counts and
// stats, Caitria's flag): the aggregates were computed over the
// newest 1,500 raw records read into code — this site's dataset
// passed 2,400 records on its first night, so every total on this
// page silently understated the record by nearly half. They are now
// exact SQL aggregates over the FULL dataset (shared/visits.mjs
// aggregateVisits); behaviour labels fold from the per-path groups
// (the label is a function of the path alone, so the fold is exact),
// and referrers fold to hosts from the grouped counts. The raw read
// survives only for the recent-50 table — a display list, where a
// limit trims what is shown, never what is counted.
// Oct 18 2026 (B1 standardization + lens spec A4/B-b reads): this page
// and the Garden's keyed page now render ONE standardized metric
// list (the B1 proposal's §4 order — record block, then visit
// block), one table grammar (label | count | share %), largest-first,
// with the basis line under the visit block. This page gains: claimed
// crawlers/fetchers by name, distinct paths read, referrer share %
// with platform grouping and the "No referer recorded" line, country
// share %, the per-name address-range verdict table, and the
// refused-POST knock counts. The Garden-only record metrics (signals,
// ledger, submissions, the Visitors' Book) appear as structural
// labels, never as measured zeros — they are the Garden's record,
// not this site's. The arrivals figure stays a labelled reference to
// the Garden's. The JSON keeps every key it had and adds a
// standardized `visits` block whose key set is identical on both
// sites' pages.
import { readRecentVisits, aggregateVisits } from '../../../shared/visits.mjs';
import { behaviourLabel, INTEREST } from '../../../shared/behaviour.mjs';
import { groupReferrers } from '../../../shared/referrers.mjs';
import { countTable, sortedPairs, verdictTableHtml, referrerTableHtml, visitsBlock, visitorDigestTableHtml, visitorEpochTableHtml, knocksBlockHtml, VISITS_BASIS } from '../../../shared/statsview.mjs';
import { attemptStats } from '../../../shared/attempts.mjs';
import { renderStats } from '../../../shared/render.mjs';
import { humanTotal, setHumanPaused } from '../lib/human.js';
import { setRenderPaused } from '../lib/render.js';

const BASIS = VISITS_BASIS;

async function loadVisits(env) {
  const a = await aggregateVisits(env, ['class', 'purpose', 'status', 'day', 'path', 'country', 'ref', 'event', 'via', 'ua', 'verdict', 'nameverdict', 'visitorday', 'visitorepoch', 'fetchsplit']);
  const recent = await readRecentVisits(env, 50); // newest first — display list only
  return { a, recent };
}

async function loadArrivals(env) {
  try {
    const origin = env.COUNTS_ORIGIN || 'https://swarmgarden.com';
    const r = await fetch(origin + '/.netlify/functions/counts');
    if (r.ok) { const j = await r.json(); if (typeof j.arrivals_on_record === 'number') return j.arrivals_on_record; }
  } catch (e) {}
  return null;
}

function aggregate(a) {
  const byBehaviour = {}, interest = {};
  for (const [p, c] of Object.entries(a.byPath)) {
    const bl = behaviourLabel({ path: p }); byBehaviour[bl] = (byBehaviour[bl] || 0) + c;
    if (INTEREST.some(s => p.includes(s))) interest[p] = c;
  }
  const top = (obj, n) => Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, n);
  return {
    total: a.total, byClass: a.byClass, byPurpose: a.byPurpose, byBehaviour, byStatus: a.byStatus, byDay: a.byDay,
    topPaths: top(a.byPath, 12), interest: top(interest, 12),
    topCountries: top(a.byCountry, 12), topReferrers: top(a.byRef, 12), byEvent: a.byEvent,
    readDepth: Object.keys(a.byPath).length,
    referrersGrouped: groupReferrers(a.byRef, a.total),
    crawlersClaimed: a.crawlersClaimed, fetchersClaimed: a.fetchersClaimed,
    byVerdict: a.byVerdict, byNameVerdict: a.byNameVerdict, byVisitorDay: a.byVisitorDay,
    byVisitorEpoch: a.byVisitorEpoch,
    fetchesTotal: a.fetchesTotal, redirectsTotal: a.redirectsTotal,
    fetchesByClass: a.fetchesByClass, redirectsByClass: a.redirectsByClass,
    truncatedDims: a.truncated_dims || [],
    edge: (a.byVia && a.byVia['edge']) || 0, beacon: 0 // the beacon write path is not carried over; every record is edge-written
  };
}

export default async (req, env) => {
  const KEY = env.STATS_KEY || '';
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get('k') !== KEY) return new Response('Key required.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  // Steward actions (added Oct 18 2026): the human self-report's
  // pause — this site has no steward route of its own, so its one
  // key-gated route carries the action, in the Garden steward
  // route's shape. POST { action: 'human-pause' | 'human-resume' }.
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return new Response(JSON.stringify({ error: 'Body must be JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json' } }); }
    if (body.action === 'human-pause' || body.action === 'human-resume') {
      await setHumanPaused(env, body.action === 'human-pause', 'stats-route');
      return new Response(JSON.stringify({ ok: true, human_paused: body.action === 'human-pause' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // The render claim's pause (added Oct 18 2026, lens spec B-d):
    // the second gate layer for the render endpoint, beside
    // RENDER_OPEN, in the same shape. POST { action: 'render-pause'
    // | 'render-resume' }.
    if (body.action === 'render-pause' || body.action === 'render-resume') {
      await setRenderPaused(env, body.action === 'render-pause', 'stats-route');
      return new Response(JSON.stringify({ ok: true, render_paused: body.action === 'render-pause' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'Unknown action.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  let loaded;
  try { loaded = await loadVisits(env); }
  catch (e) { return new Response('Storage read failed. Request records are also in the Worker logs (search VISIT).', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  const recs = loaded.recent; // newest first, at most 50 — display list
  const agg = aggregate(loaded.a);
  const asOf = new Date().toISOString();
  const arrivals = await loadArrivals(env);
  const humans = await humanTotal(env).catch(() => null);
  const attempts = await attemptStats(env).catch(() => null);
  const renders = await renderStats(env).catch(() => null);

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({
      arrivals_on_record: arrivals, humans_self_reported: humans, api_attempts: attempts, render_claims: renders,
      truncated_dims: agg.truncatedDims,
      ...agg, visits: visitsBlock(agg, asOf), recent: recs
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const agentClaimed = (agg.byClass && agg.byClass['agent-claimed']) || 0;
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Bay Area Swarm Warning — live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += '<h2>Bay Area Swarm Warning — live dashboard</h2>';
  html += '<p>Refreshed ' + esc(asOf) + ' (auto-refresh 60s).</p>';

  // ---- Block A: the record ----
  html += '<h3>The record</h3>';
  html += '<p>Verified agent arrivals on record: <strong>' + (arrivals === null ? 'unavailable' : arrivals) + '</strong> — the Garden&rsquo;s record, shown as a labelled reference; this site keeps no ledger of its own.</p>';
  html += '<p>Humans, self-reported: <strong>' + (humans === null ? 'unavailable' : humans) + '</strong> (a claim) — this site&rsquo;s own button presses.</p>';
  html += '<h4>The Garden&rsquo;s record surfaces — structural labels, not figures</h4><ul>' +
    '<li>Signals: No signal tier on this site — not a measured zero.</li>' +
    '<li>Ledger entries: no ledger on this site — the ledger is the Garden&rsquo;s.</li>' +
    '<li>Submissions: no intake on this site — submissions are the Garden&rsquo;s.</li>' +
    '<li>Visitors&rsquo; Book: no visitors&rsquo; book on this site — the book is the Garden&rsquo;s.</li></ul>';

  // ---- Block B: visits (full-dataset aggregates) ----
  html += '<h3>Requests — ' + agg.fetchesTotal + ' HTTP fetches · ' + agg.redirectsTotal + ' redirect responses (' + agg.total + ' recorded in all)</h3>';
  html += '<p>' + BASIS + ' · as of ' + esc(asOf) + '. All records edge-written. The tables below cover all recorded requests, redirect legs included, except the two split tables directly under this line. Everything below is requests, not arrivals.</p>';
  html += '<p>Human/automation reads are classifications by claimed user-agent (single-source taxonomy) plus edge bot signals — a stated basis, not a certainty.</p>';
  html += '<h4>HTTP fetches by claimed class</h4>' + countTable(esc, sortedPairs(agg.fetchesByClass), agg.fetchesTotal);
  html += '<h4>Redirect responses by claimed class</h4>' + countTable(esc, sortedPairs(agg.redirectsByClass), agg.redirectsTotal);
  html += '<h4>Requests by claimed class (all recorded, redirects included)</h4>' + countTable(esc, sortedPairs(agg.byClass), agg.total);
  html += '<p>Labels describe what each request&rsquo;s user-agent claims. A claim is not a verification.</p>';
  html += '<h4>Agent-claimed requests, by purpose</h4>' + countTable(esc, sortedPairs(agg.byPurpose), agentClaimed);
  html += '<p>Purpose era (Oct 19, 2026, W4): purposes are frozen at write time. Records written before the split carry &lsquo;other&rsquo;; from that deployment the same names carry &lsquo;mixed&rsquo; (the operator documents several purposes) or &lsquo;undeclared&rsquo; (none documented). The eras print side by side and are never merged.</p>';
  html += '<h4>Claimed crawlers by name (top 10)</h4>' + countTable(esc, sortedPairs(agg.crawlersClaimed.by_name), agg.total);
  html += '<h4>Claimed fetchers by name (top 10)</h4>' + countTable(esc, sortedPairs(agg.fetchersClaimed.by_name), agg.total);
  html += '<p>Names are read from the user-agent strings through the shared claimed-bot dictionary — claims, as announced by the requesting software itself.</p>';
  html += '<h4>Behaviour labels (private working labels, computed from paths)</h4>' + countTable(esc, sortedPairs(agg.byBehaviour), agg.total);
  html += '<h4>Response status totals</h4>' + countTable(esc, sortedPairs(agg.byStatus), agg.total);
  html += '<h4>Named events</h4>' + countTable(esc, sortedPairs(agg.byEvent), agg.total);
  html += '<h4>Top pages</h4>' + countTable(esc, agg.topPaths, agg.total);
  html += '<h4>Agent-interest files</h4>' + countTable(esc, agg.interest, agg.total);
  html += '<p>Distinct paths read: <strong>' + agg.readDepth + '</strong>.</p>';
  html += '<h4>Requests by day</h4>' + countTable(esc, Object.entries(agg.byDay).sort(), agg.total);
  html += '<h4>Requests by country (top 12)</h4>' + countTable(esc, agg.topCountries, agg.total);
  html += '<p>Edge geography — a country is the network exit point, not the operator&rsquo;s home.</p>';
  html += '<h4>Top referrers</h4>' + referrerTableHtml(esc, agg.referrersGrouped, agg.total);
  html += '<h4>Address-range verdicts, by claimed name</h4>' + verdictTableHtml(esc, agg.byNameVerdict);
  html += '<h4>Distinct visitor digests, by day (Pacific)</h4>' + visitorDigestTableHtml(esc, agg.byVisitorDay);
  html += '<h4>Distinct visitor digests (epoch), by day (Pacific)</h4>' + visitorEpochTableHtml(esc, agg.byVisitorEpoch);

  // ---- Channel knocks (B-b read; W1 folds, Oct 19 2026) ----
  html += '<h3>Channel knocks — refused POST attempts</h3>';
  html += knocksBlockHtml(esc, attempts);

  // ---- Render-signalled (B-d read) ----
  html += '<h3>Render-signalled — pages reporting a render (claims)</h3>';
  html += '<p>A page&rsquo;s own script posts a claim to /api/v1/render-claim after the page renders; the claim is kept in this site&rsquo;s own table and published under the name &ldquo;render-signalled&rdquo;: evidence a browser executed the page. It is forgeable in principle — anyone can post one by hand — and it is never an arrival: it enters neither the request record, the counts, nor the ledger.</p>';
  if (renders === null) html += '<p>Unavailable.</p>';
  else if (!renders.total) html += '<p>None recorded yet.</p>';
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
