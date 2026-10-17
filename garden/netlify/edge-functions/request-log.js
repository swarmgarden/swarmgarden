// Request log — server-side visit recording at the edge.
// Relays every content request to the visit function so the log sees
// fetches that run no JavaScript (most agent and crawler traffic), not
// just browser page loads. Logging must never break a page: every failure
// is swallowed and the original response is returned untouched.
//
// Forwarded with each record (Oct 17 classification bundle):
//   m   — the HTTP method (this relay logs GET/HEAD page fetches);
//   s   — the response status the visitor actually got, so a scanner's
//         404 probe and a genuine 200 read no longer share a shape;
//   md  — 1 when the Accept header explicitly prefers Markdown. This is
//         the same computation markdown-negotiation.js performs; it is
//         duplicated here deliberately (edge functions are standalone)
//         and the two copies must be kept semantically identical;
//   ba  — 'present' when Web Bot Auth signature headers ride the
//         request (Signature / Signature-Input / Signature-Agent).
//         Presence only — nothing here verifies a signature;
//   geo — the country code from THIS request's edge context, so the
//         visit function records the visitor's geography rather than
//         the relay's point of presence.
const SKIP_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.css', '.js', '.map', '.woff', '.woff2', '.mp4', '.zip'];

function qFor(entries, type, subtype) {
  let exact = null, typeWild = null, allWild = null;
  for (const [t, s, q] of entries) {
    if (t === type && s === subtype) exact = q;
    else if (t === type && s === '*') typeWild = q;
    else if (t === '*' && s === '*') allWild = q;
  }
  if (exact !== null) return { q: exact, explicit: true };
  if (typeWild !== null) return { q: typeWild, explicit: false };
  if (allWild !== null) return { q: allWild, explicit: false };
  return { q: 0, explicit: false };
}
function prefersMarkdown(accept) {
  if (!accept) return false;
  const entries = accept.split(',').map((part) => {
    const [mime, ...params] = part.trim().split(';');
    const [t, s] = (mime || '').toLowerCase().split('/');
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') q = parseFloat(v) || 0;
    }
    return [t || '', s || '', q];
  });
  const md = qFor(entries, 'text', 'markdown');
  if (md.q <= 0) return false;
  if (!md.explicit) return false;
  const htmlQ = Math.max(qFor(entries, 'text', 'html').q, qFor(entries, 'application', 'xhtml+xml').q);
  return md.q >= htmlQ;
}

export default async (req, context) => {
  const res = await context.next();
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return res;
    const url = new URL(req.url);
    const p = url.pathname;
    if (p.startsWith('/.netlify/')) return res;
    if (SKIP_EXT.some(e => p.endsWith(e))) return res;
    const payload = JSON.stringify({
      p,
      r: req.headers.get('referer') || '',
      ua: req.headers.get('user-agent') || '',
      m: req.method,
      s: res.status,
      md: prefersMarkdown(req.headers.get('accept')) ? 1 : 0,
      ba: (req.headers.get('signature') || req.headers.get('signature-input') || req.headers.get('signature-agent')) ? 'present' : 'absent',
      geo: (context && context.geo && context.geo.country && context.geo.country.code) || '',
      via: 'edge'
    });
    const relay = fetch(new URL('/.netlify/functions/visit', req.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    }).catch(() => {});
    if (context && typeof context.waitUntil === 'function') context.waitUntil(relay);
    else await relay;
  } catch (e) {}
  return res;
};
