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

// ---- garden state (the steward pause flag) ----
export async function dbGetState(db, key) {
  const row = await db.prepare('SELECT data FROM garden_state WHERE key = ?1').bind(key).first();
  return row ? parse(row.data) : null;
}
export async function dbSetState(db, key, value) {
  await db.prepare('INSERT INTO garden_state (key, data) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data = excluded.data')
    .bind(key, JSON.stringify(value)).run();
}
