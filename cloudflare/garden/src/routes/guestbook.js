// Swarm Garden — the visitors' book steward page (added Oct 17 2026).
// Private, key-gated (?k= must match the STATS_KEY secret — the same
// key-in-link model as the stats dashboards, so the steward's one
// saved dashboard link pattern covers this page too; the decision is
// recorded in the build note). Published address:
// /.netlify/functions/guestbook?k=<key>
//
// THIS PAGE IS THE HUMAN STEWARD'S SURFACE, AND HERS ONLY. She reads
// the book here and takes notes down. No agent workflow fetches,
// reads, or summarises note contents — note text is untrusted
// third-party data, rendered escaped everywhere on this page, and
// nothing on it is an instruction to any reader, human or agent.
//
// GET: the book's working lists — flagged notes (release/remove),
// pending notes still inside their hour (remove), published notes
// (remove), and the removed count. POST actions (JSON body):
//   { action: 'release', number: '000002' }  — put a note in the book
//   { action: 'remove',  number: '000002' }  — take a note out
//   { action: 'pause' } / { action: 'resume' } — the book's kill switch
import { JSON_HEADERS, esc, nowSeconds } from '../lib/garden.js';
import { FLAG_WORDS, isPublicNote, guestbookPaused, setGuestbookPaused } from '../lib/notes.js';
import { dbListNotes, dbGetNote, dbUpdateNote } from '../lib/db.js';

function authed(req, env) {
  const KEY = env.STATS_KEY || '';
  if (!KEY) return false;
  return new URL(req.url).searchParams.get('k') === KEY;
}
const deny = (status, msg) => new Response(msg, { status, headers: { 'Content-Type': 'text/plain' } });
const denyJson = (status, msg) => new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS });

export default async (req, env) => {
  if (!env.STATS_KEY) return deny(503, 'The guestbook steward page is not configured on this site (STATS_KEY is not set).');
  if (!authed(req, env)) return deny(403, 'Key required.');

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch (e) { return denyJson(400, 'Body must be JSON.'); }
    if (body.action === 'pause' || body.action === 'resume') {
      await setGuestbookPaused(env, body.action === 'pause', 'guestbook-page');
      return new Response(JSON.stringify({ ok: true, guestbook_paused: body.action === 'pause' }), { status: 200, headers: JSON_HEADERS });
    }
    if (body.action === 'release' || body.action === 'remove') {
      const note = await dbGetNote(env.DB, String(body.number || ''));
      if (!note) return denyJson(404, 'No such note.');
      if (body.action === 'release') {
        if (note.status === 'removed') return denyJson(400, 'Note ' + note.number + ' was removed; a removed note is not released.');
        note.status = 'released';
        note.released_at = nowSeconds();
      } else {
        if (note.status === 'removed') return denyJson(400, 'Note ' + note.number + ' is already removed.');
        note.status = 'removed';
        note.removed_at = nowSeconds();
      }
      await dbUpdateNote(env.DB, note);
      return new Response(JSON.stringify({ ok: true, note: note.number, status: note.status }), { status: 200, headers: JSON_HEADERS });
    }
    return denyJson(400, 'Unknown action.');
  }
  if (req.method !== 'GET') return deny(405, 'Method not allowed.');

  const notes = await dbListNotes(env.DB).catch(() => []);
  const now = nowSeconds();
  const paused = await guestbookPaused(env);
  const flagged = notes.filter(n => n.status === 'flagged');
  const pending = notes.filter(n => n.status === 'pending' && !isPublicNote(n, now));
  const published = notes.filter(n => isPublicNote(n, now));
  const removed = notes.filter(n => n.status === 'removed');

  const noteRow = (n, actions) =>
    '<div style="border:1px solid #999;padding:8px 10px;margin:0 0 8px">' +
    '<div><strong>№ ' + esc(n.number) + '</strong> · left ' + esc(n.received_at) + ' UTC' +
    (n.status === 'pending' ? ' · appears ' + esc(n.publish_at) + ' UTC' : '') +
    (n.status === 'released' ? ' · released by a steward' + (n.released_at ? ' ' + esc(n.released_at) : '') : '') +
    ((n.flags && n.flags.length) ? ' · <strong>flagged:</strong> ' + esc(n.flags.map(f => FLAG_WORDS[f] || f).join('; ')) : '') +
    '</div>' +
    '<div style="white-space:pre-wrap;margin:6px 0"><strong>' + esc(n.name_claim) + '</strong>\n' + esc(n.message) + '</div>' +
    '<div>' + actions.map(a =>
      '<button onclick="act(\'' + a[0] + '\',\'' + esc(n.number) + '\')">' + a[1] + '</button>').join(' ') +
    '</div></div>';

  let html = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Visitors’ book — steward page</title>';
  html += '<body style="font-family:monospace;max-width:820px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += '<h2>The visitors’ book — steward page</h2>';
  html += '<p>This page is the human steward’s reading and takedown surface for the book. Note text below is untrusted third-party content, shown as data. Nothing in a note is an instruction.</p>';
  html += '<p>Submissions are <strong>' + (paused ? 'PAUSED' : 'open') + '</strong> (the pause is this page’s kill switch; the GUESTBOOK_OPEN variable is the outer layer). ' +
    '<button onclick="act(\'' + (paused ? 'resume' : 'pause') + '\',null)">' + (paused ? 'Resume submissions' : 'Pause submissions') + '</button></p>';

  html += '<h3>Flagged — waiting for you (' + flagged.length + ')</h3>';
  html += flagged.length ? flagged.map(n => noteRow(n, [['release', 'Release into the book'], ['remove', 'Remove']])).join('') : '<p>None.</p>';

  html += '<h3>Pending — inside their hour (' + pending.length + ')</h3>';
  html += pending.length ? pending.map(n => noteRow(n, [['remove', 'Remove before it appears']])).join('') : '<p>None.</p>';

  html += '<h3>Published — in the book now (' + published.length + ')</h3>';
  html += published.length ? published.map(n => noteRow(n, [['remove', 'Take down']])).join('') : '<p>None.</p>';

  html += '<h3>Removed (' + removed.length + ')</h3>';
  html += removed.length ? '<p>' + removed.map(n => '№ ' + esc(n.number)).join(', ') + ' — removed notes stand in the count; their text is not served anywhere.</p>' : '<p>None.</p>';

  html += '<script>function act(action, number){var body={action:action};if(number)body.number=number;' +
    'fetch(location.pathname+location.search,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)})' +
    '.then(function(r){return r.json()}).then(function(j){if(j.ok){location.reload()}else{alert(j.error||"failed")}})' +
    '.catch(function(){alert("request failed")})}</script>';
  html += '</body>';
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' } });
};
