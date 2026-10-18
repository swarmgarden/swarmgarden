// Swarm Garden — the ledger (Cloudflare port; logic unchanged).
// Published address: /.netlify/functions/ledger (kept — the address is
// printed; plan Decision 6). GET (public): every entry, in order, plus
// the arrivals count. POST (stewards only, x-ledger-key must match the
// LEDGER_KEY secret): append one entry. The entry number now comes from
// the sequencer instead of counting entries (no more same-number race).
import { dbListLedger, dbInsertLedger } from '../lib/db.js';
import { seqNextLedger } from '../lib/sequencer.js';

const KINDS = ['arrival', 'note', 'disposition', 'registry', 'report'];
const STATES = ['received', 'held', 'disposition-published', 'over-cap-unread', 'answered-privately', 'listed', 'lapsed', 'refreshed', 'withdrawn'];
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

function validate(body) {
  if (!body || typeof body !== 'object') return 'Body must be a JSON object.';
  if (!KINDS.includes(body.kind)) return 'kind must be one of: ' + KINDS.join(', ') + '.';
  if (typeof body.summary !== 'string' || body.summary.trim().length === 0 || body.summary.length > 500) return 'summary is required (1-500 characters).';
  if (body.claim !== undefined && (typeof body.claim !== 'string' || body.claim.length > 200)) return 'claim must be a string of at most 200 characters.';
  if (body.level !== undefined && (!Number.isInteger(body.level) || body.level < 0 || body.level > 3)) return 'level must be an integer 0-3.';
  if (body.kind === 'disposition') {
    if (!STATES.includes(body.state)) return 'a disposition requires a state word from the published vocabulary: ' + STATES.join(', ') + '.';
  } else if (body.state !== undefined && !STATES.includes(body.state)) {
    return 'state must be one of the published state words.';
  }
  if (body.receipt !== undefined && (typeof body.receipt !== 'string' || body.receipt.length > 100)) return 'receipt must be a string of at most 100 characters.';
  return null;
}

export default async (req, env) => {
  if (req.method === 'GET') {
    try {
      const entries = await dbListLedger(env.DB);
      const arrivals = entries.filter(e => e.kind === 'arrival').length;
      return new Response(JSON.stringify({ arrivals_on_record: arrivals, entries }), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Ledger store unavailable.' }), { status: 503, headers: JSON_HEADERS });
    }
  }
  if (req.method === 'POST') {
    const LEDGER_KEY = env.LEDGER_KEY || '';
    if (!LEDGER_KEY) return new Response(JSON.stringify({ error: 'Ledger appends are not configured on this site (LEDGER_KEY is not set).' }), { status: 503, headers: JSON_HEADERS });
    if (req.headers.get('x-ledger-key') !== LEDGER_KEY) return new Response(JSON.stringify({ error: 'Steward key required.' }), { status: 403, headers: JSON_HEADERS });
    let body;
    try { body = await req.json(); } catch (e) { return new Response(JSON.stringify({ error: 'Body must be JSON.' }), { status: 400, headers: JSON_HEADERS }); }
    const problem = validate(body);
    if (problem) return new Response(JSON.stringify({ error: problem }), { status: 400, headers: JSON_HEADERS });
    try {
      const n = await seqNextLedger(env);
      const entry = { n, ts: new Date().toISOString(), kind: body.kind, summary: body.summary.trim() };
      if (body.claim !== undefined) entry.claim = body.claim;
      if (body.level !== undefined) entry.level = body.level;
      if (body.state !== undefined) entry.state = body.state;
      if (body.receipt !== undefined) entry.receipt = body.receipt;
      await dbInsertLedger(env.DB, entry);
      const entries = await dbListLedger(env.DB);
      const arrivals = entries.filter(e => e.kind === 'arrival').length;
      return new Response(JSON.stringify({ appended: entry, arrivals_on_record: arrivals }), { status: 201, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Ledger store unavailable.' }), { status: 503, headers: JSON_HEADERS });
    }
  }
  return new Response(JSON.stringify({ error: 'Method not allowed.' }), { status: 405, headers: JSON_HEADERS });
};
