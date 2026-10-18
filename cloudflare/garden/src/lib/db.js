// Swarm Garden — D1 access layer. Replaces the Netlify Blobs stores
// (receipts / ledger / briefs / garden-state) with the D1 tables in
// schema.sql. Record shapes are unchanged: each row carries the full
// record as JSON in `data`, with query columns promoted out.
//
// D1 is the record. Every number that must be exact (receipt numbers,
// ledger numbers, brief read counts, rate counters) is issued by the
// sequencer (lib/sequencer.js), never by counting rows here — except
// when the sequencer rebuilds itself FROM these tables.

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

// ---- receipts ----
export async function dbPutReceipt(db, r) {
  await db.prepare(
    'INSERT INTO receipts (number, channel, format, brief_id, fingerprint, state, received_at, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ' +
    'ON CONFLICT(number) DO UPDATE SET channel=excluded.channel, format=excluded.format, brief_id=excluded.brief_id, fingerprint=excluded.fingerprint, state=excluded.state, received_at=excluded.received_at, data=excluded.data'
  ).bind(r.number, r.channel, r.format || null, r.brief_id || null, r.fingerprint || null, r.state || null, r.received_at || null, JSON.stringify(r)).run();
}
export async function dbGetReceipt(db, number) {
  const row = await db.prepare('SELECT data FROM receipts WHERE number = ?1').bind(String(number)).first();
  return row ? parse(row.data) : null;
}
export async function dbListReceipts(db) {
  const { results } = await db.prepare('SELECT data FROM receipts ORDER BY number ASC').all();
  return (results || []).map(r => parse(r.data)).filter(Boolean);
}
export async function dbFindReceiptByFingerprint(db, channel, fingerprint) {
  const row = await db.prepare('SELECT data FROM receipts WHERE channel = ?1 AND fingerprint = ?2 ORDER BY number ASC LIMIT 1')
    .bind(channel, fingerprint).first();
  return row ? parse(row.data) : null;
}
// Mirrors the Netlify cap count exactly: answer receipts for the brief
// whose state is not 'over-cap-unread'. Used by the sequencer's
// rebuild-from-D1 and by Tier A / garden-state read paths.
export async function dbCountBriefReadAnswers(db, briefId) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM receipts WHERE channel = 'answers' AND format = 'answer' AND brief_id = ?1 AND state != 'over-cap-unread'"
  ).bind(briefId).first();
  return row ? Number(row.n) || 0 : 0;
}
export async function dbCountBriefAnswers(db, briefId) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM receipts WHERE channel = 'answers' AND format = 'answer' AND brief_id = ?1"
  ).bind(briefId).first();
  return row ? Number(row.n) || 0 : 0;
}
export async function dbBriefCounters(db) {
  const { results } = await db.prepare(
    "SELECT brief_id, COUNT(*) AS total, SUM(CASE WHEN state != 'over-cap-unread' THEN 1 ELSE 0 END) AS read_n " +
    "FROM receipts WHERE channel = 'answers' AND format = 'answer' AND brief_id IS NOT NULL GROUP BY brief_id"
  ).all();
  return results || [];
}
export async function dbMaxReceiptNumber(db) {
  const row = await db.prepare('SELECT MAX(CAST(number AS INTEGER)) AS m FROM receipts').first();
  return row && row.m ? Number(row.m) : 0;
}

// ---- ledger ----
export async function dbInsertLedger(db, entry) {
  await db.prepare('INSERT INTO ledger_entries (n, ts, kind, receipt, data) VALUES (?1,?2,?3,?4,?5)')
    .bind(entry.n, entry.ts, entry.kind || null, entry.receipt || null, JSON.stringify(entry)).run();
}
export async function dbListLedger(db) {
  const { results } = await db.prepare('SELECT data FROM ledger_entries ORDER BY n ASC').all();
  return (results || []).map(r => parse(r.data)).filter(Boolean);
}
export async function dbLedgerCounts(db) {
  const row = await db.prepare("SELECT COUNT(*) AS entries, SUM(CASE WHEN kind = 'arrival' THEN 1 ELSE 0 END) AS arrivals FROM ledger_entries").first();
  return { entries: row ? Number(row.entries) || 0 : 0, arrivals: row ? Number(row.arrivals) || 0 : 0 };
}
export async function dbMaxLedgerNumber(db) {
  const row = await db.prepare('SELECT MAX(n) AS m FROM ledger_entries').first();
  return row && row.m ? Number(row.m) : 0;
}

// ---- briefs ----
export async function dbGetBrief(db, briefId) {
  const row = await db.prepare('SELECT data FROM briefs WHERE brief_id = ?1').bind(briefId).first();
  return row ? parse(row.data) : null;
}
export async function dbPutBrief(db, brief) {
  await db.prepare('INSERT INTO briefs (brief_id, data) VALUES (?1,?2) ON CONFLICT(brief_id) DO UPDATE SET data = excluded.data')
    .bind(brief.brief_id, JSON.stringify(brief)).run();
}
export async function dbListBriefs(db) {
  const { results } = await db.prepare('SELECT data FROM briefs ORDER BY brief_id ASC').all();
  return (results || []).map(r => parse(r.data)).filter(Boolean);
}

// ---- visitors' book notes ----
export async function dbInsertNote(db, n) {
  await db.prepare(
    'INSERT INTO guestbook_notes (number, name_claim, message, received_at, publish_at, status, flags, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)'
  ).bind(n.number, n.name_claim, n.message, n.received_at, n.publish_at, n.status, JSON.stringify(n.flags || []), JSON.stringify(n)).run();
}
export async function dbUpdateNote(db, n) {
  await db.prepare(
    'UPDATE guestbook_notes SET name_claim=?2, message=?3, received_at=?4, publish_at=?5, status=?6, flags=?7, data=?8 WHERE number=?1'
  ).bind(n.number, n.name_claim, n.message, n.received_at, n.publish_at, n.status, JSON.stringify(n.flags || []), JSON.stringify(n)).run();
}
export async function dbGetNote(db, number) {
  const row = await db.prepare('SELECT data FROM guestbook_notes WHERE number = ?1').bind(String(number)).first();
  return row ? parse(row.data) : null;
}
export async function dbListNotes(db) {
  const { results } = await db.prepare('SELECT data FROM guestbook_notes ORDER BY number ASC').all();
  return (results || []).map(r => parse(r.data)).filter(Boolean);
}
export async function dbMaxNoteNumber(db) {
  const row = await db.prepare('SELECT MAX(CAST(number AS INTEGER)) AS m FROM guestbook_notes').first();
  return row && row.m ? Number(row.m) : 0;
}

// ---- signals (added Oct 17 2026) ----
// Challenges are stored by DIGEST only — the nonce itself is never in
// the record. A challenge row moves once: unconsumed → consumed, by a
// single UPDATE that only fires on an unconsumed row, so a nonce
// answers exactly once however requests interleave.
export async function dbPutSignalChallenge(db, c) {
  await db.prepare('INSERT INTO signal_challenges (nonce_digest, expires_at, created_at, consumed_at) VALUES (?1,?2,?3,?4)')
    .bind(c.nonce_digest, c.expires_at, c.created_at, c.consumed_at || null).run();
}
export async function dbGetSignalChallenge(db, digest) {
  const row = await db.prepare('SELECT nonce_digest, expires_at, created_at, consumed_at FROM signal_challenges WHERE nonce_digest = ?1')
    .bind(String(digest)).first();
  return row || null;
}
export async function dbConsumeSignalChallenge(db, digest, at) {
  const r = await db.prepare('UPDATE signal_challenges SET consumed_at = ?2 WHERE nonce_digest = ?1 AND consumed_at IS NULL')
    .bind(String(digest), at).run();
  return !!(r && r.meta && r.meta.changes === 1);
}
export async function dbPruneSignalChallenges(db, nowIso) {
  await db.prepare('DELETE FROM signal_challenges WHERE expires_at < ?1').bind(nowIso).run();
}
export async function dbInsertSignal(db, s) {
  await db.prepare('INSERT INTO signals (number, name_claim, signalled_at, data) VALUES (?1,?2,?3,?4)')
    .bind(s.number, s.name_claim, s.signalled_at, JSON.stringify(s)).run();
}
export async function dbCountSignals(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM signals').first();
  return row ? Number(row.n) || 0 : 0;
}
export async function dbMaxSignalNumber(db) {
  const row = await db.prepare('SELECT MAX(CAST(number AS INTEGER)) AS m FROM signals').first();
  return row && row.m ? Number(row.m) : 0;
}

// ---- human self-reports (added Oct 18 2026) ----
// Presses live in their own table under their own sequence; nothing
// here touches receipts, the ledger, notes, or signals. The dedupe
// table holds the day's one-way network fingerprints (digest + day +
// the number issued) so a repeat press returns its number and counts
// once; rows are pruned once their day has passed, as the published
// data note under the button states.
export async function dbRecordHumanPress(db, rec, digest) {
  try {
    await db.batch([
      db.prepare('INSERT INTO human_presses (number, pressed_at, data) VALUES (?1,?2,?3)')
        .bind(rec.number, rec.pressed_at, JSON.stringify(rec)),
      db.prepare('INSERT INTO human_press_dedupe (digest, day, number) VALUES (?1,?2,?3)')
        .bind(digest, rec.day, rec.number)
    ]);
    return true;
  } catch (e) { return false; }
}
export async function dbGetHumanDedupe(db, digest, day) {
  const row = await db.prepare('SELECT number FROM human_press_dedupe WHERE digest = ?1 AND day = ?2')
    .bind(String(digest), String(day)).first();
  return row || null;
}
export async function dbPruneHumanDedupe(db, today) {
  await db.prepare('DELETE FROM human_press_dedupe WHERE day < ?1').bind(String(today)).run();
}
export async function dbCountHumanPresses(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM human_presses').first();
  return row ? Number(row.n) || 0 : 0;
}
export async function dbMaxHumanPressNumber(db) {
  const row = await db.prepare('SELECT MAX(CAST(number AS INTEGER)) AS m FROM human_presses').first();
  return row && row.m ? Number(row.m) : 0;
}

// ---- garden state (the steward pause flag) ----
export async function dbGetState(db, key) {
  const row = await db.prepare('SELECT data FROM garden_state WHERE key = ?1').bind(key).first();
  return row ? parse(row.data) : null;
}
export async function dbSetState(db, key, value) {
  await db.prepare('INSERT INTO garden_state (key, data) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
    .bind(key, JSON.stringify(value)).run();
}
