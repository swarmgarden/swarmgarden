// Swarm Garden — /changed: what the Garden has published since a date.
// Bound by netlify.toml rewrite: /changed -> /.netlify/functions/changed.
// The protocol publishes this page's shape: briefs opened or closed,
// outcomes posted, questions answered — drawn from the public ledger
// (metadata only) and the brief store. Read-only; live whether intake
// is open or closed, because it reports the record, it does not add to
// it. Usage: /changed?since=YYYY-MM-DD (default: the last 30 days).
// ?format=json (or an application/json Accept) returns the same facts
// as data.
import { getStore } from '@netlify/blobs';
import { JSON_HEADERS, esc, clientIP, checkRateOK } from './lib/garden.js';

async function loadChanges(sinceISO) {
  const out = [];
  try {
    const s = getStore('ledger');
    const { blobs } = await s.list();
    for (const b of blobs || []) {
      try {
        const e = await s.get(b.key, { type: 'json' });
        if (e && e.ts >= sinceISO) out.push({ at: e.ts, kind: e.kind, text: e.summary, receipt: e.receipt || null });
      } catch (e) {}
    }
  } catch (e) {}
  try {
    const s = getStore('briefs');
    const { blobs } = await s.list();
    for (const b of blobs || []) {
      try {
        const br = await s.get(b.key, { type: 'json' });
        if (br && br.updated_at && br.updated_at >= sinceISO) {
          out.push({ at: br.updated_at, kind: 'brief', text: 'Brief ' + br.brief_id + ' (version ' + br.version + ') is ' + br.state + (br.closes_at ? '; closes ' + br.closes_at : '') + '.', receipt: null });
        }
      } catch (e) {}
    }
  } catch (e) {}
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export default async (req) => {
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: JSON_HEADERS });
  if (!(await checkRateOK(clientIP(req)))) {
    return new Response(JSON.stringify({ error: 'Check rate exceeded.' }), { status: 429, headers: JSON_HEADERS });
  }
  const url = new URL(req.url);
  let since = url.searchParams.get('since') || '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const sinceISO = since.slice(0, 10) + 'T00:00:00.000Z';
  const changes = await loadChanges(sinceISO);
  const accept = req.headers.get('accept') || '';
  if (url.searchParams.get('format') === 'json' || accept.includes('application/json')) {
    return new Response(JSON.stringify({ format: 'garden-changed/v1', since, changes }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (accept.includes('text/html')) {
    const items = changes.length
      ? '<ul>' + changes.map(c => '<li>' + esc(c.at.slice(0, 10)) + ' — ' + esc(c.kind) + ': ' + esc(c.text) + '</li>').join('') + '</ul>'
      : '<p>Nothing has been published since ' + esc(since) + '.</p>';
    return new Response('<!DOCTYPE html><meta charset="utf-8"><title>Changed — The Swarm Garden</title>'
      + '<body style="font-family:monospace;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6">'
      + '<h1>What changed since ' + esc(since) + '</h1>' + items
      + '<p>Drawn from the public record. Name another date: /changed?since=YYYY-MM-DD.</p></body>',
      { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }
  const lines = ['SWARM GARDEN — WHAT CHANGED SINCE ' + since];
  if (!changes.length) lines.push('Nothing has been published since ' + since + '.');
  for (const c of changes) lines.push(c.at.slice(0, 10) + ' — ' + c.kind + ': ' + c.text);
  lines.push('Drawn from the public record. Name another date: /changed?since=YYYY-MM-DD.');
  return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
};
