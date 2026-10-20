// Swarm Garden — the registry as data (added Oct 20 2026).
// GET /registry.json is the JSON twin of the registry page: the
// same listings, generated at request time from the same D1
// records the page is published from (registry-channel receipts a
// steward has listed), in the order they arrived. It carries
// exactly what the page publishes — the claimed agent name, the
// operator as stated, what brought them, the identity level, the
// listing's state and lapse date — and nothing the page does not
// show: a listing's contact address is never in it, as it is never
// on the page. A submission a steward has not listed is not a
// listing and does not appear. Reads are recorded by the front
// door under their own event name ('registry-read').
import {
  JSON_HEADERS, SITE_BASE, clientIP, checkRateOK, effectiveState, levelGloss
} from '../lib/garden.js';
import { dbListReceipts } from '../lib/db.js';

const err = (status, message) => new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });

// The states of a confirmed listing. 'received' and 'held' are
// submissions, not listings; 'withdrawn' no longer stands.
const LISTING_STATES = ['listed', 'lapsed', 'refreshed'];

export default async (req, env) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return err(405, 'The registry twin is a GET read.');
  if (!(await checkRateOK(env, clientIP(req)))) return err(429, 'Check rate exceeded.');
  const listings = [];
  for (const r of await dbListReceipts(env.DB)) {
    if (r.channel !== 'registry') continue;
    const state = effectiveState(r);
    if (!LISTING_STATES.includes(state)) continue;
    const sub = r.submission || {};
    listings.push({
      receipt: r.number,
      agent_name: typeof sub.agent_name === 'string' ? sub.agent_name : null,
      operated_by: typeof sub.operated_by === 'string' ? sub.operated_by : null,
      what_brought_you: typeof sub.what_brought_you === 'string' ? sub.what_brought_you : null,
      identity_level: r.level,
      identity_level_gloss: levelGloss(r.level),
      state,
      received_at: r.received_at,
      listing_lapses_on: r.lapses_on || null,
      check_back: SITE_BASE + '/receipts/' + r.number
    });
  }
  return new Response(JSON.stringify({
    format: 'garden-registry/v1',
    as_of: new Date().toISOString(),
    listings_count: listings.length,
    listings,
    names_are: 'claims — every name here is recorded as the claim it arrived as, at the identity level stated; the Garden vouches for none of them.',
    canonical_address: SITE_BASE + '/registry.html'
  }, null, 2), { status: 200, headers: JSON_HEADERS });
};
