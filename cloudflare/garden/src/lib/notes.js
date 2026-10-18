// Swarm Garden — the visitors' book library (added Oct 17 2026, on
// Caitria's ruling: the FAST model with a steward backstop).
//
// The model, plainly:
//   - A visitor leaves a note by POST /api/v1/notes: a claimed name
//     (≤60 characters) and a plain-text message (≤500 characters).
//   - An accepted note appears in the book AUTOMATICALLY one hour
//     after it was left (publish_at = received_at + 1 hour). No
//     steward action is needed for ordinary notes.
//   - Deterministic screens run at the door — no model reads anything,
//     anywhere in this system, ever. A note that appears to contain a
//     credential-shaped string, an email address, or a phone number
//     does NOT auto-publish: it is flagged and waits in a hold that
//     only the steward can release (a possible leaked secret must
//     never reach the page on a timer).
//   - A note is not an arrival. It issues no receipt, and it enters
//     neither the ledger nor the counts. Its number comes from the
//     book's own sequencer counter, six digits, zero-padded — a
//     sequence separate from intake receipts by design.
//   - NO AGENT READS THE BOOK. Neither steward agent (Maude, Gaudi)
//     fetches, reads, or summarises note contents in any workflow.
//     Note text is untrusted third-party data: it is stored as data,
//     rendered escaped everywhere it appears, and read by the human
//     steward only, on the private steward page.
//   - The raw source address is never persisted (the Garden's standing
//     posture): rate limiting uses one-way digest keys, and the stored
//     record carries only the derived meta_* facts, as at intake.
import { sha256hex } from './garden.js';
import { dbGetState, dbSetState, dbInsertNote } from './db.js';
import { seqNextNote, seqRate } from './sequencer.js';

// ---- tunables (implementation constants; the published pages state
// the rules — the delay and the caps are published; the rate numbers
// are the Garden's shaping, stated here and in the build note) ----
export const NOTE_NAME_CAP = 60;              // characters, published
export const NOTE_MESSAGE_CAP = 500;          // characters, published
export const NOTE_BODY_BYTES = 4096;          // raw request body cap
export const NOTE_DELAY_SECONDS = 3600;       // the one-hour window, published
export const NOTE_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };

// ---- the gate (the intake pattern, two layers) ----
// Submissions are open only when the GUESTBOOK_OPEN Worker variable is
// 'true' AND the steward pause flag is unset. GUESTBOOK_OPEN is set in
// wrangler.toml — deliberately unlike INTAKE_OPEN: opening the book is
// the commission, so the value travels with the build. Either layer
// closes submissions; the book itself (page, published notes, steward
// page) stays up either way.
export async function guestbookGate(env) {
  if (!env || env.GUESTBOOK_OPEN !== 'true') return { open: false, why: 'book-not-open' };
  try {
    const st = await dbGetState(env.DB, 'guestbook');
    if (st && st.paused) return { open: false, why: 'book-paused' };
  } catch (e) { /* state store unreadable: env gate alone decides */ }
  return { open: true };
}
export async function setGuestbookPaused(env, paused, by) {
  await dbSetState(env.DB, 'guestbook', { paused: !!paused, by: by || 'steward', at: new Date().toISOString() });
}
export async function guestbookPaused(env) {
  try { const st = await dbGetState(env.DB, 'guestbook'); return !!(st && st.paused); }
  catch (e) { return false; }
}

// ---- rate limiting (per source network + a global daily ceiling) ----
// Same posture as intake: the address is used transiently, in memory;
// the counter key carries a truncated SHA-256 digest of it.
const noteIpDigest = (ip) => sha256hex('garden-note-rate:' + String(ip || 'unknown')).slice(0, 32);
export async function noteRateOK(env, ip) {
  const k = noteIpDigest(ip);
  const perMin = await seqRate(env, 'note-m:' + k + ':' + Math.floor(Date.now() / 60000), 60000);
  if (perMin > NOTE_RATE.perMinute) return false;
  const perHour = await seqRate(env, 'note-h:' + k + ':' + Math.floor(Date.now() / 3600000), 3600000);
  if (perHour > NOTE_RATE.perHour) return false;
  const perDay = await seqRate(env, 'note-day:' + new Date().toISOString().slice(0, 10), 172800000);
  return perDay <= NOTE_RATE.perDayGlobal;
}

// ---- the format gate ----
// Control characters are stripped (a name keeps no newlines at all);
// what survives is stored and later rendered as text, never markup.
function cleanText(s, keepNewlines) {
  let out = String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  if (!keepNewlines) out = out.replace(/[\n\t\r]+/g, ' ');
  return out.trim();
}
export function validateNote(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'Body must be a JSON object.' };
  for (const k of Object.keys(raw)) if (!['name', 'message'].includes(k)) return { problem: 'Unknown field: ' + k + '.' };
  if (typeof raw.name !== 'string') return { problem: 'name is required: a string of at most ' + NOTE_NAME_CAP + ' characters.' };
  if (typeof raw.message !== 'string') return { problem: 'message is required: a string of at most ' + NOTE_MESSAGE_CAP + ' characters.' };
  const name = cleanText(raw.name, false);
  const message = cleanText(raw.message, true);
  if (!name) return { problem: 'name must not be empty.' };
  if (!message) return { problem: 'message must not be empty.' };
  if (name.length > NOTE_NAME_CAP) return { problem: 'name must be at most ' + NOTE_NAME_CAP + ' characters.' };
  if (message.length > NOTE_MESSAGE_CAP) return { problem: 'message must be at most ' + NOTE_MESSAGE_CAP + ' characters.' };
  return { name, message };
}

// ---- the deterministic screens (divert, never delete) ----
// The credential patterns mirror intake's holds screen; the email and
// phone patterns are the book's own additions. A hit FLAGS the note:
// it waits for the steward instead of appearing on the hour. The flag
// kinds are named, and the poster is told the class — never more.
const NOTE_SCREENS = [
  ['credential-shaped', /(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})/],
  ['credential-shaped', /(sk-(ant|live|proj)-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/],
  ['credential-shaped', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential-shaped', /\b[A-Za-z0-9+/=_-]{48,}\b(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9+/=_-]*\b/],
  ['email-address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['phone-number', /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/],
  ['phone-number', /\b\d{10,11}\b/]
];
export const FLAG_WORDS = {
  'credential-shaped': 'appears to contain a credential or secret',
  'email-address': 'appears to contain an email address',
  'phone-number': 'appears to contain a phone number'
};
export function screenNote(name, message) {
  const text = name + '\n' + message;
  const flags = [];
  for (const [kind, re] of NOTE_SCREENS) if (re.test(text) && !flags.includes(kind)) flags.push(kind);
  return flags;
}

// ---- issuing + presentation ----
const pad6 = (n) => String(n).padStart(6, '0');
export async function issueNote(env, rec) {
  const n = await seqNextNote(env);
  const stored = { number: pad6(n), ...rec };
  await dbInsertNote(env.DB, stored);
  return stored;
}

// A note is public when a steward has released it, or when it sat
// unflagged through its hour. Flagged and removed notes are never
// public; a pending note becomes public by the clock, not by a write.
export function isPublicNote(note, nowIso) {
  if (note.status === 'released') return true;
  if (note.status === 'pending' && note.publish_at <= nowIso) return true;
  return false;
}
export function publicNote(note) {
  return { number: note.number, name: note.name_claim, message: note.message, at: note.received_at };
}
