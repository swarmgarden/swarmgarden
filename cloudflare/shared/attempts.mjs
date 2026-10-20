// Swarm Garden — refused-POST attempt counting (lens spec B-b,
// Oct 18 2026). The knock record.
//
// The visit datasets record GET/HEAD only, so until now a POST
// refused by a channel (503 gate-closed, 429 rate, 413 size, 400
// off-format, stale-version, unknown-nonce…) left no trace anywhere:
// the knock count could only ever say "none recorded". This module
// closes that blind spot. Both Workers' routers wrap their channel
// handlers for non-GET/HEAD methods: when the response is a refusal
// (status >= 400), ONE row lands in the site's OWN D1 `api_attempts`
// table:
//
//   t, route (the path as called), channel, method, status,
//   code (the refusal code from the response's JSON body, read
//   best-effort via a cloned response — '' when the body is not
//   JSON, e.g. a browser answered in HTML), cls + cname (the UA's
//   claim, from the shared taxonomy + dictionary), country, asn,
//   asOrganization (edge facts, as on the visit record).
//
// Scope, exactly: successful POSTs are NOT written — each channel
// already counts its own successes in its own sequence (receipts,
// notes, signals, presses); this table is the knock record, not a
// second success ledger. POSTs to paths with NO route, answered 404
// by the page branch, are written by the routers with channel
// 'unrouted'. Request BODIES are never stored — not on success, not
// on refusal. No address is stored. Steward surfaces only: the
// counts read joins the keyed stats pages; the public counts payload
// does not change.
//
// Oct 19 2026 (measurement programme W1 + W2, plan A1/A2 — Caitria's
// authorization): the read side gains the folds the bare total could
// not answer — by status, by route, by claim class and claimed name,
// the channel × refusal-code cross-tab, the unrouted rows listed by
// route (unrouted is where the route IS the information), a Pacific
// day beside the UTC day, and a provenance split. Two write-side
// columns join the table (schema-additive; production D1s were
// ALTERed and backfilled once, before this code deployed):
//   origin         — 'steward-test' when the request carries the
//                    steward key on the dedicated test header
//                    (x-steward-test), 'external' otherwise (the
//                    column default). Steward verification knocks
//                    are self-labelling from this build forward;
//                    the rows already on record were backfilled
//                    once from the Oct 18/19 build record (Garden:
//                    the six Oct 18 steward-burst rows; Advisory:
//                    its two Oct 18 burst rows — the rest external).
//   content_length — the refused POST's declared Content-Length, a
//                    NUMBER (the body's size, never the body; bodies
//                    are still never stored). NULL on rows written
//                    before this build, and when a request declares
//                    no length.
// Read-layer normalization (A1.4): a stored code of '' means the
// refusal body was not JSON — it is published as
// 'no-code (non-JSON refusal)', with the status folds beside it,
// never as an empty string that reads as missing data. The stored
// value itself is unchanged.
import { classify } from './taxonomy.mjs';
import { claimedBot } from './behaviour.mjs';

const INTAKE_CHANNELS = ['answers', 'questions', 'reports', 'registry'];

// Map a request path to its attempt channel, or null when the path is
// not one of the published channels (steward routes and other keyed
// surfaces are not channels — their traffic is not counted here).
// The utilities mapping (Oct 19 2026, D3.3): a refused POST to a
// utility path previously mapped to no channel and vanished; the
// utilities are published channels and their refusals count on
// their own channel.
export function channelForPath(pathname) {
  if (pathname === '/api/v1/notes' || pathname === '/.netlify/functions/notes') return 'notes';
  if (pathname === '/api/v1/signal' || pathname === '/api/v1/signal/challenge') return 'signal';
  if (pathname === '/api/v1/human-press') return 'human-press';
  if (pathname === '/api/v1/render-claim') return 'render-claim';
  if (pathname.startsWith('/utilities/') || pathname.startsWith('/.netlify/functions/utilities/')) return 'utilities';
  if (pathname.startsWith('/api/v1/')) {
    const seg = pathname.split('/').filter(Boolean).pop();
    return INTAKE_CHANNELS.includes(seg) ? seg : 'intake-other';
  }
  if (pathname.startsWith('/.netlify/functions/intake/')) {
    const seg = pathname.split('/').filter(Boolean).pop();
    return INTAKE_CHANNELS.includes(seg) ? seg : 'intake-other';
  }
  return null;
}

// The dedicated steward-test header (W2): a knock is provenance-
// labelled 'steward-test' only when the request carries this header
// AND its value equals the Worker's steward key (STEWARD_KEY where
// the site has one, else STATS_KEY — the Advisory's only steward
// secret). The header alone proves nothing; the key is the proof.
// The key value is compared, never stored or logged.
export const STEWARD_TEST_HEADER = 'x-steward-test';

export function attemptOrigin(env, req) {
  try {
    const presented = req.headers.get(STEWARD_TEST_HEADER) || '';
    const expected = (env && (env.STEWARD_KEY || env.STATS_KEY)) || '';
    if (presented && expected && presented === expected) return 'steward-test';
  } catch (e) { /* a header read must never break a knock write */ }
  return 'external';
}

// The refused POST's declared body size: the Content-Length header
// parsed as a non-negative integer, or null when absent or not a
// number. A number only — the body itself is never read or stored.
export function declaredContentLength(req) {
  try {
    const raw = req.headers.get('content-length');
    if (raw === null || raw === undefined || raw === '') return null;
    const v = Number(raw);
    return Number.isInteger(v) && v >= 0 ? v : null;
  } catch (e) { return null; }
}

// Record one refused attempt. Best-effort by design: a failure here
// must never change the response the caller already got.
export async function logAttempt(env, req, res, channel) {
  try {
    if (!env || !env.DB || !channel) return;
    if (!res || res.status < 400) return; // successes are not knocks
    let code = '';
    try {
      const body = await res.clone().json();
      if (body && typeof body.code === 'string') code = body.code.slice(0, 60);
    } catch (e) { /* body not JSON (HTML refusal page): code stays '' */ }
    const ua = (req.headers.get('user-agent') || '').slice(0, 400);
    const { cls } = classify(ua);
    const bot = claimedBot(ua);
    const cf = req.cf || {};
    await env.DB.prepare(
      'INSERT INTO api_attempts (t, route, channel, method, status, code, cls, cname, country, asn, as_org, origin, content_length) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)'
    ).bind(
      new Date().toISOString(),
      new URL(req.url).pathname,
      channel,
      req.method,
      res.status,
      code,
      cls,
      bot ? bot.name : '',
      cf.country ? String(cf.country) : '',
      (cf.asn !== undefined && cf.asn !== null) ? String(cf.asn) : '',
      cf.asOrganization ? String(cf.asOrganization) : '',
      attemptOrigin(env, req),
      declaredContentLength(req)
    ).run();
  } catch (e) { /* the knock record never breaks a response */ }
}

// The published label for a stored refusal code of '' (A1.4): the
// refusal body was not JSON, so no code could be read from it. It is
// a fact about our response format, not missing data about the knock.
export const NO_CODE_LABEL = 'no-code (non-JSON refusal)';
export const codeLabel = (code) => (code ? code : NO_CODE_LABEL);

// The Pacific day containing a whole UTC hour ('YYYY-MM-DDTHH') —
// Pacific offsets are whole hours, so an hour bucket lies inside
// exactly one Pacific day and the fold is exact (the same fold the
// visitor-digest series uses, shared/visits.mjs).
const PT_DAY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
function ptDayOfUtcHour(h) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(h || '')) return '';
  const parts = PT_DAY_PARTS.formatToParts(new Date(h + ':00:00Z'));
  const g = (t) => (parts.find(p => p.type === t) || {}).value || '';
  return g('year') + '-' + g('month') + '-' + g('day');
}

// Declared-body-size buckets for the content_length fold. Rows from
// before the column existed (and requests declaring no length) fold
// into 'not recorded' — an era fact, never a zero.
export function lengthBucket(v) {
  if (v === null || v === undefined || v === '') return 'not recorded';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 'not recorded';
  if (n === 0) return '0';
  if (n <= 100) return '1-100';
  if (n <= 1000) return '101-1000';
  if (n <= 10000) return '1001-10000';
  return 'over 10000';
}

const ROUTE_FOLD_TOP = 25;   // by_route publishes the top routes…
const UNROUTED_LIST_TOP = 50; // …and the unrouted listing is capped

// The stats-page read (W1, Oct 19 2026): the original folds (channel,
// code, UTC day — keys unchanged, the '' code now LABELLED at this
// read layer) plus by_status, by_route (top 25, with the folded
// remainder counted), by_cls, by_cname, by_origin, by_day_pt
// (Pacific), by_length, the channel × code cross-tab, and the
// unrouted rows listed by route × class × status. Steward surfaces
// and the published knocks bundle read this one shape.
export async function attemptStats(env) {
  const out = {
    total: 0, by_channel: {}, by_code: {}, by_day: {},
    by_status: {}, by_route: {}, by_route_folded: 0, distinct_routes: 0,
    by_cls: {}, by_cname: {}, by_origin: {}, by_day_pt: {},
    by_length: {}, by_channel_code: {}, unrouted_by_route: []
  };
  if (!env || !env.DB) return out;
  const fold = async (sql, key, labelCodes) => {
    const { results } = await env.DB.prepare(sql).all();
    for (const r of results || []) {
      const k = labelCodes ? codeLabel(r.k || '') : (r.k === null || r.k === undefined ? '' : String(r.k));
      out[key][k] = (out[key][k] || 0) + Number(r.c || 0);
    }
  };
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM api_attempts').first();
  out.total = row ? Number(row.c || 0) : 0;
  await fold('SELECT channel AS k, COUNT(*) AS c FROM api_attempts GROUP BY channel', 'by_channel');
  await fold('SELECT code AS k, COUNT(*) AS c FROM api_attempts GROUP BY code', 'by_code', true);
  await fold("SELECT substr(t, 1, 10) AS k, COUNT(*) AS c FROM api_attempts GROUP BY k", 'by_day');
  await fold('SELECT CAST(status AS TEXT) AS k, COUNT(*) AS c FROM api_attempts GROUP BY status', 'by_status');
  await fold('SELECT cls AS k, COUNT(*) AS c FROM api_attempts GROUP BY cls', 'by_cls');
  await fold('SELECT cname AS k, COUNT(*) AS c FROM api_attempts GROUP BY cname', 'by_cname');
  await fold('SELECT origin AS k, COUNT(*) AS c FROM api_attempts GROUP BY origin', 'by_origin');
  // by_route: every route folded in SQL, top-N + folded remainder
  // applied here so the published map sums to the total exactly.
  {
    const { results } = await env.DB.prepare(
      'SELECT route AS k, COUNT(*) AS c FROM api_attempts GROUP BY route ORDER BY c DESC, k ASC').all();
    const rows = results || [];
    out.distinct_routes = rows.length;
    let folded = 0;
    rows.forEach((r, i) => {
      if (i < ROUTE_FOLD_TOP) out.by_route[r.k || ''] = Number(r.c || 0);
      else folded += Number(r.c || 0);
    });
    out.by_route_folded = folded;
  }
  // Pacific days: group by UTC hour in SQL, fold in code (exact —
  // see ptDayOfUtcHour).
  {
    const { results } = await env.DB.prepare(
      "SELECT substr(t, 1, 13) AS h, COUNT(*) AS c FROM api_attempts GROUP BY h").all();
    for (const r of results || []) {
      const day = ptDayOfUtcHour(r.h || '');
      if (day) out.by_day_pt[day] = (out.by_day_pt[day] || 0) + Number(r.c || 0);
    }
  }
  // Declared body sizes (NULL = the pre-column era or no header).
  {
    const { results } = await env.DB.prepare(
      'SELECT content_length AS v, COUNT(*) AS c FROM api_attempts GROUP BY content_length').all();
    for (const r of results || []) {
      const k = lengthBucket(r.v);
      out.by_length[k] = (out.by_length[k] || 0) + Number(r.c || 0);
    }
  }
  // The channel × code cross-tab: { channel: { code label: count } }.
  {
    const { results } = await env.DB.prepare(
      'SELECT channel AS ch, code AS k, COUNT(*) AS c FROM api_attempts GROUP BY channel, code').all();
    for (const r of results || []) {
      const ch = r.ch || '';
      const m = out.by_channel_code[ch] || (out.by_channel_code[ch] = {});
      const k = codeLabel(r.k || '');
      m[k] = (m[k] || 0) + Number(r.c || 0);
    }
  }
  // Unrouted rows listed by route — for unrouted knocks the route is
  // the information (plan A1.2). Capped; the cap is a display bound,
  // and by_route above always carries the full fold.
  {
    const { results } = await env.DB.prepare(
      "SELECT route AS route, cls AS cls, status AS status, COUNT(*) AS c FROM api_attempts WHERE channel = 'unrouted' GROUP BY route, cls, status ORDER BY c DESC, route ASC").all();
    out.unrouted_by_route = (results || []).slice(0, UNROUTED_LIST_TOP).map(r => ({
      route: r.route || '', cls: r.cls || '', status: Number(r.status || 0), count: Number(r.c || 0)
    }));
  }
  return out;
}
