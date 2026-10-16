// Swarm Garden — visit log reader (rough analytics v3, ESM + @netlify/blobs)
// Gated by a key in the query string. Aggregates the stored visit records:
// totals by claimed class, by day, and the most recent visits with their raw
// user-agents — so a human reads claims, not conclusions.
import { getStore } from '@netlify/blobs';
const KEY = process.env.STATS_KEY || '';
async function load() {
  try {
    const s = getStore('visits');
    const { blobs } = await s.list();
    const keys = (blobs || []).map(b => b.key).slice(-800);
    const out = [];
    for (const k of keys) {
      try { const r = await s.get(k, { type: 'json' }); if (r) out.push(r); } catch (e) {}
    }
    return { records: out };
  } catch (e) {
    return { error: 'Storage read failed (' + (e && e.name ? e.name : 'error') + '). Visit records are also in the function logs (search VISIT).' };
  }
}
export default async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get('k') !== KEY) return new Response('Key required.', { status: 403, headers: { 'Content-Type': 'text/plain' } });
  const res = await load();
  if (res.error) return new Response(res.error, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  const recs = res.records.sort((a, b) => (a.t < b.t ? -1 : 1));
  const byCls = {}, byDay = {};
  for (const r of recs) { byCls[r.cls] = (byCls[r.cls] || 0) + 1; const d = (r.t || '').slice(0, 10); byDay[d] = (byDay[d] || 0) + 1; }
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let html = '<!DOCTYPE html><meta charset="utf-8"><title>Visit log</title><body style="font-family:monospace;max-width:900px;margin:24px auto;padding:0 16px">';
  html += '<h2>Visits — claimed class totals</h2><p>Total records: ' + recs.length + '</p><ul>';
  for (const k of Object.keys(byCls)) html += '<li>' + esc(k) + ': ' + byCls[k] + '</li>';
  html += '</ul><h2>By day</h2><ul>';
  for (const d of Object.keys(byDay).sort()) html += '<li>' + esc(d) + ': ' + byDay[d] + '</li>';
  html += '</ul><h2>Most recent 50</h2><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>site</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs.slice(-50).reverse()) html += '<tr><td>' + esc(r.t) + '</td><td>' + esc(r.cls) + '</td><td>' + esc(r.site) + '</td><td>' + esc(r.path) + '</td><td>' + esc(r.country) + '</td><td>' + esc(r.ref) + '</td><td>' + esc(r.ua) + '</td></tr>';
  html += '</table><p>Labels describe what each visit\u2019s user-agent claims. A claim is not a verification.</p></body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
};
