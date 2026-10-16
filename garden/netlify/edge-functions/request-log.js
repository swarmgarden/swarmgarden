// Request log — server-side visit recording at the edge.
// Relays every content request to the visit function so the log sees
// fetches that run no JavaScript (most agent and crawler traffic), not
// just browser page loads. Logging must never break a page: every failure
// is swallowed and the original response is returned untouched.
const SKIP_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.css', '.js', '.map', '.woff', '.woff2', '.mp4', '.zip'];

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
