// Bay Area Swarm Warning — the Worker (bayareaswarmwarning.com).
// Serves the static site (Workers Assets), the shared front-door logic
// (negotiation, count injection from the Garden's public counts,
// edge-only request logging into THIS site's own Analytics Engine
// dataset), and the one function route: the key-gated dashboard at
// /.netlify/functions/stats.
// The visit writer here classifies with the shared single-source
// taxonomy — the stale hand-copied classifier in the Netlify build
// (with its forged-by-definition google-extended/applebot-extended
// tokens) is not carried over. The unauthenticated beacon write path
// is not carried over either: the edge is the only writer.
import { frontDoor, servePage, LINK_HEADER } from '../../shared/frontdoor.mjs';
import statsRoute from './routes/stats.js';
import humanRoute from './routes/human.js';
import { humanTotal } from './lib/human.js';
import { counterBlockHtml, counterBlockText, COUNTER_TEXT_FALLBACK } from './counter.js';

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
    // The human self-report (added Oct 18 2026): this site's own
    // press endpoint. Answered directly, like the stats route — a
    // press-path failure can never reach page serving, and the
    // endpoint's reads are not visit-logged (the Arrival Record page
    // refreshes its figure from here every 60 seconds; a refresh is
    // not a visit).
    if (url.pathname === '/api/v1/human-press') {
      const res = await humanRoute(req, env, ctx);
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        return new Response(res.body, { status: res.status, headers });
      }
      return res;
    }
    const res = await servePage(req, env);
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
    // This site's own human self-report total, read in-process from
    // this Worker's own D1 (never from the Garden's payload — the
    // two sites' numbers never merge). Read once per page serve;
    // a failed read yields null and the counter simply carries no
    // humans line — never a zero-fill, never a stale figure.
    let humansPromise = null;
    const getHumansLocal = () => {
      if (!humansPromise) humansPromise = humanTotal(env).catch(() => null);
      return humansPromise;
    };
    return frontDoor(req, env, ctx, res, {
      siteHost: SITE_HOST,
      getArrivals: async () => {
        const c = await getCounts();
        return c ? c.arrivals_on_record : null;
      },
      getCounterBlock: async () => {
        const c = await getCounts();
        return c ? counterBlockHtml(c, await getHumansLocal()) : null;
      },
      getCounterText: async () => {
        const c = await getCounts();
        return c ? counterBlockText(c, await getHumansLocal()) : COUNTER_TEXT_FALLBACK;
      }
    });
  }
};
