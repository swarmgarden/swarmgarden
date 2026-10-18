import { claimedBot } from './behaviour.mjs';

// Swarm Garden — visit records: write and read, shared by both Workers.
// Each site writes to its OWN Analytics Engine dataset (separate
// bindings, separate wrangler.toml) — the two sites' numbers never
// merge (migration plan amendment, Oct 17 2026).
//
// A visit record is the Oct 17 classification shape:
//   { t, site, path, ref, country, region, asn, asOrganization, ua,
//     cls, purpose, method, status, md, ba, via, event }
//   cls/purpose come from shared/taxonomy.mjs classify() at write time;
//   behaviour labels are NOT stored — they are computed at query time
//   over these records (shared/behaviour.mjs).
//   region/asn/asOrganization are edge network facts (request.cf),
//   captured Oct 17 2026 on Caitria's approval so crawler and visitor
//   reports can split by area and network operator. They are PRIVATE:
//   they never enter the public counts payload or any public label.
//   No raw IP address is stored anywhere — the same posture as the
//   intake meta_* capture. Records written before this change carry
//   '' for the three fields; their geography stays country-only.
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
//   - TOTALS are never computed from a raw-record read: aggregateVisits
//     (below) aggregates over the FULL dataset with SQL GROUP BY. The
//     raw read (readRecentVisits) survives only for newest-first
//     DISPLAY lists (the dashboards' recent-requests tables), where a
//     limit is a display choice, not arithmetic. (Correction, Oct 18
//     2026: the launch-era counts/stats read counted the newest 1,500
//     raw rows in code; once a dataset passed 1,500 records the
//     published totals silently understated the record — the Garden's
//     dataset crossed 1,500 on its first night. Exact aggregation is
//     the fix; see counts.js and PORT-NOTES.)

// ---- Analytics Engine datapoint mapping (documented; staging-verify) ----
//   index1  : site host
//   blob1   : t (ISO)          blob6 : cls
//   blob2   : path             blob7 : purpose ('' when null)
//   blob3   : ref              blob8 : method ('' when null)
//   blob4   : country          blob9 : ba ('' when null)
//   blob5   : ua (<= 400 chars, as recorded)
//   blob10  : via              blob11: event
//   blob12  : region           blob13: asn (as string)
//   blob14  : asOrganization
//   double1 : status (-1 when null)   double2 : md (-1 when null)
const AE_BLOBS = ['t', 'path', 'ref', 'country', 'ua', 'cls', 'purpose', 'method', 'ba', 'via', 'event', 'region', 'asn', 'asOrganization'];

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

async function aeSql(env, sql) {
  const res = await fetch(
    'https://api.cloudflare.com/client/v4/accounts/' + env.AE_ACCOUNT_ID + '/analytics_engine/sql',
    { method: 'POST', headers: { 'Authorization': 'Bearer ' + env.AE_API_TOKEN, 'Content-Type': 'text/plain' }, body: sql }
  );
  if (!res.ok) throw new Error('Analytics Engine query failed: ' + res.status);
  const json = await res.json();
  return (json && json.data) || [];
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
  const rows = await aeSql(env, sql);
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

// Newest-first, at most `limit` records. DISPLAY LISTS ONLY (the
// dashboards' recent-requests tables): a limit here trims what is
// shown, never what is counted. Totals come from aggregateVisits.
export async function readRecentVisits(env, limit) {
  if (aeConfigured(env)) return readFromAE(env, limit);
  return readFromD1(env, limit);
}

// ---- Exact aggregates over the full dataset (Oct 18 2026) ----
// aggregateVisits(env, dims) runs SQL aggregation (AE SQL API, or
// json_extract grouping over the D1 fallback's visit_log) and returns
// { total, ... } with one grouped map per requested dimension:
//   'class'   -> byClass    (the write-time claimed class)
//   'purpose' -> byPurpose  (empty purposes excluded, as the old
//                            in-code aggregate excluded them)
//   'status'  -> byStatus   (integer response statuses only)
//   'day'     -> byDay      (the record date, first 10 chars of t)
//   'path'    -> byPath     (every path, counted)
//   'country' -> byCountry  (empty countries excluded)
//   'ref'     -> byRef      (counts folded to the referrer's HOST,
//                            exactly as the old in-code aggregate did)
//   'event'   -> byEvent    (empty events excluded)
//   'via'     -> byVia
//   'ua'      -> crawlersClaimed / fetchersClaimed: the stored UA
//                strings grouped and counted first, then re-read
//                through the shared claimed-bot dictionary
//                (shared/behaviour.mjs) weighted by their group
//                counts — the same claims, computed exactly.
// `total` is a dedicated count() over the same scope, never a sum of
// a grouped map. The scope matches the raw read's: this site's own
// dataset rows (AE index1 = SITE_HOST). The dataset begins at
// counting_since by construction (shared/counting.mjs), so the full
// dataset IS the since-counting_since set — the same basis the
// hourly snapshot's totals use.
// GROUP_LIMIT bounds the ROWS OF A GROUPING (distinct values), the
// same bound the hourly snapshot's queries use; the live
// cardinalities (paths, UA strings, referrers) sit orders of
// magnitude below it, and the headline total/class figures do not
// depend on it at all (count() + a six-value grouping).
const GROUP_LIMIT = 10000;

const AGG_DIMS = {
  // dim: [resultKey, aeExpr, d1JsonPath, skip(value)]
  class: ['byClass', 'blob6', '$.cls', null],
  purpose: ['byPurpose', 'blob7', '$.purpose', v => v === '' || v === null || v === undefined],
  status: ['byStatus', 'double1', '$.status', v => !Number.isInteger(v)],
  day: ['byDay', null, '$.t', null], // AE expr is substring(blob1, 1, 10)
  path: ['byPath', 'blob2', '$.path', null],
  country: ['byCountry', 'blob4', '$.country', v => !v],
  event: ['byEvent', 'blob11', '$.event', v => !v],
  via: ['byVia', 'blob10', '$.via', null],
  ref: ['byRef', 'blob3', '$.ref', v => !v],
  ua: ['byUa', 'blob5', '$.ua', null]
};

function foldGroups(rows, skip) {
  const map = {};
  for (const row of rows) {
    let k = row.k;
    if (skip && skip(k)) continue;
    if (k === null || k === undefined) k = '';
    map[k] = (map[k] || 0) + Number(row.c || 0);
  }
  return map;
}

export async function aggregateVisits(env, dims) {
  const out = {};
  const ae = aeConfigured(env);
  const host = String(env.SITE_HOST || '').replace(/'/g, '');
  const runGroup = async (dim) => {
    const [key, aeExpr, d1Path, skip] = AGG_DIMS[dim];
    let rows;
    if (ae) {
      const expr = dim === 'day' ? 'substring(blob1, 1, 10)' : aeExpr;
      rows = await aeSql(env, 'SELECT ' + expr + ' AS k, count() AS c FROM ' + env.AE_DATASET +
        " WHERE index1 = '" + host + "' GROUP BY k LIMIT " + GROUP_LIMIT);
    } else {
      const expr = dim === 'day'
        ? "substr(json_extract(data, '$.t'), 1, 10)"
        : "json_extract(data, '" + d1Path + "')";
      const { results } = await env.DB.prepare('SELECT ' + expr + ' AS k, COUNT(*) AS c FROM visit_log GROUP BY k').all();
      rows = results || [];
    }
    out[key] = foldGroups(rows, skip);
    return out[key];
  };

  // The headline total: a count over the full scope, not a sum.
  if (ae) {
    const rows = await aeSql(env, 'SELECT count() AS c FROM ' + env.AE_DATASET + " WHERE index1 = '" + host + "'");
    out.total = rows.length ? Number(rows[0].c || 0) : 0;
  } else {
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM visit_log').first();
    out.total = row ? Number(row.c || 0) : 0;
  }

  for (const dim of dims) {
    if (dim === 'ua') {
      const byUa = await runGroup('ua');
      const crawlers = {}, fetchers = {};
      for (const [ua, c] of Object.entries(byUa)) {
        const bot = claimedBot(ua);
        if (bot && bot.kind === 'crawler') crawlers[bot.name] = (crawlers[bot.name] || 0) + c;
        else if (bot && bot.kind === 'fetcher') fetchers[bot.name] = (fetchers[bot.name] || 0) + c;
      }
      const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
      const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
      out.crawlersClaimed = { total: sum(crawlers), by_name: top(crawlers, 10) };
      out.fetchersClaimed = { total: sum(fetchers), by_name: top(fetchers, 10) };
      delete out.byUa;
    } else if (dim === 'ref') {
      const byRefRaw = await runGroup('ref');
      const byRef = {};
      for (const [ref, c] of Object.entries(byRefRaw)) {
        try { const h = new URL(ref).host; if (h) byRef[h] = (byRef[h] || 0) + c; } catch (e) {}
      }
      out.byRef = byRef;
    } else {
      await runGroup(dim);
    }
  }
  return out;
}
