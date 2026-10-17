// Swarm Garden — first-party visit logger (ESM + @netlify/blobs)
// Records each request's time, page, referrer, country and user-agent,
// classified by what the user-agent CLAIMS to be. A user-agent is a claim,
// not a proof of identity: labels are agent-claimed / automation / browser / unknown.
// The taxonomy itself lives in lib/taxonomy.js — the single source.
// Requests arrive two ways: via=edge (relayed server-side by the request-log
// edge function — sees every fetch, including agents that run no JavaScript)
// and via=beacon (the legacy in-page snippet; kept for compatibility).
// Edge-relayed records also carry: the HTTP method and the response
// status the visitor actually got; md=1 when the request's Accept header
// explicitly preferred Markdown (the agent-framework tell computed by
// markdown-negotiation at the edge); ba='present' when Web Bot Auth
// signature headers were present (presence only — no verification); and
// the country forwarded from the EDGE context (context.geo of the
// original request), not the geo of this function's own invocation,
// which for relayed records is the relay's point of presence.
import { getStore } from '@netlify/blobs';
import { classify } from './lib/taxonomy.js';
export default async (req, context) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  let path = '/', ref = '', ua = '', via = 'beacon';
  let method = null, status = null, md = null, ba = null, geoForwarded = '';
  try {
    const b = await req.json();
    path = b.p || '/'; ref = b.r || '';
    if (typeof b.ua === 'string' && b.ua) ua = b.ua.slice(0, 400);
    if (b.via === 'edge') via = 'edge';
    if (typeof b.m === 'string') method = b.m.slice(0, 10);
    if (Number.isInteger(b.s)) status = b.s;
    if (b.md === 1 || b.md === 0) md = b.md;
    if (b.ba === 'present' || b.ba === 'absent') ba = b.ba;
    if (typeof b.geo === 'string' && b.geo) geoForwarded = b.geo.slice(0, 4);
  } catch (e) {}
  if (!ua) ua = req.headers.get('user-agent') || '';
  const { cls, purpose } = classify(ua);
  const record = {
    t: new Date().toISOString(),
    site: req.headers.get('host') || '',
    path, ref,
    country: geoForwarded || (context && context.geo && context.geo.country && context.geo.country.code) || req.headers.get('x-nf-country') || '',
    ua,
    cls,
    purpose,
    method, status, md, ba,
    via
  };
  try {
    const s = getStore('visits');
    const key = 'v-' + record.t.replace(/[:.]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    await s.setJSON(key, record);
    record.stored = 'blobs-sdk';
  } catch (e) { record.stored = 'sdk-error:' + (e && e.name ? e.name : 'unknown'); }
  console.log('VISIT ' + JSON.stringify(record));
  return new Response(null, { status: 204 });
};
