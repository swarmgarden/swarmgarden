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
//   and 404s, like any other unpublished path — and, since Oct 18
//   2026 (lens spec B-b), leaves one row in the D1 api_attempts table
//   (channel 'unrouted'): refused POSTs are counted, bodies never
//   stored. The same wrap counts refusals on every routed channel.
import { frontDoor, servePage, LINK_HEADER } from '../../shared/frontdoor.mjs';
import { channelForPath, logAttempt } from '../../shared/attempts.mjs';
import { countingParts } from '../../shared/counting.mjs';
import { computeCounts } from './routes/counts.js';
import countsRoute from './routes/counts.js';
import ledgerRoute from './routes/ledger.js';
import intakeRoute from './routes/intake.js';
import receiptsRoute from './routes/receipts.js';
import stewardRoute from './routes/steward.js';
import statsRoute from './routes/stats.js';
import changedRoute from './routes/changed.js';
import utilitiesRoute from './routes/utilities.js';
import notesRoute from './routes/notes.js';
import guestbookStewardRoute from './routes/guestbook.js';
import { challengeRoute, signalRoute } from './routes/signal.js';
import humanRoute from './routes/human.js';
import renderRoute from './routes/render.js';
import dataJsonRoute from './routes/data.js';
import { signpost404 } from './lib/signpost.js';
export { Sequencer } from './lib/sequencer.js';

const SITE_HOST = 'swarmgarden.com';

// Returns a handler for a function route, or null for page requests.
function route(pathname) {
  // Published pretty addresses.
  if (pathname === '/changed') return changedRoute;
  // The visitors' book (added Oct 17 2026): matched BEFORE the generic
  // /api/v1/ branch, which is the intake router — the book is not an
  // intake channel and stays live while intake is closed.
  if (pathname === '/api/v1/notes') return notesRoute;
  if (pathname === '/.netlify/functions/notes') return notesRoute;
  // The signal (added Oct 17 2026): likewise matched BEFORE the
  // generic /api/v1/ intake branch — the signal is not an intake
  // channel and stays live on its own gate (SIGNAL_OPEN).
  if (pathname === '/api/v1/signal/challenge') return challengeRoute;
  if (pathname === '/api/v1/signal') return signalRoute;
  // The human self-report (added Oct 18 2026): likewise matched
  // BEFORE the generic /api/v1/ intake branch — a press is not an
  // intake channel and stands on its own gate (HUMAN_OPEN).
  if (pathname === '/api/v1/human-press') return humanRoute;
  // The render claim (added Oct 18 2026, lens spec B-d): likewise
  // matched BEFORE the generic /api/v1/ intake branch. On the
  // Garden the endpoint stands gated shut (RENDER_OPEN absent —
  // no Garden page carries the script); the route answers its
  // how-to on GET and refuses POSTs, and the refusals are counted
  // as knocks on the 'render-claim' channel by the wrap below.
  if (pathname === '/api/v1/render-claim') return renderRoute;
  if (pathname === '/.netlify/functions/guestbook') return guestbookStewardRoute;
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
    // The published data files (added Oct 18 2026, ASAP Item 2):
    // GET/HEAD /data/<published-name>.json answers directly here,
    // before the route table — exactly the Advisory's discipline.
    // Any other /data/* path, and any non-GET/HEAD method, falls
    // through to the ordinary handling below (and its 404 signpost).
    // D3.2 (Oct 19 2026) REVERSES the Oct 18 no-logging rule for
    // this branch: reads of the record now write one 'data-read'
    // visit record each, through the front door like every other
    // public read — the audit found the record's own reads were the
    // largest blind spot in the measurement (a reader of the record
    // DOES write themselves into it; that is the honest count). The
    // reversal is deliberate and is named in PORT-NOTES; the Oct 18
    // harness pin asserting no record was reversed with it.
    if ((req.method === 'GET' || req.method === 'HEAD')
        && url.pathname.startsWith('/data/')) {
      const jm = url.pathname.match(/^\/data\/([a-z0-9\-]+\.json)$/);
      if (jm) {
        let res = await dataJsonRoute(req, env, ctx, jm[1]);
        res = await frontDoor(req, env, ctx, res, { siteHost: SITE_HOST, getArrivals: null });
        if (!res.headers.get('link')) {
          const headers = new Headers(res.headers);
          headers.set('Link', LINK_HEADER);
          res = new Response(res.body, { status: res.status, headers });
        }
        return res;
      }
    }
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
      } else {
        // Refused-POST attempt counting (lens spec B-b): a refusal on
        // a published channel writes one api_attempts row; a success
        // writes none (the channel counts its own). Steward routes
        // map to no channel and are not counted.
        const channel = channelForPath(url.pathname);
        if (channel) {
          const w = logAttempt(env, req, res, channel);
          if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(w);
        }
      }
      return res;
    }
    res = await servePage(req, env);
    // Unrouted POSTs (lens spec B-b): a non-GET/HEAD request with no
    // route, refused by the page branch, is a knock too. Widened
    // (Oct 19 2026, D3.3): ANY refusal status counts (>= 400, not
    // only 404 — a 405/500 unrouted response was going uncounted),
    // and the channel is the path's own channel when it has one
    // (channelForPath — the utilities mapping included), else
    // 'unrouted'.
    if (req.method !== 'GET' && req.method !== 'HEAD' && res.status >= 400) {
      const w = logAttempt(env, req, res, channelForPath(url.pathname) || 'unrouted');
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(w);
    }
    // The signpost 404 (Oct 18 2026): a page-branch 404 keeps its
    // status — and its visit record — but its body points back to
    // the door and the record (lib/signpost.js). Route responses
    // never reach this line, so the channels' own refusals stand.
    if (res.status === 404) res = signpost404(req);
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
      },
      // The counting window beside the homepage total (Oct 17 2026):
      // the "Counting since" row's span gets the start date only —
      // "Oct 17, 2026" — computed from the payload's counting_since
      // at serve time. The age wording that used to trail the date
      // was removed by Caitria's ruling (Oct 18 2026): the row ends
      // at the date. Null when the payload carries none — the row
      // then keeps its published start date, which is true on its own.
      getWindow: async () => {
        const c = await getCounts();
        if (!c) return null;
        const p = countingParts(c.counting_since);
        return p ? p.date : null;
      },
      // Agent visits (claimed) beside the verified figure (Oct 17
      // 2026, Caitria's direction): the Garden's OWN class count from
      // the same payload — computeCounts reads only this Worker's
      // D1 ledger and this site's visit store, so the figure is
      // swarmgarden.com's alone, never a both-sites sum. An absent
      // class key in a successfully computed payload means zero such
      // visits in the window; a failed payload yields null and the
      // page serves as published (no number), like every other row.
      getAgentClaimed: async () => {
        const c = await getCounts();
        if (!c || !c.visits_by_class) return null;
        const v = c.visits_by_class['agent-claimed'];
        return typeof v === 'number' ? v : 0;
      },
      // Humans, self-reported (Oct 18 2026): the press count from the
      // same payload — this Worker's own D1 press table only, so the
      // figure is swarmgarden.com's alone. A failed payload yields
      // null and the row keeps its published fallback text, like
      // every other row.
      getHumans: async () => {
        const c = await getCounts();
        return c && typeof c.humans_total === 'number' ? c.humans_total : null;
      }
    });
  }
};
