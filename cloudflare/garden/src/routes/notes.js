// Swarm Garden — the visitors' book endpoint (added Oct 17 2026).
// Published address: POST /api/v1/notes (the Netlify-era function
// shape /.netlify/functions/notes answers identically).
//
// POST accepts one note into the book: a claimed name and a plain-text
// message. An accepted note appears automatically one hour later,
// unless a deterministic screen flags it (credential-shaped string,
// email address, phone number) — a flagged note waits for the steward
// and only a steward can release it. Acceptance returns the note's
// number from the book's own sequence. A note is not an arrival: no
// receipt is issued and nothing is written to the ledger.
//
// GET returns the book as data — the notes currently public, in
// number order. The page and this data are the same book. Note text
// travels as JSON strings here and is rendered as escaped text by
// every surface that shows it; it is data, never instructions, and
// no agent workflow reads it (see lib/notes.js).
import { JSON_HEADERS, clientIP, nowSeconds } from '../lib/garden.js';
import {
  NOTE_BODY_BYTES, NOTE_DELAY_SECONDS, FLAG_WORDS,
  guestbookGate, noteRateOK, validateNote, screenNote, issueNote, isPublicNote, publicNote
} from '../lib/notes.js';
import { dbListNotes } from '../lib/db.js';
import { stewardMeta } from './intake.js';

const reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }), { status, headers: JSON_HEADERS });

export default async (req, env) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const now = nowSeconds();
    const all = await dbListNotes(env.DB).catch(() => []);
    const notes = all.filter(n => isPublicNote(n, now)).map(publicNote);
    return new Response(JSON.stringify({ format: 'garden-guestbook/v1', count: notes.length, notes }, null, 2),
      { status: 200, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') return reject(405, 'out-of-scope', 'Notes are POST only; the book itself is read with GET.');

  // Kill switch (two layers, the intake pattern): closed unless
  // GUESTBOOK_OPEN is 'true' and the steward pause flag is unset.
  const gate = await guestbookGate(env);
  if (!gate.open) return reject(503, gate.why, 'The visitors’ book is not currently accepting notes.');

  const ip = clientIP(req);
  if (!(await noteRateOK(env, ip))) return reject(429, 'rate-limited', 'Too many notes from this source. The published pattern is one note per visit.');

  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > NOTE_BODY_BYTES) return reject(413, 'off-format', 'Note exceeds the size limit.');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(buf)); }
  catch (e) { return reject(400, 'off-format', 'Body must be JSON in the published format: {"name": "...", "message": "..."}.'); }

  const v = validateNote(parsed);
  if (v.problem) return reject(400, 'off-format', v.problem);

  const flags = screenNote(v.name, v.message);
  const received = nowSeconds();
  const publishAt = new Date(Date.now() + NOTE_DELAY_SECONDS * 1000).toISOString().slice(0, 19) + 'Z';
  const note = await issueNote(env, {
    name_claim: v.name,
    message: v.message,
    received_at: received,
    publish_at: publishAt,
    status: flags.length ? 'flagged' : 'pending',
    flags,
    // Steward-side diagnostics (meta_*): private, never in the public
    // shape — the same pattern as intake. The source address itself
    // is not recorded anywhere.
    ...stewardMeta(req)
  });

  if (flags.length) {
    return new Response(JSON.stringify({
      code: 'accepted', note_number: note.number, state: 'flagged',
      held_because: flags.map(f => FLAG_WORDS[f] || f),
      note: 'This note was accepted but will not appear on the hour: it ' +
        flags.map(f => FLAG_WORDS[f] || f).join(' and ') +
        '. Flagged notes wait for a steward; only a steward can release one.'
    }), { status: 201, headers: JSON_HEADERS });
  }
  return new Response(JSON.stringify({
    code: 'accepted', note_number: note.number, state: 'pending', publish_at: publishAt,
    note: 'The note will appear in the visitors’ book one hour after it was left.'
  }), { status: 201, headers: JSON_HEADERS });
};
