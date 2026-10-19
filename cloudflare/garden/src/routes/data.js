// The Swarm Garden — the record as data, on the Garden's own
// domain (added Oct 18 2026, ASAP build Item 2): the published
// data files under /data/*.json — the same files the Advisory's
// data pages render (bayareaswarmwarning.com/data), served here
// so an agent standing in the Garden can read the Garden's record
// as data without leaving for the human site.
//
// Where the data comes from: NOT this Worker's stores. The hourly
// snapshot job publishes the data files into the public repository
// (github.com/swarmgarden/swarmgarden, data/ tree) from its own
// pulls; this route serves the latest published files, fetched
// from the repository and cached at the edge — the Advisory
// route's exact discipline (routes/data.js there). The git
// history is the permanent archive. Publishing into the repo
// first is what keeps this honest when a pull fails: the last
// completed pull stays up, wearing its own as-of.
//
// Answered directly in the router, before the route table, like
// the Advisory's data routes, so a data failure can never reach
// page serving. Since D3.2 (Oct 19 2026) the router wraps the
// response in the front door: each read writes one 'data-read'
// visit record — the Oct 18 no-logging rule was reversed by the
// measurement-accuracy build (see src/index.js).
// Only the published file names answer — the whitelist is
// extended by name, never by pattern; any other /data/* path
// falls through to the Garden's ordinary handling (and its 404
// signpost).
//
// PRIVACY (hard): the published files carry no visitor digest
// values, no referers, no region/ASN/network fields, no raw
// addresses (the record stores none). This route publishes
// nothing beyond what the files carry.

const DATA_BASE_DEFAULT = 'https://raw.githubusercontent.com/swarmgarden/swarmgarden/main';
const DATA_FILES = ['garden.json', 'garden-claims.json', 'garden-recent.json',
  'garden-paths.json', 'garden-countries.json', 'garden-series.json', 'garden-responses.json',
  'garden-knocks.json', 'garden-renders.json', 'garden-rendering.json',
  'advisory.json', 'advisory-claims.json', 'advisory-recent.json',
  'advisory-paths.json', 'advisory-countries.json', 'advisory-series.json', 'advisory-responses.json',
  'advisory-knocks.json', 'advisory-renders.json', 'advisory-rendering.json',
  'status.json'];
const REPO_DATA_URL = 'https://github.com/swarmgarden/swarmgarden/tree/main/data';
const FRESH_MS = 10 * 60 * 1000; // publication cadence is hourly

function dataBase(env) {
  return (env && env.DATA_BASE_URL) || DATA_BASE_DEFAULT;
}

async function loadDataFile(env, ctx, name) {
  // Test/override seam: DATA_INLINE carries {filename: contents}.
  if (env && env.DATA_INLINE) {
    try {
      const m = JSON.parse(env.DATA_INLINE);
      if (m && typeof m[name] === 'string') return { text: m[name], stale: false };
    } catch (e) {}
  }
  const url = dataBase(env) + '/data/' + name;
  let cache = null;
  try { cache = caches.default; } catch (e) {}
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const at = Number(hit.headers.get('x-data-fetched-at') || 0);
        if (Date.now() - at < FRESH_MS) return { text: await hit.text(), stale: false };
      }
    } catch (e) {}
  }
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'swarm-garden-data-page/1.0' } });
    if (!r.ok) throw new Error('data fetch ' + r.status);
    const text = await r.text();
    if (cache) {
      const put = cache.put(url, new Response(text, {
        headers: { 'content-type': 'application/json', 'x-data-fetched-at': String(Date.now()) }
      })).catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put); else await put;
    }
    return { text, stale: false };
  } catch (e) {
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) return { text: await hit.text(), stale: true };
      } catch (e2) {}
    }
    return null;
  }
}

export default async (req, env, ctx, name) => {
  if (!DATA_FILES.includes(name)) {
    return new Response(JSON.stringify({ error: 'No such data file. The published files are the per-site bundles (figures, claims, recent, paths, countries, series, responses, knocks, renders) and status.json; the data pages are at https://bayareaswarmwarning.com/data and the archive is at ' + REPO_DATA_URL }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  const got = await loadDataFile(env, ctx, name);
  if (!got) {
    return new Response(JSON.stringify({ error: 'The published data file could not be loaded for this request. The archive is at ' + REPO_DATA_URL }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(got.text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
  });
};
