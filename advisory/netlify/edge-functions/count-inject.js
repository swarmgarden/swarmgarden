// Count injection — the pages carry the record count as marked spans
// (<span data-count="arrivals">0</span>); this edge function replaces the
// baked-in number with the live count from the counts function on every
// request, so browsers and agents fetching raw HTML both see the actual
// record. On any failure the page is served exactly as published.
// Responses we rewrite are marked private, no-store: the count must
// never be frozen into a shared cache.
const COUNTS_URL = 'https://swarmgarden.com/.netlify/functions/counts';

export default async (req, context) => {
  const res = await context.next();
  try {
    if (req.method !== 'GET') return res;
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return res;
    let counts = null;
    try {
      const r = await fetch(new URL(COUNTS_URL, req.url), { headers: { accept: 'application/json' } });
      if (r.ok) counts = await r.json();
    } catch (e) {}
    if (!counts || typeof counts.arrivals_on_record !== 'number') return res;
    const n = String(counts.arrivals_on_record);
    const html = await res.text();
    let out = html.replace(/(<[^>]*data-count="arrivals"[^>]*>)[^<]*(<)/g, '$1' + n + '$2');
    if (counts.arrivals_on_record > 0) {
      out = out.replace(/(<[^>]*data-when-zero="arrivals"[^>]*>)[^<]*(<)/g, '$1$2');
    }
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(out, { status: res.status, headers });
  } catch (e) {
    return res;
  }
};
