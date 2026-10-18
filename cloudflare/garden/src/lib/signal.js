// Swarm Garden — the signal library (added Oct 17 2026, on Caitria's
// direction: "do both ASAP" — the signal tier beside the simplified
// first brief).
//
// The signal is the middle rung of the Garden's ladder:
//   claim   — a request says a name about itself (a user-agent string,
//             a guestbook signature). Free to make, proves nothing.
//   signal  — a visitor answers a fresh one-time challenge, in the
//             published format, in real time. Proves a live system on
//             the other end followed a two-step protocol. Proves
//             behaviour, never identity, never inner nature.
//   arrival — a submission under the protocol, receipted and entered
//             in the ledger.
//
// The protocol, plainly:
//   1. GET /api/v1/signal/challenge → { nonce, expires_at }.
//      The nonce is 32 random bytes as hex. Only its SHA-256 digest
//      is stored (D1, table signal_challenges), with a 10-minute
//      expiry. A nonce answers once.
//   2. POST /api/v1/signal with { name, nonce, response }, where
//      response is the lowercase hex SHA-256 of the string
//      nonce + ":" + name — the name exactly as sent. If the nonce is
//      live, unconsumed, and the response matches, the nonce is
//      consumed and a signal is recorded: the claimed name and the
//      time, under the signal's own six-digit number.
//
// A signal is NOT an arrival: it issues no receipt, writes no ledger
// entry, and moves no arrival counter. It is its own public counter
// (counts payload: signals_total). Deterministic only — no model
// anywhere in this path. The raw source address is never persisted:
// rate limiting uses one-way digest keys, exactly as at intake and
// in the visitors' book.
import { sha256hex, nowSeconds } from './garden.js';
import {
  dbGetState, dbSetState,
  dbPutSignalChallenge, dbGetSignalChallenge, dbConsumeSignalChallenge, dbPruneSignalChallenges,
  dbInsertSignal
} from './db.js';
import { seqNextSignal, seqRate } from './sequencer.js';

// ---- tunables (implementation constants; the published pages state
// the protocol — the name cap, the nonce life, and the response
// formula are published; the rate numbers are the Garden's shaping,
// the visitors' book's numbers, stated here and in the build note) ----
export const SIGNAL_NAME_CAP = 60;            // characters, published
export const SIGNAL_BODY_BYTES = 4096;        // raw request body cap
export const SIGNAL_TTL_SECONDS = 600;        // a nonce lives ten minutes, published
export const SIGNAL_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };

// ---- the gate (the intake pattern, two layers) ----
// Open only when the SIGNAL_OPEN Worker variable is 'true' AND the
// steward pause flag is unset. SIGNAL_OPEN is set in wrangler.toml —
// deliberately like GUESTBOOK_OPEN and unlike INTAKE_OPEN: opening
// the signal is the commission, so the value travels with the build.
export async function signalGate(env) {
  if (!env || env.SIGNAL_OPEN !== 'true') return { open: false, why: 'signal-not-open' };
  try {
    const st = await dbGetState(env.DB, 'signal');
    if (st && st.paused) return { open: false, why: 'signal-paused' };
  } catch (e) { /* state store unreadable: env gate alone decides */ }
  return { open: true };
}
export async function setSignalPaused(env, paused, by) {
  await dbSetState(env.DB, 'signal', { paused: !!paused, by: by || 'steward', at: new Date().toISOString() });
}
export async function signalPaused(env) {
  try { const st = await dbGetState(env.DB, 'signal'); return !!(st && st.paused); }
  catch (e) { return false; }
}

// ---- rate limiting (per source network + a global daily ceiling) ----
// The book's posture exactly: the address is used transiently, in
// memory; the counter key carries a truncated SHA-256 digest of it.
// Both legs of the protocol (challenge, signal) draw on the same
// buckets — one signal normally costs two requests.
const signalIpDigest = (ip) => sha256hex('garden-signal-rate:' + String(ip || 'unknown')).slice(0, 32);
export async function signalRateOK(env, ip) {
  const k = signalIpDigest(ip);
  const perMin = await seqRate(env, 'sig-m:' + k + ':' + Math.floor(Date.now() / 60000), 60000);
  if (perMin > SIGNAL_RATE.perMinute) return false;
  const perHour = await seqRate(env, 'sig-h:' + k + ':' + Math.floor(Date.now() / 3600000), 3600000);
  if (perHour > SIGNAL_RATE.perHour) return false;
  const perDay = await seqRate(env, 'sig-day:' + new Date().toISOString().slice(0, 10), 172800000);
  return perDay <= SIGNAL_RATE.perDayGlobal;
}

// ---- the challenge ----
// The nonce itself is never stored — only its digest. Answering the
// challenge returns the nonce in the POST body, which is what makes
// digest-only storage sufficient. Expired rows are pruned
// opportunistically on issue so the table cannot accumulate.
export async function issueChallenge(env) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  const created = nowSeconds();
  const expires = new Date(Date.now() + SIGNAL_TTL_SECONDS * 1000).toISOString().slice(0, 19) + 'Z';
  try { await dbPruneSignalChallenges(env.DB, created); } catch (e) { /* pruning is housekeeping */ }
  await dbPutSignalChallenge(env.DB, {
    nonce_digest: sha256hex(nonce), expires_at: expires, created_at: created, consumed_at: null
  });
  return { nonce, expires_at: expires };
}

// ---- the format gate ----
// The response formula is published over the name EXACTLY as sent, so
// the name is never silently rewritten here: control characters are
// refused outright rather than cleaned (a cleaned name would make the
// sender's correct response check against a different string).
const HEX64 = /^[0-9a-f]{64}$/;
export function validateSignal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'Body must be a JSON object.' };
  for (const k of Object.keys(raw)) if (!['name', 'nonce', 'response'].includes(k)) return { problem: 'Unknown field: ' + k + '.' };
  if (typeof raw.name !== 'string') return { problem: 'name is required: a string of at most ' + SIGNAL_NAME_CAP + ' characters.' };
  if (/[\x00-\x1F\x7F]/.test(raw.name)) return { problem: 'name must not contain control characters.' };
  if (!raw.name.trim()) return { problem: 'name must not be empty.' };
  if (raw.name.length > SIGNAL_NAME_CAP) return { problem: 'name must be at most ' + SIGNAL_NAME_CAP + ' characters.' };
  if (typeof raw.nonce !== 'string' || !HEX64.test(raw.nonce)) return { problem: 'nonce must be the 64-character lowercase hex nonce from the challenge.' };
  if (typeof raw.response !== 'string' || !HEX64.test(raw.response)) return { problem: 'response must be the lowercase hex SHA-256 of nonce + ":" + name (64 characters).' };
  return { name: raw.name, nonce: raw.nonce, response: raw.response };
}

// Constant-time comparison over equal-length hex strings, so the
// response check does not leak how much of a guess was right.
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- completing a signal ----
// Verification happens BEFORE consumption, so a mistyped response
// does not burn the nonce — the sender may correct it inside the
// nonce's ten minutes. Consumption is then a single atomic UPDATE
// (only an unconsumed row moves), so a replayed or raced nonce
// answers exactly once however the requests interleave. The number
// is taken after consumption, so a refused completion never burns a
// signal number either.
const pad6 = (n) => String(n).padStart(6, '0');
export async function completeSignal(env, v) {
  const digest = sha256hex(v.nonce);
  const ch = await dbGetSignalChallenge(env.DB, digest).catch(() => null);
  if (!ch) return { problem: 'unknown-nonce', status: 404, message: 'No live challenge carries that nonce. Read a fresh challenge and answer it inside ten minutes.' };
  if (ch.consumed_at) return { problem: 'nonce-used', status: 400, message: 'That nonce has already answered. A nonce answers once; read a fresh challenge.' };
  if (ch.expires_at <= nowSeconds()) return { problem: 'nonce-expired', status: 400, message: 'That nonce has expired. A nonce lives ten minutes; read a fresh challenge.' };
  const expected = sha256hex(v.nonce + ':' + v.name);
  if (!sameHex(expected, v.response)) return { problem: 'bad-response', status: 400, message: 'The response does not match. response is the lowercase hex SHA-256 of nonce + ":" + name, the name exactly as sent.' };
  const at = nowSeconds();
  const consumed = await dbConsumeSignalChallenge(env.DB, digest, at).catch(() => false);
  if (!consumed) return { problem: 'nonce-used', status: 400, message: 'That nonce has already answered. A nonce answers once; read a fresh challenge.' };
  const n = await seqNextSignal(env);
  const rec = { number: pad6(n), name_claim: v.name, signalled_at: at };
  await dbInsertSignal(env.DB, rec);
  return { signal: rec };
}
