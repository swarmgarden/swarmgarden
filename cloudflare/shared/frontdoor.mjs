// Swarm Garden — the front door, shared by both Workers. Replaces the
// three Netlify edge functions (markdown-negotiation, count-inject,
// request-log) with in-Worker logic (migration plan inventory #2–#4):
//
//   1. Markdown negotiation — when a GET/HEAD for an HTML page genuinely
//      prefers Markdown (Accept computation identical to the Netlify
//      edge function), serve the page's Markdown twin at the canonical
//      URL, marked no-store.
//   2. Count injection — HTML page responses get the live arrivals
//      count spliced into <span data-count="arrivals"> spans (and
//      data-when-zero spans emptied once arrivals > 0), via
//      HTMLRewriter (plan inventory #3). The count is read in-process
//      (a callback), so the Netlify self-fetch disappears. When the
//      caller also passes getUpdated, the counts payload's `updated`
//      timestamp is spliced into <span data-count="updated"> spans —
//      the page footer's "Record as of" line, so no hand-maintained
//      date can go stale there.
//   3. Request logging — every GET/HEAD content request is written as
//      a visit record BY THE EDGE (the only writer; the unauthenticated
//      beacon write path is not carried over — plan Decision 7). The
//      record carries the fields the classification plumbing requires:
//      method, the response status actually served, the Markdown-
//      preference flag, Web Bot Auth header PRESENCE (no verification
//      here), and the visitor's geography + network from the edge
//      (request.cf on the original request — no relay, so no PoP
//      substitution): country, region, ASN and AS organisation.
//      Network facts only — a raw IP address is never recorded.
//
// Deliberate differences from the Netlify chain, recorded in
// PORT-NOTES.md: negotiated-Markdown responses are logged too (the
// Netlify chain order meant they were not), and function-style routes
// answered by the Worker are logged under their published path exactly
// as the Netlify edge saw them.
import { classify } from './taxonomy.mjs';
import { writeVisit } from './visits.mjs';

const SKIP_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.css', '.js', '.map', '.woff', '.woff2', '.mp4', '.zip'];
export const LINK_HEADER = '</llms.txt>; rel="alternate"; type="text/markdown", </sitemap.xml>; rel="sitemap"; type="application/xml", </.well-known/agent-skills/index.json>; rel="agent-skills"';

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

export function prefersMarkdown(accept) {
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
  if (!md.explicit) return false; // a wildcard mention is not a preference
  const htmlQ = Math.max(qFor(entries, 'text', 'html').q, qFor(entries, 'application', 'xhtml+xml').q);
  return md.q >= htmlQ; // ties go to Markdown: naming it signals it can be used
}

function twinPath(pathname) {
  if (pathname === '/' || pathname === '/index.html') return '/index.md';
  if (pathname.endsWith('.html')) return pathname.slice(0, -5) + '.md';
  if (!pathname.includes('.')) return pathname.replace(/\/$/, '') + '.md';
  return null;
}

// Bot-auth verdict: on Cloudflare, for signers registered in the
// Verified Bots program, the edge verifies the RFC 9421 signature and
// exposes request.cf.botManagement.verifiedBot; where that is present
// we record the verdict, otherwise header PRESENCE only (plan,
// "Capabilities: Web Bot Auth: from presence to verdict"). The field
// keeps the Netlify shape ('present'/'absent') and adds 'verified' /
// 'present-invalid' only when the platform actually reports them —
// STAGING-VERIFY which cf fields our tier exposes.
export function botAuthState(req) {
  const present = !!(req.headers.get('signature') || req.headers.get('signature-input') || req.headers.get('signature-agent'));
  const bm = (req.cf && req.cf.botManagement) || null;
  if (bm && bm.verifiedBot) return 'verified';
  // No honest 'present-invalid' mapping is known at this tier yet —
  // inventing one from bot-score heuristics would mislabel the record.
  // PORT-NOTES / staging-verify: confirm what the edge exposes.
  return present ? 'present' : 'absent';
}

export function buildVisitRecord(req, res, siteHost, event) {
  const url = new URL(req.url);
  const ua = (req.headers.get('user-agent') || '').slice(0, 400);
  const { cls, purpose } = classify(ua);
  return {
    t: new Date().toISOString(),
    site: siteHost,
    path: url.pathname,
    ref: req.headers.get('referer') || '',
    country: (req.cf && req.cf.country) || '',
    region: (req.cf && (req.cf.region || req.cf.regionCode)) || '',
    asn: (req.cf && req.cf.asn) || '',
    asOrganization: (req.cf && req.cf.asOrganization) || '',
    ua,
    cls,
    purpose,
    method: req.method,
    status: res.status,
    md: prefersMarkdown(req.headers.get('accept')) ? 1 : 0,
    ba: botAuthState(req),
    via: 'edge',
    event: event || 'pageview'
  };
}

export function shouldLog(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = new URL(req.url).pathname;
  if (p.startsWith('/.netlify/')) return false;
  if (SKIP_EXT.some(e => p.endsWith(e))) return false;
  return true;
}

// Named events (advisory amendment: actions, not just loads). Derived
// from the path at write time — page loads stay 'pageview'; the two
// named surfaces are labelled so "what did people do" is answerable.
// Outbound-click events would need a redirect shim in the published
// pages, which is outside the Phase 1 port (assets move as-is) —
// PORT-NOTES carries it as a follow-up.
export function eventForPath(pathname) {
  if (pathname === '/dashboard.html') return 'arrival-board-view';
  if (pathname.startsWith('/.netlify/functions/stats')) return 'dashboard-use';
  return 'pageview';
}

// Serve a request's content: markdown negotiation first (for plain
// page requests), then the static asset. `respond` is the caller's
// fallback for non-asset requests (function routes never reach here).
export async function servePage(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const negotiable = (req.method === 'GET' || req.method === 'HEAD') &&
    !p.startsWith('/.netlify/') && !p.startsWith('/.well-known/') &&
    !/\.(md|txt|xml|json|svg|jpg|jpeg|png|webp|gif|ico|css|js|map)$/i.test(p);
  if (negotiable && prefersMarkdown(req.headers.get('accept'))) {
    const twin = twinPath(p);
    if (twin) {
      const twinRes = await env.ASSETS.fetch(new Request(new URL(twin, url), { method: 'GET' }));
      if (twinRes.ok) {
        const body = await twinRes.text();
        const headers = new Headers();
        headers.set('Content-Type', 'text/markdown; charset=utf-8');
        headers.set('Vary', 'Accept');
        headers.set('Cache-Control', 'private, no-store');
        headers.set('X-Markdown-Tokens', String(Math.ceil(body.length / 4)));
        headers.set('Link', '<' + twin + '>; rel="alternate"; type="text/markdown"');
        if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
        return new Response(body, { status: 200, headers });
      }
    }
  }
  return env.ASSETS.fetch(req);
}

// Count injection over an HTML response. getArrivals() returns the
// live number (or null on failure — the page is then served exactly as
// published, as on Netlify). getUpdated() is optional: when supplied
// and it returns a timestamp string, that string replaces the content
// of any <span data-count="updated"> (the footer's as-of line).
// getVisits() is likewise optional: when supplied and it returns a
// number, that number (the counts payload's visits_total) replaces
// the content of any <span data-count="visits">.
// getWindow() is likewise optional (added Oct 17 2026 with the
// counting window): when supplied and it returns a string, that
// string replaces the content of any <span data-count="window"> —
// the Garden homepage's "Counting since" row, so the age of the
// record is spliced in live beside the total it describes.
// getCounterBlock() is optional (added Oct 17 2026 for the advisory
// homepage counter): when supplied and it returns an HTML string,
// that string replaces the inner content of any [data-counter-block]
// element. The published page carries the no-numbers fallback inside
// that element, so a null return (counts unavailable) leaves the
// fallback standing — numbers are never zero-filled or reused stale.
export async function injectCounts(res, getArrivals, getUpdated, getVisits, getCounterBlock, getWindow) {
  try {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return res;
    const n = await getArrivals();
    if (typeof n !== 'number') return res;
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.delete('content-length');
    headers.delete('etag');
    const rw = new HTMLRewriter()
      .on('span[data-count="arrivals"]', {
        element(el) { el.setInnerContent(String(n)); }
      })
      .on('span[data-when-zero="arrivals"]', {
        element(el) { if (n > 0) el.setInnerContent(''); }
      });
    if (typeof getCounterBlock === 'function') {
      const block = await getCounterBlock();
      if (typeof block === 'string' && block) {
        rw.on('[data-counter-block]', {
          element(el) { el.setInnerContent(block, { html: true }); }
        });
      }
    }
    if (typeof getUpdated === 'function') {
      const u = await getUpdated();
      if (typeof u === 'string' && u) {
        rw.on('span[data-count="updated"]', {
          element(el) { el.setInnerContent(u); }
        });
      }
    }
    if (typeof getVisits === 'function') {
      const v = await getVisits();
      if (typeof v === 'number') {
        rw.on('span[data-count="visits"]', {
          element(el) { el.setInnerContent(String(v)); }
        });
      }
    }
    if (typeof getWindow === 'function') {
      const w = await getWindow();
      if (typeof w === 'string' && w) {
        rw.on('span[data-count="window"]', {
          element(el) { el.setInnerContent(w); }
        });
      }
    }
    return rw.transform(new Response(res.body, { status: res.status, headers }));
  } catch (e) {
    return res;
  }
}

// Counter text injection for Markdown responses (added Oct 17 2026,
// the advisory homepage twin): a page whose Markdown twin carries the
// COUNTER_MARKER line gets that line replaced, at serve time, with
// the text getCounterText() returns. The callback owns the fallback
// wording too (it returns the see-the-record line when counts are
// unavailable), so the marker itself never reaches a reader.
export const COUNTER_MARKER = '<!-- live-counter -->';
export async function injectCounterText(res, getCounterText) {
  try {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('text/markdown')) return res;
    const text = await res.text();
    if (!text.includes(COUNTER_MARKER)) return new Response(text, { status: res.status, headers: res.headers });
    const replacement = await getCounterText();
    const body = text.split(COUNTER_MARKER).join(typeof replacement === 'string' ? replacement : '');
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'private, no-store');
    headers.delete('content-length');
    headers.delete('etag');
    return new Response(body, { status: res.status, headers });
  } catch (e) {
    return res;
  }
}

// The full front-door wrap for page (non-route) responses: discovery
// Link header, count injection for GET HTML, and the edge visit write
// via waitUntil. Returns the response to send.
export async function frontDoor(req, env, ctx, res, opts) {
  let out = res;
  const url = new URL(req.url);
  if (!out.headers.get('link') && !url.pathname.startsWith('/.well-known/')) {
    const headers = new Headers(out.headers);
    headers.set('Link', LINK_HEADER);
    out = new Response(out.body, { status: out.status, headers });
  }
  if (req.method === 'GET' && opts && opts.getArrivals) {
    out = await injectCounts(out, opts.getArrivals, opts.getUpdated, opts.getVisits, opts.getCounterBlock, opts.getWindow);
  }
  if (req.method === 'GET' && opts && typeof opts.getCounterText === 'function') {
    out = await injectCounterText(out, opts.getCounterText);
  }
  if (shouldLog(req)) {
    const record = buildVisitRecord(req, out, opts.siteHost, eventForPath(url.pathname));
    const write = writeVisit(env, record)
      .then(() => { try { console.log('VISIT ' + JSON.stringify(record)); } catch (e) {} })
      .catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }
  return out;
}
