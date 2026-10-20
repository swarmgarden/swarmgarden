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
//   3. Request logging — GET/HEAD page requests and GET/HEAD reads on
//      the pretty published paths (/changed, /utilities/*,
//      /api/v1/receipts*, /receipts/*, GET /api/v1/notes) are written
//      as visit records BY THE EDGE (the only writer; the
//      unauthenticated beacon write path is not carried over — plan
//      Decision 7). What does NOT log, deliberately: the legacy
//      /.netlify/functions/* addresses and every key-gated steward
//      surface (the stats dashboards, the steward and guestbook
//      routes) — steward traffic stays out of the visit record.
//      POSTs are never visit records; refused POSTs to the published
//      channels are counted separately, in D1 (shared/attempts.mjs).
//      The record carries the fields the classification plumbing
//      requires: method, the response status actually served, the
//      Markdown-preference flag, Web Bot Auth header PRESENCE (no
//      verification here), the visitor's geography + network from
//      the edge (request.cf on the original request — no relay, so
//      no PoP substitution): country, region, ASN and AS
//      organisation — and, since Oct 18 2026, the claimed-bot name
//      and its write-time address-range verdict (shared/ranges.mjs).
//      Network facts only — a raw IP address is never recorded; the
//      verdict computation reads cf-connecting-ip transiently and
//      stores only the verdict and the list version. Records also
//      carry, since Oct 18 2026 (lens spec B-e), the rotating-salt
//      visitor digest (shared/visitor.mjs): 16 hex chars of an HMAC
//      over (UTC date, cf-connecting-ip, user-agent) under a
//      per-site secret. The address is an input to a one-way
//      function and is discarded; the digest links a visitor's
//      requests within one day and nothing across days. Since
//      Oct 19 2026 (W6) records also carry the composite write-
//      time string (wt): the range verdict, the rDNS origin
//      category + claimed-operator match verdict, cross-range
//      membership, our own Web Bot Auth validity facts, and the
//      arriving stack facts — verdicts and facts computed while
//      the address is in hand; the address itself, any hostname,
//      and any key material are discarded (see writeTimeFields).
//   4. Asset-companion logging (Oct 18 2026, lens spec B-a) — GET/HEAD
//      requests for the companion set (.css/.js/.ico: the stylesheet,
//      script and favicon a rendered page pulls) write a companion
//      record to a SEPARATE dataset per site (writeAssetVisit), never
//      to the visit dataset, so page totals cannot move. A companion
//      record's `ref` is the page that pulled the asset — the join
//      key for the render test, computed at query time, never frozen.
//
// Deliberate differences from the Netlify chain, recorded in
// PORT-NOTES.md: negotiated-Markdown responses are logged too (the
// Netlify chain order meant they were not), and function-style routes
// answered by the Worker are logged under their published PRETTY path
// (the legacy /.netlify/functions/* spellings of the same routes are
// not logged — see point 3).
import { classify } from './taxonomy.mjs';
import { claimedBot } from './behaviour.mjs';
import { verdictFor, crossRangeMembership } from './ranges.mjs';
import { lookupNetworkOrigin, rdnsVerdictFor } from './rdns.mjs';
import { verifyWebBotAuth } from './wba.mjs';
import { visitorForRequest, sourceDigestForRequest } from './visitor.mjs';
import { writeVisit, writeAssetVisit } from './visits.mjs';

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

// Bot-auth presence: header PRESENCE only in this field. (The
// platform route to a verdict is closed on this account: a probe
// Worker on Oct 18 2026 established that request.cf carries NO
// botManagement object at all on the Workers Paid tier — it is an
// Enterprise add-on — so verifiedBot / bot score are dark here and
// no purchase was made. Signature VALIDITY is therefore computed
// in-Worker at write time by shared/wba.mjs and recorded in the
// composite write-time string, labelled our own computation.)
export function botAuthState(req) {
  const present = !!(req.headers.get('signature') || req.headers.get('signature-input') || req.headers.get('signature-agent'));
  const bm = (req.cf && req.cf.botManagement) || null;
  if (bm && bm.verifiedBot) return 'verified';
  // No honest 'present-invalid' mapping is known at this tier yet —
  // inventing one from bot-score heuristics would mislabel the record.
  // PORT-NOTES / staging-verify: confirm what the edge exposes.
  return present ? 'present' : 'absent';
}

// The Signature-Agent hostname (added Oct 18 2026, ASAP Item 5
// stage ii): the header names the signer's public key-directory
// host — a pointer the signer publishes about ITSELF (RFC 9421 /
// Web Bot Auth). Only the hostname is stored: it is a public
// claim, not an address, not a credential, and it verifies
// nothing by itself. '' when the header is absent or carries no
// parseable host. The full header value is never stored.
export function sigAgentHost(req) {
  const raw = req.headers.get('signature-agent') || '';
  if (!raw) return '';
  const first = raw.split(',')[0].trim().replace(/^"|"$/g, '');
  try {
    const host = new URL(first).hostname.toLowerCase();
    return host && host.length <= 253 ? host : '';
  } catch (e) {
    return '';
  }
}

// The claim fields (Oct 18 2026, lens spec A2): the canonical claimed
// name from the shared dictionary, read at write time, and — when a
// name is claimed — the address-range verdict computed against the
// operator's bundled published ranges. The address is read ONLY from
// cf-connecting-ip (the clientIP() x-forwarded-for fallback is
// client-spoofable and must never feed a verdict), used transiently
// in this call, and never stored, digested, or logged. Records with
// no claimed name carry cname '', ipverdict 'not-claimed', rangever ''.
function claimFields(req, ua) {
  const bot = claimedBot(ua);
  if (!bot) return { cname: '', ipverdict: 'not-claimed', rangever: '' };
  const v = verdictFor(bot.name, req.headers.get('cf-connecting-ip'));
  return { cname: bot.name, ipverdict: v.verdict, rangever: v.rangever };
}

// ---- write-time fields (Oct 19 2026, W6) ----
// The composite write-time string ('wt', stored in the record's
// blob10 — the slot 'via' occupied, constant 'edge' since the
// beacon write path retired; repurposed era-forward: records
// written before this build carry 'edge' there and no components).
// One string, semicolon-separated key=value components:
//   rng     the address-range verdict (same value as ipverdict)
//   rdns    the claimed-operator rDNS match verdict (shared/rdns):
//           match / mismatch / none / not-offered / not-checked /
//           na (no name claimed, so no operator check exists)
//   org     the network-origin category for EVERY request, from
//           the forward-confirmed rDNS name (shared/rdns) — a
//           descriptive fact about the network, never a verdict on
//           a claim and never evidence about a person
//   xr      cross-range membership: every bundled operator list
//           whose ranges contain the address ('-' = in none,
//           'nc' = not computed: no address)
//   wba     Web Bot Auth signature presence
//   wbav    our own RFC 9421 validity computation (shared/wba):
//           valid / invalid / unverifiable / directory-unreachable
//   wbab    curated signer-host binding for the claimed name:
//           bound / unbound
//   proto / tls / cipher — the arriving stack (descriptive facts)
//   hp      header profile: browser-like / partial / minimal — a
//           DESCRIPTIVE fold only, never a verdict component
//           (impersonation libraries spoof header sets wholesale)
// rng/rdns/xr/wba* are the verdict components; org and the stack
// facts are descriptive facts sharing the string because the
// record's text slots are all allocated — sharing a string does
// not make a fact a verdict. The raw material behind every
// component (address, hostname, key, signature) is discarded in
// this call; only the component tokens are stored.
export function headerProfile(req) {
  const hasSf = !!(req.headers.get('sec-fetch-mode') || req.headers.get('sec-fetch-site') ||
    req.headers.get('sec-fetch-dest') || req.headers.get('sec-fetch-user'));
  const hasAl = !!req.headers.get('accept-language');
  const accept = req.headers.get('accept') || '';
  const hasHtml = accept.includes('text/html');
  if (hasSf && hasAl) return 'browser-like';
  if (!hasSf && !hasAl && !hasHtml) return 'minimal';
  return 'partial';
}

export function stackFacts(req) {
  const cf = req.cf || {};
  const proto = ({ 'HTTP/1.0': 'h1.0', 'HTTP/1.1': 'h1.1', 'HTTP/2': 'h2', 'HTTP/3': 'h3' })[cf.httpProtocol] || 'unknown';
  const tls = cf.tlsVersion ? String(cf.tlsVersion).replace(/^TLSv/i, '') : '-';
  const cipher = cf.tlsCipher ? String(cf.tlsCipher).replace(/^TLS_/, '') : '-';
  return { proto, tls, cipher };
}

const WBA_TIMEOUT_MS = 1500;

// writeTimeFields(req, { network }): the claim fields plus the
// composite string. Async because the rDNS and WBA legs involve
// bounded network reads; callers run it inside the waitUntil write
// closure so the response never waits on it. With network:false
// (asset companions) the network legs are skipped and their
// components read not-checked — companions bound the lookup
// budget; their join key (the visitor digest) is unaffected.
export async function writeTimeFields(req, opts = {}) {
  const network = opts.network !== false;
  const ua = (req.headers.get('user-agent') || '').slice(0, 400);
  const base = claimFields(req, ua);
  const address = req.headers.get('cf-connecting-ip');
  // cross-range membership: pure computation over bundled lists.
  const xrHits = address ? crossRangeMembership(address) : null;
  const xr = xrHits === null ? 'nc' : (xrHits.length ? xrHits.join('+') : '-');
  // rDNS origin category + claimed-operator match verdict.
  let org = 'not-checked';
  let rdns = base.cname ? 'not-checked' : 'na';
  if (network && address) {
    try {
      const origin = await lookupNetworkOrigin(address, opts.fetchFn);
      if (origin && origin.state === 'ok') org = origin.category;
      if (base.cname) rdns = rdnsVerdictFor(base.cname, origin).verdict;
    } catch (e) { /* stays not-checked */ }
  }
  // Web Bot Auth validity (presence without a Signature pair
  // never reaches the verifier).
  let wba = 'absent', wbav = 'absent', wbab = 'absent';
  if (network && (req.headers.get('signature') || req.headers.get('signature-input'))) {
    try {
      let timer = null;
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => resolve({ presence: 'present', validity: 'unverifiable', binding: 'unbound' }), WBA_TIMEOUT_MS);
      });
      const verdict = await Promise.race([
        verifyWebBotAuth({
          getHeader: n => req.headers.get(n),
          method: req.method,
          url: req.url,
          sigAgentHost: sigAgentHost(req),
          claimedName: base.cname,
          fetchFn: opts.fetchFn
        }),
        timeout
      ]);
      if (timer) clearTimeout(timer);
      wba = verdict.presence; wbav = verdict.validity; wbab = verdict.binding;
    } catch (e) { wba = 'present'; wbav = 'unverifiable'; wbab = 'unbound'; }
  }
  const stk = stackFacts(req);
  const hp = headerProfile(req);
  const wt = '1;rng=' + base.ipverdict + ';rdns=' + rdns + ';org=' + org + ';xr=' + xr +
    ';wba=' + wba + ';wbav=' + wbav + ';wbab=' + wbab +
    ';proto=' + stk.proto + ';tls=' + stk.tls + ';cipher=' + stk.cipher + ';hp=' + hp;
  return { ...base, wt };
}

// The pre-W6 fallback (callers that cannot compute write-time
// fields): claim fields plus a components string of not-checked
// values, so the record's shape never varies.
function fallbackFields(req, ua) {
  const base = claimFields(req, ua);
  const stk = stackFacts(req);
  return {
    ...base,
    wt: '1;rng=' + base.ipverdict + ';rdns=' + (base.cname ? 'not-checked' : 'na') +
      ';org=not-checked;xr=nc;wba=absent;wbav=absent;wbab=absent;proto=' + stk.proto +
      ';tls=' + stk.tls + ';cipher=' + stk.cipher + ';hp=' + headerProfile(req)
  };
}

export function buildVisitRecord(req, res, siteHost, event, digests = {}, fields = null) {
  const url = new URL(req.url);
  const ua = (req.headers.get('user-agent') || '').slice(0, 400);
  const { cls, purpose } = classify(ua);
  const dg = (digests && typeof digests === 'object') ? digests : { visitor: digests || '' };
  const f = fields || fallbackFields(req, ua);
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
    sigagent: sigAgentHost(req),
    wt: f.wt,
    event: event || 'pageview',
    cname: f.cname, ipverdict: f.ipverdict, rangever: f.rangever,
    // The visitor digests (lens spec B-e; epoch digest added Oct 19
    // 2026, D2), computed by the caller (frontDoor) — '' when no
    // secret is provisioned on this Worker or the request carried
    // no cf-connecting-ip.
    visitor: dg.visitor || '',
    visitorepoch: dg.visitorepoch || '',
    // The source digest (W10, Oct 19 2026): HMAC over the Pacific
    // date + address only, no user-agent — see shared/visitor.mjs.
    // Stored on the AE path as two doubles (shared/visits.mjs);
    // the value itself is never published, only aggregates.
    srcdigest: dg.srcdigest || ''
  };
}

// The keyed surfaces are the only function addresses excluded from
// the visit record (narrowed Oct 19 2026, D3.2): the keyed stats
// routes, the steward route and the steward guestbook route carry a
// key by design, and steward use of them never enters the record.
// Every other function address is a PUBLIC read (counts, ledger,
// changed, the data files) and its GETs are visit-logged under their
// named events (eventForPath below) — until this build the blanket
// '/.netlify/' exclusion made those reads invisible, the largest
// single blind spot in the record (the audit, D3).
const KEYED_UNLOGGED = ['/.netlify/functions/stats', '/.netlify/functions/steward', '/.netlify/functions/guestbook'];

// Utility addresses counted in their own store, never in the visit
// record (added Oct 19 2026, garden-clock/v1): a clock call is a
// claim of use, not a visit, so the utility's own route writes the
// call to the utility dataset (shared/visits.mjs writeUtilityVisit)
// and the front door writes nothing for the address — the two
// exclusions together are what keep calls out of the visit totals
// while keeping them countable. Every other utility keeps the
// ordinary 'utility-read' visit record. The legacy function shape
// of the same address is excluded the same way.
const UTILITY_COUNTED_ELSEWHERE = ['/utilities/garden-clock/', '/.netlify/functions/utilities/garden-clock/'];

export function shouldLog(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = new URL(req.url).pathname;
  if (KEYED_UNLOGGED.some(k => p === k || p.startsWith(k + '/'))) return false;
  if (UTILITY_COUNTED_ELSEWHERE.some(k => p.startsWith(k))) return false;
  if (SKIP_EXT.some(e => p.endsWith(e))) return false;
  return true;
}

// Asset companions (lens spec B-a): the stylesheet/script/favicon a
// rendered page pulls. v1's companion set is exactly these three;
// images, fonts and media stay skipped to bound volume.
const COMPANION_EXT = ['.css', '.js', '.ico'];
export function shouldLogAsset(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const p = new URL(req.url).pathname;
  if (p.startsWith('/.netlify/')) return false;
  return COMPANION_EXT.some(e => p.endsWith(e));
}

// A companion record: the same field posture as the visit record it
// accompanies — no key, no address, pathname only — with cls/event
// marking it as an asset pull. Its `ref` is the page that pulled it
// (the render-test join key). It is written to the site's SEPARATE
// asset dataset (or, on the D1 fallback, the same visit_log table
// under event 'asset', which every visit aggregate excludes).
export function buildAssetRecord(req, res, siteHost, digests = {}, fields = null) {
  const url = new URL(req.url);
  const ua = (req.headers.get('user-agent') || '').slice(0, 400);
  const dg = (digests && typeof digests === 'object') ? digests : { visitor: digests || '' };
  const f = fields || fallbackFields(req, ua);
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
    cls: 'asset',
    purpose: null,
    method: req.method,
    status: res.status,
    md: 0,
    ba: botAuthState(req),
    sigagent: sigAgentHost(req),
    wt: f.wt,
    event: 'asset',
    cname: f.cname, ipverdict: f.ipverdict, rangever: f.rangever,
    // Companion records carry the digests too (lens spec B-e: the
    // field rides the visit record "and B-a's companion records"),
    // so the render join can be exact rather than ASN-approximate.
    visitor: dg.visitor || '',
    visitorepoch: dg.visitorepoch || ''
  };
}

// Named events (advisory amendment: actions, not just loads; extended
// Oct 18 2026, lens spec B-c; extended Oct 19 2026, D3.1/D3.2).
// Derived from the path at write time — page loads stay 'pageview';
// the named surfaces are labelled so "what did people/agents do" is
// answerable without path-archaeology. The keyed surfaces are
// deliberately NOT events: shouldLog excludes them before any record
// is built, so steward use never enters the visit record (if a
// steward-use count is ever wanted it belongs in the D1 attempts
// table, not here). The public function reads (counts, ledger, the
// data files, the render-claim and signal-challenge how-tos) ARE
// events since D3.2 — they are published protocol surfaces and their
// reads belong in the record.
// The /changed format fold: eventForPath returns the bare
// 'changed-read'; frontDoor resolves it against the response's own
// content type (changedEventForResponse below) — the response is
// the ground truth of routes/changed.js's selection (an explicit
// ?format wins there, else the Accept header, Atom checked before
// JSON), so the record names the format actually served.
export function eventForPath(pathname) {
  if (pathname === '/dashboard.html' || pathname === '/dashboard') return 'arrival-board-view';
  if (pathname === '/guestbook.html' || pathname === '/guestbook') return 'guestbook-view';
  if (pathname.startsWith('/utilities/')) return 'utility-read';
  if (pathname.startsWith('/api/v1/receipts') || pathname.startsWith('/receipts/')) return 'receipt-check';
  if (pathname === '/changed' || pathname === '/.netlify/functions/changed') return 'changed-read';
  if (pathname === '/api/v1/notes' || pathname === '/api/v1/notes/') return 'notes-read';
  if (pathname === '/data' || pathname.startsWith('/data/')) return 'data-read';
  if (pathname === '/.netlify/functions/counts') return 'counts-read';
  if (pathname === '/.netlify/functions/ledger') return 'ledger-read';
  if (pathname === '/api/v1/signal/challenge') return 'signal-challenge-read';
  if (pathname === '/api/v1/render-claim') return 'render-howto-read';
  return 'pageview';
}

// The /changed Accept-based fold, applied where the response is in
// hand (frontDoor): an explicit-format event already decided by
// eventForPath stands; the bare 'changed-read' resolves to the
// format the response actually carries.
export function changedEventForResponse(event, res) {
  if (event !== 'changed-read') return event;
  const ct = (res && res.headers && res.headers.get('content-type')) || '';
  if (ct.includes('application/json')) return 'changed-read-json';
  if (ct.includes('application/atom+xml')) return 'changed-read-atom';
  return event;
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
// the Garden homepage's "Counting since" row, so the record's
// start date is spliced in live beside the total it describes.
// getCounterBlock() is optional (added Oct 17 2026 for the advisory
// homepage counter): when supplied and it returns an HTML string,
// that string replaces the inner content of any [data-counter-block]
// element. The published page carries the no-numbers fallback inside
// that element, so a null return (counts unavailable) leaves the
// fallback standing — numbers are never zero-filled or reused stale.
// getAgentClaimed() is likewise optional (added Oct 17 2026, the
// Garden homepage's claimed figure): when supplied and it returns a
// number, that number (the counts payload's visits_by_class
// agent-claimed count, from the serving Worker's own visit store)
// replaces the content of any <span data-count="agent-claimed">.
// getHumans() is likewise optional (added Oct 18 2026, the human
// self-report figure): when supplied and it returns a number, that
// number (the counts payload's humans_total — the serving Worker's
// own press count) replaces the content of any
// <span data-count="humans">.
export async function injectCounts(res, getArrivals, getUpdated, getVisits, getCounterBlock, getWindow, getAgentClaimed, getHumans) {
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
    if (typeof getAgentClaimed === 'function') {
      const a = await getAgentClaimed();
      if (typeof a === 'number') {
        rw.on('span[data-count="agent-claimed"]', {
          element(el) { el.setInnerContent(String(a)); }
        });
      }
    }
    if (typeof getHumans === 'function') {
      const h = await getHumans();
      if (typeof h === 'number') {
        rw.on('span[data-count="humans"]', {
          element(el) { el.setInnerContent(String(h)); }
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
    out = await injectCounts(out, opts.getArrivals, opts.getUpdated, opts.getVisits, opts.getCounterBlock, opts.getWindow, opts.getAgentClaimed, opts.getHumans);
  }
  if (req.method === 'GET' && opts && typeof opts.getCounterText === 'function') {
    out = await injectCounterText(out, opts.getCounterText);
  }
  if (shouldLog(req)) {
    const event = changedEventForResponse(eventForPath(url.pathname), out);
    // The whole record build — digests plus the W6 write-time
    // fields, whose rDNS / signature legs make bounded network
    // reads — runs inside the write closure, so the response
    // never waits on them (Oct 19 2026, W6; previously the digest
    // computation was awaited before the record was built).
    const write = (async () => {
      const visitor = await visitorForRequest(env, req);
      visitor.srcdigest = await sourceDigestForRequest(env, req);
      const fields = await writeTimeFields(req);
      const record = buildVisitRecord(req, out, opts.siteHost, event, visitor, fields);
      await writeVisit(env, record);
      try { console.log('VISIT ' + JSON.stringify(record)); } catch (e) {}
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  } else if (shouldLogAsset(req)) {
    // Asset companions go to their own store, never the visit store:
    // page totals are byte-identical with companions on or off.
    // Their write-time fields skip the network legs (see
    // writeTimeFields) to bound the lookup budget.
    const write = (async () => {
      const visitor = await visitorForRequest(env, req);
      const fields = await writeTimeFields(req, { network: false });
      const record = buildAssetRecord(req, out, opts.siteHost, visitor, fields);
      await writeAssetVisit(env, record);
      try { console.log('ASSET ' + JSON.stringify(record)); } catch (e) {}
    })().catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(write);
    else await write;
  }
  return out;
}
