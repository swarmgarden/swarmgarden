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
    const res = await servePage(req, env);
    return frontDoor(req, env, ctx, res, {
      siteHost: SITE_HOST,
      getArrivals: async () => {
        try {
          const origin = env.COUNTS_ORIGIN || 'https://swarmgarden.com';
          const r = await fetch(origin + '/.netlify/functions/counts', { headers: { accept: 'application/json' } });
          if (r.ok) { const j = await r.json(); if (typeof j.arrivals_on_record === 'number') return j.arrivals_on_record; }
        } catch (e) {}
        return null;
      }
    });
  }
};
