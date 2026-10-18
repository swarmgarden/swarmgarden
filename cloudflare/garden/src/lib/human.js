// Swarm Garden — the human self-report library (added Oct 18 2026,
// on Caitria's ruling: button copy variant A, "Count me as a human").
//
// The button is the symmetric instrument to the rest of the Garden.
// The experiment looks for agents that SAY they are agents; this lets
// a human say they are a human. A press is a CLAIM, exactly like a
// user-agent string — and that is fine, because of what it is for:
// it sorts claims, it does not prove humanity. Its published figure
// is "Humans, self-reported", and its gloss travels with it.
//
// A press is NOT an arrival, mechanically: it issues no receipt,
// writes no ledger entry, and moves no visit or signal count. It
// lives in its own D1 tables under its own six-digit sequence
// (sequencer /next-human), apart from receipts, notes, and signals.
//
// The model, plainly:
//   - POST /api/v1/human-press with an empty body (the button's form
//     post, or an empty JSON object). The press is the whole act: no
//     name, no account, no cookie, no form fields.
//   - One COUNTED press per network per day. The network is carried
//     only as a one-way SHA-256 digest (the intake/book/signal
//     posture); the raw address is never persisted. A repeat press
//     the same day returns the presser's existing number — the
//     intake duplicate-collapse pattern — and counts once.
//   - The dedupe fingerprint rows are pruned once their day has
//     passed, as the published data note under the button states.
//   - Rate posture mirrors the signal: 3/min + 20/hour per network
//     digest, and a 300/day global cap on counted presses.
//   - Deterministic only — no model anywhere in this path.
import { sha256hex, nowSeconds } from './garden.js';
import {
  dbGetState, dbSetState,
  dbGetHumanDedupe, dbRecordHumanPress, dbCountHumanPresses, dbPruneHumanDedupe
} from './db.js';
import { seqNextHuman, seqRate } from './sequencer.js';

// ---- tunables ----
export const HUMAN_BODY_BYTES = 4096;         // raw request body cap
export const HUMAN_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };

// ---- the published words (the design note's copy; the gloss was
// shortened to "(a claim)" by Caitria's ruling, Oct 18 2026) ----
export const HUMAN_LABEL = 'Humans, self-reported';
export const HUMAN_GLOSS = '(a claim)';
export const HUMAN_DATA_NOTE = 'One press stores the press and its time — nothing else: no name, no account, no address. A one-way fingerprint of your connection is kept for a day, only to stop repeat presses counting twice, then deleted.';
export const humanConfirmation = (number) =>
  'Counted. You are now part of the weather: one claimed human. This proves nothing — a machine could press this button, ' +
  'and the record will say so right next to your number. Claimed human № ' + number + '. ' +
  'The agents get a receipt for arriving. You get a number for saying so. Fair is fair.';

// ---- the gate (the intake pattern, two layers) ----
// Open only when the HUMAN_OPEN Worker variable is 'true' AND the
// steward pause flag is unset. HUMAN_OPEN is set in wrangler.toml —
// deliberately like GUESTBOOK_OPEN and SIGNAL_OPEN: opening the
// button was the commission, so the value travels with the build.
export async function humanGate(env) {
  if (!env || env.HUMAN_OPEN !== 'true') return { open: false, why: 'human-not-open' };
  try {
    const st = await dbGetState(env.DB, 'human');
    if (st && st.paused) return { open: false, why: 'human-paused' };
  } catch (e) { /* state store unreadable: env gate alone decides */ }
  return { open: true };
}
export async function setHumanPaused(env, paused, by) {
  await dbSetState(env.DB, 'human', { paused: !!paused, by: by || 'steward', at: new Date().toISOString() });
}
export async function humanPaused(env) {
  try { const st = await dbGetState(env.DB, 'human'); return !!(st && st.paused); }
  catch (e) { return false; }
}

// ---- rate limiting (per source network; the global daily cap on
// counted presses is applied inside pressHuman, below) ----
// The signal's posture exactly: the address is used transiently, in
// memory; the counter key carries a truncated SHA-256 digest of it.
// The same digest keys the day's dedupe row — one fingerprint, kept
// for the day, exactly as the published data note states.
const humanIpDigest = (ip) => sha256hex('garden-human-rate:' + String(ip || 'unknown')).slice(0, 32);
export async function humanRateOK(env, ip) {
  const k = humanIpDigest(ip);
  const perMin = await seqRate(env, 'hum-m:' + k + ':' + Math.floor(Date.now() / 60000), 60000);
  if (perMin > HUMAN_RATE.perMinute) return false;
  const perHour = await seqRate(env, 'hum-h:' + k + ':' + Math.floor(Date.now() / 3600000), 3600000);
  return perHour <= HUMAN_RATE.perHour;
}
async function humanGlobalOK(env) {
  const perDay = await seqRate(env, 'hum-day:' + new Date().toISOString().slice(0, 10), 172800000);
  return perDay <= HUMAN_RATE.perDayGlobal;
}

// ---- the press ----
// Order matters, and mirrors the doors:
//   1. dedupe first — a repeat press today is answered from the
//      dedupe row alone (its number, the same confirmation) and
//      consumes nothing: no cap slot, no new number.
//   2. the global daily cap — a flood bound on counted presses.
//   3. the number, from the sequencer; then the press row and the
//      dedupe row are written in ONE D1 batch, so a press and its
//      fingerprint land together or not at all. If a raced twin
//      press from the same network won the dedupe row first, the
//      batch fails whole (the sequencer number is skipped — a gap
//      in a claim-tier sequence, never a double count) and the
//      winner's number is returned instead.
const pad6 = (n) => String(n).padStart(6, '0');
export async function pressHuman(env, ip) {
  const db = env.DB;
  const day = new Date().toISOString().slice(0, 10);
  const digest = humanIpDigest(ip);
  const existing = await dbGetHumanDedupe(db, digest, day).catch(() => null);
  if (existing) {
    return { duplicate: true, number: existing.number, total: await dbCountHumanPresses(db).catch(() => 0) };
  }
  if (!(await humanGlobalOK(env))) {
    return { problem: 'daily-cap', status: 429, message: 'The daily cap for the human count has been reached. The count resumes tomorrow.' };
  }
  const n = await seqNextHuman(env);
  const rec = { number: pad6(n), pressed_at: nowSeconds(), day };
  const ok = await dbRecordHumanPress(db, rec, digest);
  if (!ok) {
    const winner = await dbGetHumanDedupe(db, digest, day).catch(() => null);
    if (winner) return { duplicate: true, number: winner.number, total: await dbCountHumanPresses(db).catch(() => 0) };
    return { problem: 'press-conflict', status: 409, message: 'That press collided with another from the same connection. Press again.' };
  }
  try { await dbPruneHumanDedupe(db, day); } catch (e) { /* pruning is housekeeping */ }
  return { counted: true, number: rec.number, total: await dbCountHumanPresses(db).catch(() => 0) };
}
export async function humanTotal(env) {
  return dbCountHumanPresses(env.DB);
}
