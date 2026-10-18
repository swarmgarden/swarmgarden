// Swarm Garden — the render claim (lens spec B-d, Oct 18 2026;
// burn-down B49). The watering-hole instrument.
//
// A page's own script, after the page renders, posts the page's
// path here. The claim is recorded in the site's OWN D1 table
// `render_claims` (t, path, cls, country, asn) and published — on
// the keyed stats pages — under its plain ruled name,
// "render-signalled": evidence a browser executed the page.
//
// The evidentiary limit is carried by this documentation, written
// once (the steward's ruling, Oct 18 2026): the signal is forgeable
// in principle — anyone can post one by hand, and the build note
// for this batch demonstrates exactly that beside a real claim.
// A claim is recorded as a claim. It never feeds verified
// arrivals, is never composited with them, and is never called
// proof. Checking whether something rendered a page is not
// capturing an address or taking something from the visitor — it
// is seeing whether they drink at the watering hole.
//
// Structural separation, by construction: claims never enter the
// AE visit datasets, never enter the counts payload, and carry no
// key that could join them to anything (no digest, no address —
// the address is read only to shape the rate limit, as a one-way
// digest, and discarded, the channels' existing posture).
//
// The stored event name is 'render-claim', set in the B-c event
// family (guestbook-view, utility-read, receipt-check,
// changed-read, notes-read, arrival-board-view): the route, the
// table, and this name are one shape on both Workers. The two
// sites' claims live in their own databases and never merge.
//
// Shaping (the human-press discipline): a per-site RENDER_OPEN
// gate plus a steward pause flag; 3 claims/min + 20/hr per network
// digest and a 300/day global cap; a claim carries ONLY the page
// path — any other field is refused (see routes/render.js).
import { createHash } from 'node:crypto';
import { classify } from './taxonomy.mjs';

export const RENDER_EVENT = 'render-claim';
export const RENDER_PUBLISHED_AS = 'render-signalled';
export const RENDER_FORMAT = 'garden-render/v1';
export const RENDER_BODY_BYTES = 4096;        // raw request body cap
export const RENDER_PATH_MAX = 300;           // a page path, not a payload
export const RENDER_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');

// The factory: the two Workers differ only in the rate-digest salt
// and the steward-state table's name (garden_state on the Garden,
// site_state on the Advisory — each site's own flag store since
// its first steward pause). Everything else is one shape.
export function makeRender({ salt, stateTable }) {
  if (stateTable !== 'garden_state' && stateTable !== 'site_state') {
    throw new Error('makeRender: unknown state table ' + stateTable);
  }
  const stateGet = 'SELECT data FROM ' + stateTable + ' WHERE key = ?1';
  const stateSet = 'INSERT INTO ' + stateTable + ' (key, data) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data = excluded.data';
  const ipDigest = (ip) => sha256hex(salt + String(ip || 'unknown')).slice(0, 32);

  async function getState(db, key) {
    const row = await db.prepare(stateGet).bind(key).first();
    if (!row) return null;
    try { return JSON.parse(row.data); } catch (e) { return null; }
  }

  // ---- the gate (two layers, like every channel: env var + pause) ----
  async function renderGate(env) {
    if (!env || env.RENDER_OPEN !== 'true') return { open: false, why: 'render-not-open' };
    try {
      const st = await getState(env.DB, 'render');
      if (st && st.paused) return { open: false, why: 'render-paused' };
    } catch (e) { /* state store unreadable: env gate alone decides */ }
    return { open: true };
  }
  async function setRenderPaused(env, paused, by) {
    await env.DB.prepare(stateSet).bind('render', JSON.stringify({ paused: !!paused, by: by || 'steward', at: new Date().toISOString() })).run();
  }

  // ---- rate limiting (per source network; D1 fixed-window
  // counters in the sequencer's key shapes: ren-m: / ren-h:) ----
  async function bumpRate(db, key, bucketMs) {
    await db.prepare(
      'INSERT INTO render_rate (key, bucket_ms, count) VALUES (?1, ?2, 1) ' +
      'ON CONFLICT(key, bucket_ms) DO UPDATE SET count = count + 1'
    ).bind(key, bucketMs).run();
    const row = await db.prepare('SELECT count FROM render_rate WHERE key = ?1 AND bucket_ms = ?2').bind(key, bucketMs).first();
    return row ? Number(row.count) || 0 : 0;
  }
  async function renderRateOK(env, ip) {
    const db = env.DB;
    const k = ipDigest(ip);
    const now = Date.now();
    const perMin = await bumpRate(db, 'ren-m:' + k, Math.floor(now / 60000) * 60000);
    if (perMin > RENDER_RATE.perMinute) return false;
    const perHour = await bumpRate(db, 'ren-h:' + k, Math.floor(now / 3600000) * 3600000);
    if (perHour > RENDER_RATE.perHour) return false;
    try { await db.prepare('DELETE FROM render_rate WHERE bucket_ms < ?1').bind(now - 172800000).run(); } catch (e) { /* housekeeping */ }
    return true;
  }

  // ---- the claim (one row; the fields are the whole record) ----
  async function renderDayCount(env) {
    const day = new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM render_claims WHERE substr(t, 1, 10) = ?1').bind(day).first();
    return row ? Number(row.n) || 0 : 0;
  }
  async function recordRender(env, req, path) {
    const ua = (req.headers.get('user-agent') || '').slice(0, 400);
    const { cls } = classify(ua);
    const cf = req.cf || {};
    await env.DB.prepare(
      'INSERT INTO render_claims (t, path, cls, country, asn) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(
      new Date().toISOString(),
      path,
      cls,
      cf.country ? String(cf.country) : '',
      (cf.asn !== undefined && cf.asn !== null) ? String(cf.asn) : ''
    ).run();
  }

  return { renderGate, setRenderPaused, renderRateOK, renderDayCount, recordRender };
}

// ---- steward-side reads (site-agnostic: the table is one shape) ----
export async function renderTotal(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM render_claims').first();
  return row ? Number(row.n) || 0 : 0;
}
export async function renderStats(env) {
  const out = { total: 0, by_path: {}, by_day: {}, by_cls: {} };
  if (!env || !env.DB) return out;
  const fold = async (sql, key) => {
    const { results } = await env.DB.prepare(sql).all();
    for (const r of results || []) out[key][r.k || ''] = Number(r.c || 0);
  };
  out.total = await renderTotal(env);
  await fold('SELECT path AS k, COUNT(*) AS c FROM render_claims GROUP BY path', 'by_path');
  await fold("SELECT substr(t, 1, 10) AS k, COUNT(*) AS c FROM render_claims GROUP BY k", 'by_day');
  await fold('SELECT cls AS k, COUNT(*) AS c FROM render_claims GROUP BY cls', 'by_cls');
  return out;
}
