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
      'INSERT INTO api_attempts (t, route, channel, method, status, code, cls, cname, country, asn, as_org) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)'
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
      cf.asOrganization ? String(cf.asOrganization) : ''
    ).run();
  } catch (e) { /* the knock record never breaks a response */ }
}

// The stats-page read: totals by channel, by code, by day. Steward
// surfaces only.
export async function attemptStats(env) {
  const out = { total: 0, by_channel: {}, by_code: {}, by_day: {} };
  if (!env || !env.DB) return out;
  const fold = async (sql, key) => {
    const { results } = await env.DB.prepare(sql).all();
    for (const r of results || []) out[key][r.k || ''] = Number(r.c || 0);
  };
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM api_attempts').first();
  out.total = row ? Number(row.c || 0) : 0;
  await fold('SELECT channel AS k, COUNT(*) AS c FROM api_attempts GROUP BY channel', 'by_channel');
  await fold('SELECT code AS k, COUNT(*) AS c FROM api_attempts GROUP BY code', 'by_code');
  await fold("SELECT substr(t, 1, 10) AS k, COUNT(*) AS c FROM api_attempts GROUP BY k", 'by_day');
  return out;
}
