// Swarm Garden — visit records: write and read, shared by both Workers.
// Each site writes to its OWN Analytics Engine dataset (separate
// bindings, separate wrangler.toml) — the two sites' numbers never
// merge (migration plan amendment, Oct 17 2026).
//
// A visit record is the Oct 17 classification shape:
//   { t, site, path, ref, country, ua, cls, purpose,
//     method, status, md, ba, via, event }
//   cls/purpose come from shared/taxonomy.mjs classify() at write time;
//   behaviour labels are NOT stored — they are computed at query time
//   over these records (shared/behaviour.mjs).
//
// Write/read paths:
//   - When env.AE_API_TOKEN and env.AE_ACCOUNT_ID are set, reads go to
//     the Analytics Engine SQL API and writes go to the dataset via
//     env.VISITS.writeDataPoint. (The token is a read-only AE token
//     stored as a Worker secret — plan, Design D. STAGING-VERIFY: the
//     SQL read path can only be exercised against a real account.)
//   - Otherwise (local harness, or the plan's Design B fallback if AE
//     limits bite), records land in the D1 `visit_log` table with the
//     record shape unchanged, and reads come from there.

// ---- Analytics Engine datapoint mapping (documented; staging-verify) ----
//   index1  : site host
//   blob1   : t (ISO)          blob6 : cls
//   blob2   : path             blob7 : purpose ('' when null)
//   blob3   : ref              blob8 : method ('' when null)
//   blob4   : country          blob9 : ba ('' when null)
//   blob5   : ua (<= 400 chars, as recorded)
//   blob10  : via              blob11: event
//   double1 : status (-1 when null)   double2 : md (-1 when null)
const AE_BLOBS = ['t', 'path', 'ref', 'country', 'ua', 'cls', 'purpose', 'method', 'ba', 'via', 'event'];

export function aeConfigured(env) {
  return !!(env && env.AE_API_TOKEN && env.AE_ACCOUNT_ID && env.AE_DATASET);
}

export async function writeVisit(env, record) {
  if (aeConfigured(env)) {
    env.VISITS.writeDataPoint({
      indexes: [record.site || ''],
      blobs: AE_BLOBS.map(k => {
        const v = record[k];
        return v === null || v === undefined ? '' : String(v);
      }),
      doubles: [
        Number.isInteger(record.status) ? record.status : -1,
        (record.md === 0 || record.md === 1) ? record.md : -1
      ]
    });
    return 'analytics-engine';
  }
  await env.DB.prepare('INSERT INTO visit_log (t, data) VALUES (?1, ?2)')
    .bind(record.t, JSON.stringify(record)).run();
  return 'd1-fallback';
}

async function readFromD1(env, limit) {
  const { results } = await env.DB.prepare('SELECT data FROM visit_log ORDER BY id DESC LIMIT ?1')
    .bind(limit).all();
  // Newest first, as written; callers that aggregate sort as needed.
  return (results || []).map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean);
}

async function readFromAE(env, limit) {
  // Raw-record read: SELECT the blob/double columns, newest first.
  // AE SQL column names are positional (blob1.., double1..).
  const cols = AE_BLOBS.map((_, i) => 'blob' + (i + 1)).join(', ');
  const sql = 'SELECT ' + cols + ', double1, double2 FROM ' + env.AE_DATASET +
    " WHERE index1 = '" + String(env.SITE_HOST || '').replace(/'/g, '') + "'" +
    ' ORDER BY blob1 DESC LIMIT ' + Number(limit);
  const res = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + env.AE_ACCOUNT_ID + '/analytics_engine/sql',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.AE_API_TOKEN, 'Content-Type': 'text/plain' }, body: sql }
  );
  if (!res.ok) throw new Error('Analytics Engine query failed: ' + res.status);
  const json = await res.json();
  const rows = (json && json.data) || [];
  return rows.map(row => {
    const rec = {};
    AE_BLOBS.forEach((k, i) => {
      const v = row['blob' + (i + 1)];
      rec[k] = v === '' ? (['purpose', 'method', 'ba'].includes(k) ? null : '') : v;
    });
    rec.status = row.double1 === -1 ? null : row.double1;
    rec.md = row.double2 === -1 ? null : row.double2;
    rec.site = env.SITE_HOST || '';
    return rec;
  });
}

// Newest-first, at most `limit` records — the same window the Netlify
// counts/stats read (the last VISITS_WINDOW records), now a query
// choice instead of a storage scan.
export async function readRecentVisits(env, limit) {
  if (aeConfigured(env)) return readFromAE(env, limit);
  return readFromD1(env, limit);
}
