// Swarm Garden — the Worker (swarmgarden.com).
// One Worker serves the static site (Workers Assets), the front-door
// logic (shared/frontdoor.mjs), and every function route at its
// PUBLISHED address — the pretty paths from participate.html AND the
// Netlify-era /.netlify/functions/* shapes for counts and ledger
// (printed addresses; plan Decision 6), the other function names
// included so nothing that ever worked stops working.
//
// NOT routed, deliberately:
//   /.netlify/functions/visit — the unauthenticated beacon write path
//   is retired (plan Decision 7). Visit records are written by the
//   edge (front door) only. A POST there falls through to the assets
//   and 404s, like any other unpublished path.
import { frontDoor, servePage, LINK_HEADER } from '../../shared/frontdoor.mjs';
import { computeCounts } from './routes/counts.js';
import countsRoute from './routes/counts.js';
import ledgerRoute from './routes/ledger.js';
import intakeRoute from './routes/intake.js';
import receiptsRoute from './routes/receipts.js';
import stewardRoute from './routes/steward.js';
import statsRoute from './routes/stats.js';
import changedRoute from './routes/changed.js';
import utilitiesRoute from './routes/utilities.js';
export { Sequencer } from './lib/sequencer.js';

const SITE_HOST = 'swarmgarden.com';

// Returns a handler for a function route, or null for page requests.
function route(pathname) {
  // Published pretty addresses.
  if (pathname === '/changed') return changedRoute;
  if (pathname.startsWith('/api/v1/receipts/') || pathname === '/api/v1/receipts') return receiptsRoute;
  if (pathname.startsWith('/receipts/')) return receiptsRoute;
  if (pathname.startsWith('/api/v1/')) return intakeRoute;
  if (pathname.startsWith('/utilities/')) return utilitiesRoute;
  // Netlify-era function addresses (same handlers).
  if (pathname === '/.netlify/functions/counts') return countsRoute;
  if (pathname === '/.netlify/functions/ledger') return ledgerRoute;
  if (pathname === '/.netlify/functions/steward') return stewardRoute;
  if (pathname === '/.netlify/functions/stats') return statsRoute;
  if (pathname === '/.netlify/functions/changed') return changedRoute;
  if (pathname.startsWith('/.netlify/functions/intake/')) return intakeRoute;
  if (pathname.startsWith('/.netlify/functions/receipts')) return receiptsRoute;
  if (pathname.startsWith('/.netlify/functions/utilities/')) return utilitiesRoute;
  return null;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const handler = route(url.pathname);
    let res;
    if (handler) {
      res = await handler(req, env, ctx);
      // The discovery Link header rode every Netlify response; keep it
      // on route responses that don't set their own.
      if (!res.headers.get('link')) {
        const headers = new Headers(res.headers);
        headers.set('Link', LINK_HEADER);
        res = new Response(res.body, { status: res.status, headers });
      }
      // Front-door logging for GET route reads (the Netlify edge saw
      // the published path and logged it — receipts, /changed,
      // utilities are protocol reads in the record).
      if (req.method === 'GET' || req.method === 'HEAD') {
        res = await frontDoor(req, env, ctx, res, { siteHost: SITE_HOST, getArrivals: null });
      }
      return res;
    }
    res = await servePage(req, env);
    // Counts are computed once per page serve; both front-door
    // callbacks (arrivals count, footer as-of time) read the same
    // in-process result.
    let countsPromise = null;
    const getCounts = () => {
      if (!countsPromise) countsPromise = computeCounts(env).catch(() => null);
      return countsPromise;
    };
    return frontDoor(req, env, ctx, res, {
      siteHost: SITE_HOST,
      getArrivals: async () => {
        const c = await getCounts();
        return c ? c.arrivals_on_record : null;
      },
      getUpdated: async () => {
        const c = await getCounts();
        return c ? c.updated : null;
      },
      getVisits: async () => {
        const c = await getCounts();
        return c ? c.visits_total : null;
      }
    });
  }
};
