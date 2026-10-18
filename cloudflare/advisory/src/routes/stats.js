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
import { readRecentVisits } from '../../../shared/visits.mjs';
import { behaviourLabel, INTEREST } from '../../../shared/behaviour.mjs';
import { humanTotal, setHumanPaused } from '../lib/human.js';

async function loadVisits(env) {
  const recs = await readRecentVisits(env, 1500); // newest first
  return recs.sort((a, b) => (a.t < b.t ? -1 : 1));
}

async function loadArrivals(env) {
  try {
    const origin = env.COUNTS_ORIGIN || 'https://swarmgarden.com';
    const r = await fetch(origin + '/.netlify/functions/counts');
    if (r.ok) { const j = await r.json(); if (typeof j.arrivals_on_record === 'number') return j.arrivals_on_record; }
  } catch (e) {}
  return null;
}

function aggregate(recs) {
  const byClass = {}, byDay = {}, byPath = {}, interest = {}, byPurpose = {}, byBehaviour = {}, byStatus = {}, byCountry = {}, byRef = {}, byEvent = {};
  let edge = 0;
  for (const r of recs) {
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    if (r.purpose) byPurpose[r.purpose] = (byPurpose[r.purpose] || 0) + 1;
    const bl = behaviourLabel(r); byBehaviour[bl] = (byBehaviour[bl] || 0) + 1;
    if (Number.isInteger(r.status)) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const d = (r.t || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (r.country) byCountry[r.country] = (byCountry[r.country] || 0) + 1;
    if (r.ref) { try { const h = new URL(r.ref).host; if (h) byRef[h] = (byRef[h] || 0) + 1; } catch (e) {} }
    if (r.event) byEvent[r.event] = (byEvent[r.event] || 0) + 1;
    if (r.via === 'edge') edge++;
    if (INTEREST.some(s => (r.path || '').includes(s))) interest[r.path] = (interest[r.path] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    total: recs.length, byClass, byPurpose, byBehaviour, byStatus, byDay,
    topPaths: top(byPath, 12), interest: top(interest, 12),
    topCountries: top(byCountry, 12), topReferrers: top(byRef, 12), byEvent,
    edge, beacon: 0 // the beacon write path is not carried over; every record is edge-written
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
    return new Response(JSON.stringify({ error: 'Unknown action.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  let recs;
  try { recs = await loadVisits(env); }
  catch (e) { return new Response('Storage read failed. Visit records are also in the Worker logs (search VISIT).', { status: 200, headers: { 'Content-Type': 'text/plain' } }); }
  const agg = aggregate(recs);
  const arrivals = await loadArrivals(env);
  const humans = await humanTotal(env).catch(() => null);

  if (url.searchParams.get('format') === 'json') {
    return new Response(JSON.stringify({ arrivals_on_record: arrivals, humans_self_reported: humans, ...agg, recent: recs.slice(-50).reverse() }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const list = (pairs) => pairs.map(([k, v]) => '<li>' + esc(k) + ': ' + v + '</li>').join('');
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Bay Area Swarm Warning — live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += '<h2>Bay Area Swarm Warning — live dashboard</h2>';
  html += '<p>Refreshed ' + esc(new Date().toISOString()) + ' (auto-refresh 60s). Arrivals on record: <strong>' + (arrivals === null ? 'unavailable' : arrivals) + '</strong> — the record, from the ledger. Everything below is requests, not arrivals.</p>';
  html += '<p>Humans, self-reported (this site&rsquo;s own button presses): <strong>' + (humans === null ? 'unavailable' : humans) + '</strong> — a claim-tier count; it sorts claims and verifies no one.</p>';
  html += '<h3>Requests — claimed class totals (' + agg.total + ' total; all edge-written)</h3><ul>' + list(Object.entries(agg.byClass)) + '</ul>';
  html += '<p>Human/automation reads are classifications by claimed user-agent (single-source taxonomy) plus edge bot signals — a stated basis, not a certainty.</p>';
  if (Object.keys(agg.byPurpose).length) html += '<h3>Agent-claimed, by purpose</h3><ul>' + list(Object.entries(agg.byPurpose)) + '</ul>';
  html += '<h3>Behaviour labels (computed over held records)</h3><ul>' + list(Object.entries(agg.byBehaviour)) + '</ul>';
  if (Object.keys(agg.byStatus).length) html += '<h3>Response status totals</h3><ul>' + list(Object.entries(agg.byStatus)) + '</ul>';
  if (Object.keys(agg.byEvent).length) html += '<h3>Named events</h3><ul>' + list(Object.entries(agg.byEvent)) + '</ul>';
  html += '<h3>Agent-interest files</h3>' + (agg.interest.length ? '<ul>' + list(agg.interest) + '</ul>' : '<p>None yet.</p>');
  html += '<h3>Top pages</h3><ul>' + list(agg.topPaths) + '</ul>';
  html += '<h3>Top countries (edge geo)</h3>' + (agg.topCountries.length ? '<ul>' + list(agg.topCountries) + '</ul>' : '<p>None yet.</p>');
  html += '<h3>Top referrers</h3>' + (agg.topReferrers.length ? '<ul>' + list(agg.topReferrers) + '</ul>' : '<p>None yet.</p>');
  html += '<h3>By day</h3><ul>' + list(Object.entries(agg.byDay).sort()) + '</ul>';
  html += '<h3>Most recent 50 requests</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>purpose</th><th>behaviour</th><th>status</th><th>event</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs.slice(-50).reverse()) html += '<tr><td>' + esc(r.t) + '</td><td>' + esc(r.cls) + '</td><td>' + esc(r.purpose || '—') + '</td><td>' + esc(behaviourLabel(r)) + '</td><td>' + esc(r.status === null || r.status === undefined ? '—' : r.status) + '</td><td>' + esc(r.event || 'pageview') + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(r.ua) + '</td></tr>';
  html += '</table><p>Labels describe what each request\u2019s user-agent claims. A claim is not a verification.</p></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
};
