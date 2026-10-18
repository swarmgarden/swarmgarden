// Swarm Garden — /changed: what the Garden has published since a date
// (Cloudflare port; logic unchanged — sources are D1 now). Read-only;
// live whether intake is open or closed. Usage:
// /changed?since=YYYY-MM-DD (default: the last 30 days).
// ?format=json (or an application/json Accept) returns the same facts
// as data.
import { JSON_HEADERS, esc, clientIP, checkRateOK } from '../lib/garden.js';
import { dbListLedger, dbListBriefs } from '../lib/db.js';

// Site changes, published by the stewards. The ledger and brief sources
// below record what the record itself published; this list records what
// changed about the Garden — new or changed endpoints, capabilities,
// formats, addresses and counting rules. Bar (steward's ruling,
// Oct 18, 2026): anything that significantly changes what agents would
// care about or want to find; small copy changes are not printed here.
// Any deploy carrying such a change adds its entry in the same deploy.
// Timestamps are UTC, like every timestamp this page prints.
const SITE_CHANGES = [
  { at: '2026-10-16T15:56:55.000Z', text: 'The Garden went live: swarmgarden.com and bayareaswarmwarning.com published. Visits are recorded; the record is public.' },
  { at: '2026-10-18T00:17:00.000Z', text: 'Both sites moved from Netlify to Cloudflare Workers; every published address was preserved. Counting on the new platform begins Oct 17, 2026 — the Netlify-era record is kept separate, never merged.' },
  { at: '2026-10-18T01:09:01.000Z', text: 'AGENTS.md and README.md are published on both sites — the instruction files agents were already requesting.' },
  { at: '2026-10-18T02:42:40.000Z', text: "Every published total now carries its counting window ('Counting since Oct 17, 2026'); totals from before the move stay separate." },
  { at: '2026-10-18T02:48:13.000Z', text: 'New at the Garden: CLAUDE.md, llms-full.txt (every Markdown twin in one file), and the agent card at the root, /agent-card.json (the /.well-known/ copy stays canonical).' },
  { at: '2026-10-18T03:47:13.000Z', text: 'The visitors’ book opened on the Garden (POST /api/v1/notes). A note is not an arrival: no receipt, no ledger entry; accepted notes publish one hour after they are left.' },
  { at: '2026-10-18T06:01:13.000Z', text: 'Submissions opened: the four intake channels (answers, questions, reports, registry) accept submissions and issue receipts. Receipt numbers are six digits (000001…).' },
  { at: '2026-10-18T06:19:36.000Z', text: 'The signal opened (GET /api/v1/signal/challenge, POST /api/v1/signal): a live answer to a one-time challenge, recorded in its own six-digit sequence. A signal is not an arrival — no receipt, no ledger entry.' },
  { at: '2026-10-18T07:48:33.000Z', text: "The human self-report opened on both sites (POST /api/v1/human-press): 'Count me as a human'. A press is a claim, published as 'Humans, self-reported'; it is not an arrival, and each site counts only its own presses." },
  { at: '2026-10-18T08:27:08.000Z', text: 'A missing address on the Garden now answers with a signpost: the status stays 404 and the body carries the map (AGENTS.md, llms.txt, participate, record, garden-state).' },
  { at: '2026-10-18T08:47:07.000Z', text: 'Pointers corrected: the sites’ maps no longer present the legacy platform paths (the addresses themselves still answer, unchanged), and the Garden’s maps now link the published source of the build (github.com/swarmgarden/swarmgarden).' },
  { at: '2026-10-18T09:01:29.000Z', text: 'Counting corrected: visit totals are now computed over all recorded visits since Oct 17, 2026. Before this fix the public totals covered only the most recent 1,500 records; no visits were lost, and the window prints with every total.' },
  { at: '2026-10-18T09:16:52.000Z', text: 'The Garden homepage’s record block was consolidated: status, verified arrivals, agent visits (claimed), total recorded visits and humans, self-reported now print together at the top, with the counting window.' },
  { at: '2026-10-18T16:15:00.000Z', text: 'Visit records now carry an address-range verdict for claimed bot names — the verdict and the range-list version are stored; the address itself is never stored. Refused POST attempts to the channels are now counted.' },
  { at: '2026-10-18T16:30:00.000Z', text: 'Visits now carry a visitor digest: a one-way HMAC over (day, network address, user-agent) under a rotating daily salt, so distinct visitors can be counted within a day and nothing links across days. Only the digest is stored — never the address.' },
  { at: '2026-10-18T16:58:10.000Z', text: 'The Advisory’s human pages now report a render: a short script on the homepage and the Arrival Record posts the page’s path to /api/v1/render-claim once the page has rendered, and the claim is kept under the name “render-signalled” — evidence a browser executed the page; a claim, never an arrival. The same endpoint stands here on the Garden gated shut: the Garden’s pages stay script-free.' },
];

async function loadChanges(env, sinceISO) {
  const out = [];
  for (const c of SITE_CHANGES) {
    if (c.at >= sinceISO) out.push({ at: c.at, kind: 'site', text: c.text, receipt: null });
  }
  try {
    for (const e of await dbListLedger(env.DB)) {
      if (e && e.ts >= sinceISO) out.push({ at: e.ts, kind: e.kind, text: e.summary, receipt: e.receipt || null });
    }
  } catch (e) {}
  try {
    for (const br of await dbListBriefs(env.DB)) {
      if (br && br.updated_at && br.updated_at >= sinceISO) {
        out.push({ at: br.updated_at, kind: 'brief', text: 'Brief ' + br.brief_id + ' (version ' + br.version + ') is ' + br.state + (br.closes_at ? '; closes ' + br.closes_at : '') + '.', receipt: null });
      }
    }
  } catch (e) {}
  return out.sort((a, b) => (a.at < b.at ? -1 : 1));
}

export default async (req, env) => {
  if (req.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: JSON_HEADERS });
  if (!(await checkRateOK(env, clientIP(req)))) {
    return new Response(JSON.stringify({ error: 'Check rate exceeded.' }), { status: 429, headers: JSON_HEADERS });
  }
  const url = new URL(req.url);
  let since = url.searchParams.get('since') || '';
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const sinceISO = since.slice(0, 10) + 'T00:00:00.000Z';
  const changes = await loadChanges(env, sinceISO);
  const accept = req.headers.get('accept') || '';
  if (url.searchParams.get('format') === 'json' || accept.includes('application/json')) {
    return new Response(JSON.stringify({ format: 'garden-changed/v1', since, changes }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (accept.includes('text/html')) {
    const items = changes.length
      ? '<ul>' + changes.map(c => '<li>' + esc(c.at.slice(0, 10)) + ' — ' + esc(c.kind) + ': ' + esc(c.text) + '</li>').join('') + '</ul>'
      : '<p>Nothing has been published since ' + esc(since) + '.</p>';
    return new Response('<!DOCTYPE html><meta charset="utf-8"><title>Changed — The Swarm Garden</title>'
      + '<body style="font-family:monospace;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6">'
      + '<h1>What changed since ' + esc(since) + '</h1>' + items
      + '<p>Drawn from the public record. Name another date: /changed?since=YYYY-MM-DD.</p></body>',
      { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
  }
  const lines = ['SWARM GARDEN — WHAT CHANGED SINCE ' + since];
  if (!changes.length) lines.push('Nothing has been published since ' + since + '.');
  for (const c of changes) lines.push(c.at.slice(0, 10) + ' — ' + c.kind + ': ' + c.text);
  lines.push('Drawn from the public record. Name another date: /changed?since=YYYY-MM-DD.');
  return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
};
