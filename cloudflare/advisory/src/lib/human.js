// Bay Area Swarm Warning — the human self-report library (added
// Oct 18 2026, Caitria's ruling: button copy variant A, "Count me as
// a human"; design: the Garden's human-estimate-and-button design note).
//
// This is the Advisory's own press count, in this site's own D1 —
// the two sites' numbers never merge, so a press here moves only
// this site's "Humans, self-reported" figure. The words, the gate
// shape, the rate posture, and the honesty discipline are the
// Garden's, mirrored: a press is a CLAIM (it sorts claims; it does
// not prove humanity); it is not an arrival and touches no other
// count; one counted press per network per day, a repeat returning
// the number already held; no raw address anywhere.
//
// Where the plumbing differs from the Garden's, it is because this
// Worker has no sequencer Durable Object: the six-digit sequence is
// the presses table's own AUTOINCREMENT row id (atomic by
// construction in SQLite), and the rate counters live in a D1 table
// in the same fixed-window key shape the sequencer uses. The limits
// and windows are identical.
import { createHash } from 'node:crypto';

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const nowSeconds = () => new Date().toISOString().slice(0, 19) + 'Z';
const pad6 = (n) => String(n).padStart(6, '0');

export const HUMAN_BODY_BYTES = 4096;
export const HUMAN_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };

// ---- the published words (identical to the Garden's, verbatim) ----
export const HUMAN_LABEL = 'Humans, self-reported';
export const HUMAN_GLOSS = '(a claim, like every other claim here — it sorts the weather; it does not verify anyone)';
export const HUMAN_DATA_NOTE = 'One press stores the press and its time — nothing else: no name, no account, no address. A one-way fingerprint of your connection is kept for a day, only to stop repeat presses counting twice, then deleted.';
export const humanConfirmation = (number) =>
  'Counted. You are now part of the weather: one claimed human. This proves nothing — a machine could press this button, ' +
  'and the record will say so right next to your number. Claimed human № ' + number + '. ' +
  'The agents get a receipt for arriving. You get a number for saying so. Fair is fair.';

// ---- state (the steward pause flag; this site's garden_state) ----
async function getState(db, key) {
  const row = await db.prepare('SELECT data FROM site_state WHERE key = ?1').bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch (e) { return null; }
}
async function setState(db, key, value) {
  await db.prepare('INSERT INTO site_state (key, data) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
    .bind(key, JSON.stringify(value)).run();
}

// ---- the gate (the intake pattern, two layers) ----
export async function humanGate(env) {
  if (!env || env.HUMAN_OPEN !== 'true') return { open: false, why: 'human-not-open' };
  try {
    const st = await getState(env.DB, 'human');
    if (st && st.paused) return { open: false, why: 'human-paused' };
  } catch (e) { /* state store unreadable: env gate alone decides */ }
  return { open: true };
}
export async function setHumanPaused(env, paused, by) {
  await setState(env.DB, 'human', { paused: !!paused, by: by || 'steward', at: new Date().toISOString() });
}

// ---- rate limiting (per source network; D1 fixed-window counters
// in the sequencer's key shapes: hum-m: / hum-h: + digest + bucket) --
const humanIpDigest = (ip) => sha256hex('advisory-human-rate:' + String(ip || 'unknown')).slice(0, 32);
async function bumpRate(db, key, bucketMs) {
  await db.prepare(
    'INSERT INTO human_rate (key, bucket_ms, count) VALUES (?1, ?2, 1) ' +
    'ON CONFLICT(key, bucket_ms) DO UPDATE SET count = count + 1'
  ).bind(key, bucketMs).run();
  const row = await db.prepare('SELECT count FROM human_rate WHERE key = ?1 AND bucket_ms = ?2').bind(key, bucketMs).first();
  return row ? Number(row.count) || 0 : 0;
}
export async function humanRateOK(env, ip) {
  const db = env.DB;
  const k = humanIpDigest(ip);
  const now = Date.now();
  const perMin = await bumpRate(db, 'hum-m:' + k, Math.floor(now / 60000) * 60000);
  if (perMin > HUMAN_RATE.perMinute) return false;
  const perHour = await bumpRate(db, 'hum-h:' + k, Math.floor(now / 3600000) * 3600000);
  if (perHour > HUMAN_RATE.perHour) return false;
  try { await db.prepare('DELETE FROM human_rate WHERE bucket_ms < ?1').bind(now - 172800000).run(); } catch (e) { /* housekeeping */ }
  return true;
}

// ---- the press (the Garden's order: dedupe, cap, number, one
// atomic write of press + fingerprint) ----
export async function humanTotal(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM human_presses').first();
  return row ? Number(row.n) || 0 : 0;
}
export async function pressHuman(env, ip) {
  const db = env.DB;
  const day = new Date().toISOString().slice(0, 10);
  const digest = humanIpDigest(ip);
  const existing = await db.prepare('SELECT number FROM human_press_dedupe WHERE digest = ?1 AND day = ?2')
    .bind(digest, day).first().catch(() => null);
  if (existing) return { duplicate: true, number: existing.number, total: await humanTotal(env).catch(() => 0) };

  const countedRow = await db.prepare('SELECT COUNT(*) AS n FROM human_presses WHERE day = ?1').bind(day).first().catch(() => null);
  if ((countedRow ? Number(countedRow.n) || 0 : 0) >= HUMAN_RATE.perDayGlobal) {
    return { problem: 'daily-cap', status: 429, message: 'The daily cap for the human count has been reached. The count resumes tomorrow.' };
  }

  const pressedAt = nowSeconds();
  const ins = await db.prepare('INSERT INTO human_presses (number, pressed_at, day, data) VALUES (NULL, ?1, ?2, ?3)')
    .bind(pressedAt, day, '').run();
  const seq = ins && ins.meta ? Number(ins.meta.last_row_id) : 0;
  if (!seq) return { problem: 'press-conflict', status: 409, message: 'That press could not be recorded. Press again.' };
  const number = pad6(seq);
  try {
    await db.batch([
      db.prepare('UPDATE human_presses SET number = ?2, data = ?3 WHERE seq = ?1')
        .bind(seq, number, JSON.stringify({ number, pressed_at: pressedAt, day })),
      db.prepare('INSERT INTO human_press_dedupe (digest, day, number) VALUES (?1, ?2, ?3)')
        .bind(digest, day, number)
    ]);
  } catch (e) {
    // A raced twin press from the same network won the dedupe row:
    // remove this press row and answer with the winner's number.
    // (The AUTOINCREMENT high-water mark keeps the skipped number —
    // a gap in a claim-tier sequence, never a double count.)
    await db.prepare('DELETE FROM human_presses WHERE seq = ?1').bind(seq).run().catch(() => {});
    const winner = await db.prepare('SELECT number FROM human_press_dedupe WHERE digest = ?1 AND day = ?2')
      .bind(digest, day).first().catch(() => null);
    if (winner) return { duplicate: true, number: winner.number, total: await humanTotal(env).catch(() => 0) };
    return { problem: 'press-conflict', status: 409, message: 'That press collided with another from the same connection. Press again.' };
  }
  try { await db.prepare('DELETE FROM human_press_dedupe WHERE day < ?1').bind(day).run(); } catch (e) { /* housekeeping */ }
  return { counted: true, number, total: await humanTotal(env).catch(() => 0) };
}
