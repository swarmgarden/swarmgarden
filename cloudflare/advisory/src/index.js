// Bay Area Swarm Warning — the Worker (bayareaswarmwarning.com).
// Serves the static site (Workers Assets), the shared front-door logic
// (negotiation, count injection from the Garden's public counts,
// edge-only request logging into THIS site's own Analytics Engine
// dataset), and the function routes: the key-gated dashboard at
// /.netlify/functions/stats and this site's own public counts at
// /.netlify/functions/counts (added Oct 18 2026 — see
// routes/counts.js for why the address answered 404 until then).
// The visit writer here classifies with the shared single-source
// taxonomy — the stale hand-copied classifier in the Netlify build
// (with its forged-by-definition google-extended/applebot-extended
// tokens) is not carried over. The unauthenticated beacon write path
// is not carried over either: the edge is the only writer.
import { frontDoor, servePage, LINK_HEADER } from '../../shared/frontdoor.mjs';
import { logAttempt, channelForPath } from '../../shared/attempts.mjs';
import statsRoute from './routes/stats.js';
import countsRoute from './routes/counts.js';
import dataRoute, { dataJsonRoute, loadDataJson } from './routes/data.js';
import humanRoute from './routes/human.js';
import renderRoute from './routes/render.js';
import { homeSnapshotHtml, homeSnapshotText, HOME_TEXT_FALLBACK } from './home.js';

const SITE_HOST = 'bayareaswarmwarning.com';

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/.netlify/functions/stats') {
      const res = await statsRoute(req, env, ctx);
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    // This site's own public counts (added Oct 18 2026): the same
    // published address shape as the Garden's, carrying this site's
    // own figures (routes/counts.js). Answered directly, like the
    // stats route — a counts failure can never reach page serving.
    // Since D3.2 (Oct 19 2026) the response passes through the front
    // door: each read writes one 'counts-read' visit record (the
    // Garden's counts route has always been logged the same way,
    // through its handler branch). The Oct 18 "reads are not
    // visit-logged" note is superseded for this route.
    if (url.pathname === '/.netlify/functions/counts') {
      let res = await countsRoute(req, env, ctx);
      res = await frontDoor(req, env, ctx, res, { siteHost: SITE_HOST, getArrivals: null });
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    // The retired Arrival Record page (removed Oct 18, 2026): its
    // address now redirects to the snapshot on the home page. Answered
    // here, before the front door — a redirect is not a page view, so
    // it is not visit-logged.
    if (url.pathname === '/dashboard.html' || url.pathname === '/dashboard') {
      return new Response(null, { status: 301, headers: { location: '/#record' } });
    }
    // The public data pages (added Oct 18 2026): /data, /data/garden,
    // /data/advisory and the same-origin JSON files under /data/*.json.
    // Answered directly, like the counts and stats routes, so a data
    // failure can never reach page serving. The pages render the data
    // files the hourly snapshot publishes into the public repository
    // (routes/data.js). Since D3.2 (Oct 19 2026) the response passes
    // through the front door: each read — page or JSON file — writes
    // one 'data-read' visit record, reversing the Oct 18 no-logging
    // rule exactly as on the Garden (the reversal is named in
    // PORT-NOTES; the Oct 18 pin asserting no record was reversed
    // with it).
    if (url.pathname === '/data' || url.pathname.startsWith('/data/')) {
      const jm = url.pathname.match(/^\/data\/([a-z0-9\-]+\.json)$/);
      let res = jm ? await dataJsonRoute(req, env, ctx, jm[1]) : await dataRoute(req, env, ctx);
      res = await frontDoor(req, env, ctx, res, { siteHost: SITE_HOST, getArrivals: null });
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        res = new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    // The human self-report (added Oct 18 2026): this site's own
    // press endpoint. Answered directly, like the stats route — a
    // press-path failure can never reach page serving, and the
    // endpoint's reads are not visit-logged (a read of the endpoint
    // is not a visit).
    if (url.pathname === '/api/v1/human-press') {
      let res = await humanRoute(req, env, ctx);
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        res = new Response(res.body, { status: res.status, headers });
      }
      // Refused-POST attempt counting (lens spec B-b): a refused
      // press writes one row in this site's own api_attempts table;
      // a counted press writes none (the press table counts it).
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const w = logAttempt(env, req, res, 'human-press');
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(w);
      }
      return res;
    }
    // The render claim (added Oct 18 2026, lens spec B-d): a short
    // script on this site's homepage posts the page path here after
    // the page renders; the claim is
    // kept in this site's own render_claims table and published as
    // "render-signalled". Answered directly, like the press — a
    // claim-path failure can never reach page serving. Recorded
    // claims are not knocks; refusals are (lens spec B-b). (GET
    // reads of the how-to ARE visit-logged since D3.2 — see the
    // wrap inside the branch.)
    if (url.pathname === '/api/v1/render-claim') {
      let res = await renderRoute(req, env, ctx);
      // D3.2 (Oct 19 2026): a GET of the how-to is a protocol read
      // and is visit-logged ('render-howto-read') through the front
      // door; POSTs keep their knock treatment below and are never
      // visit-logged.
      if (req.method === 'GET' || req.method === 'HEAD') {
        res = await frontDoor(req, env, ctx, res, { siteHost: SITE_HOST, getArrivals: null });
      }
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        res = new Response(res.body, { status: res.status, headers });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const w = logAttempt(env, req, res, 'render-claim');
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(w);
      }
      return res;
    }
    const res = await servePage(req, env);
    // Unrouted POSTs (lens spec B-b): a non-GET/HEAD request with no
    // route, refused by the page branch, is a knock too. Widened
    // (Oct 19 2026, D3.3): ANY refusal status counts (>= 400, not
    // only 404), on the path's own channel when it has one
    // (channelForPath), else 'unrouted'.
    if (req.method !== 'GET' && req.method !== 'HEAD' && res.status >= 400) {
      const w = logAttempt(env, req, res, channelForPath(url.pathname) || 'unrouted');
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(w);
    }
    // The Garden's published counts, fetched once per page serve; the
    // front-door callbacks (arrivals spans, the homepage counter block
    // and its Markdown-twin text) all read the same result. A failed
    // fetch yields null everywhere: pages serve exactly as published
    // and the counter shows its no-numbers fallback (Oct 17 2026).
    let countsPromise = null;
    const getCounts = () => {
      if (!countsPromise) {
        countsPromise = (async () => {
          try {
            const origin = env.COUNTS_ORIGIN || 'https://swarmgarden.com';
            const r = await fetch(origin + '/.netlify/functions/counts', { headers: { accept: 'application/json' } });
            if (r.ok) { const j = await r.json(); if (j && typeof j.arrivals_on_record === 'number') return j; }
          } catch (e) {}
          return null;
        })();
      }
      return countsPromise;
    };
    // The homepage snapshot (Oct 19 2026): the front door's counter
    // slots carry the serve-time snapshot block (src/home.js) on the
    // home page and its Markdown twin. Its bundle-drawn figures load
    // through the data pages' own loader (routes/data.js) — the same
    // edge cache and stale semantics; a failed bundle load yields a
    // null leg and an explained absence in the block, never a
    // zero-fill. Loads happen only for home-page serves.
    const isHome = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/index.md';
    let bundlesPromise = null;
    const getBundles = () => {
      if (!bundlesPromise) {
        bundlesPromise = (async () => {
          const one = (name) => loadDataJson(env, ctx, name).catch(() => null);
          const [responses, paths, series] = await Promise.all([
            one('garden-responses.json'), one('garden-paths.json'), one('garden-series.json')
          ]);
          return { responses, paths, series };
        })();
      }
      return bundlesPromise;
    };
    return frontDoor(req, env, ctx, res, {
      siteHost: SITE_HOST,
      getArrivals: async () => {
        const c = await getCounts();
        return c ? c.arrivals_on_record : null;
      },
      getCounterBlock: async () => {
        if (!isHome) return null;
        const c = await getCounts();
        return c ? homeSnapshotHtml(c, await getBundles()) : null;
      },
      getCounterText: async () => {
        if (!isHome) return '';
        const c = await getCounts();
        return c ? homeSnapshotText(c, await getBundles()) : HOME_TEXT_FALLBACK;
      }
    });
  }
};
