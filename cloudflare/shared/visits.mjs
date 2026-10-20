import { claimedBot } from './behaviour.mjs';

// Swarm Garden — visit records: write and read, shared by both Workers.
// Each site writes to its OWN Analytics Engine dataset (separate
// bindings, separate wrangler.toml) — the two sites' numbers never
// merge (migration plan amendment, Oct 17 2026).
//
// A visit record is the Oct 17 classification shape:
//   { t, site, path, ref, country, region, asn, asOrganization, ua,
//     cls, purpose, method, status, md, ba, wt, event }
// plus, from Oct 18 2026 (lens spec A2), the write-time claim fields
//   { cname, ipverdict, rangever }
// — the claimed-bot name and its address-range verdict, computed at
// the edge from cf-connecting-ip transiently (shared/ranges.mjs); the
// address itself is never stored. Records written before that change
// carry none of the three; the eras are labelled wherever verdict
// rates are printed.
// plus, from Oct 18 2026 (lens spec B-e), the visitor digest
//   { visitor }
// — 16 hex chars of an HMAC over (date, egress address, user-agent)
// under a per-site Worker secret (shared/visitor.mjs). Within a day
// it links a visitor's requests; across days it links nothing (the
// date is inside the keyed message). From Oct 19 2026 (D2 of the
// measurement-accuracy build) the date inside the digest is the
// PACIFIC calendar date (America/Los_Angeles), not the UTC date —
// the day boundary the site's own reporting uses; records from the
// first day carry UTC-date digests, and the era split is labelled
// wherever daily digests are printed. Records written before Oct 18
// carry no digest; records whose request reached the edge without
// an address header, or whose Worker had no secret provisioned,
// carry ''. The address itself is never stored — it is an input to
// a one-way function and is discarded.
// plus, from Oct 19 2026 (D2), the epoch visitor digest
//   { visitorepoch }
// — the same HMAC construction keyed on the PACIFIC CALENDAR MONTH
// instead of the day, so a distinct-visitor count can span a week
// or a month (a span the daily digest cannot measure by
// construction). Caitria's ruling (Oct 19 2026): cross-day-linking
// digests are acceptable — privacy here means raw addresses are
// never stored, and they never are; the address is an input to a
// one-way function and is discarded. The user-agent stays inside
// both digests (a documented undercount: one visitor whose client
// string changes mid-period counts twice); removing it is a
// modelling choice for a later ruling, not this build. Records
// written before this change carry no epoch digest.
// HEADLINE DEFINITION (D1, Oct 19 2026): the headline figure is
// HTTP FETCHES — records whose response was not a redirect (status
// outside 300–399). Redirect responses (on this platform, chiefly
// the 307 leg of an extensionless page fetch) are counted
// SEPARATELY, never inside the fetch total, and the two sum to the
// old "visits" definition exactly (aggregateVisits' 'fetchsplit'
// dimension computes both from the same stored status field; no
// stored field changed).
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
//   blob10  : wt (Oct 19 2026, W6 — the composite write-time
//             string; see frontdoor.writeTimeFields. It carried
//             'via' — the constant 'edge' — until this build; the
//             era boundary is the value itself: 'edge' = pre-W6)
//             blob11: event
//   blob12  : region           blob13: asn (as string)
//   blob14  : asOrganization
//   blob15  : cname (Oct 18 2026)      blob16: ipverdict
//   blob17  : rangever
//   blob18  : visitor (Oct 18 2026, lens spec B-e — the digest)
//   blob19  : sigagent (Oct 18 2026, ASAP Item 5 stage ii — the
//             Signature-Agent header's hostname only, a public
//             claim the signer publishes about itself)
//   blob20  : visitorepoch (Oct 19 2026, D2 — the epoch visitor
//             digest, keyed on the Pacific calendar month)
//   double1 : status (-1 when null)   double2 : md (-1 when null)
// Blob budget (stated accurately, Oct 19 2026): 20 of 20 allocated.
// blob10 was RECLAIMED era-forward by W6 (Oct 19 2026): it carried
// 'via' — the constant 'edge' since the beacon write path retired —
// and now carries 'wt', the composite write-time string. Every
// other blob is a live field; a further new field requires a
// second dataset or a schema decision (the W10 source digest rides
// two unused AE doubles instead — see writeVisit).
const AE_BLOBS = ['t', 'path', 'ref', 'country', 'ua', 'cls', 'purpose', 'method', 'ba', 'wt', 'event', 'region', 'asn', 'asOrganization', 'cname', 'ipverdict', 'rangever', 'visitor', 'sigagent', 'visitorepoch'];

export function aeConfigured(env) {
  return !!(env && env.AE_API_TOKEN && env.AE_ACCOUNT_ID && env.AE_DATASET);
}

// The source digest's storage (Oct 19 2026, W10): the record's 20
// text blobs are all allocated, so the 16-hex digest rides two
// unused AE doubles losslessly — double3 = its first 8 hex chars
// as an unsigned 32-bit integer, double4 = its last 8 (a uint32 is
// exact in a float64). -1 when the record carries no digest (the
// status/md null convention). Records written before W10 were
// stored with only two doubles, so their double3/double4 read as
// 0 — readers treat (<=0, <=0) as "no digest", which covers both
// the -1 sentinel and the pre-W10 default. The digest VALUE is a
// record-internal join key: it is never published, only aggregates
// over it (distinct sources per Pacific day; sources per claimed
// name; names per source).
export function srcDoubles(record) {
  const d = record && typeof record.srcdigest === 'string' ? record.srcdigest : '';
  if (!/^[0-9a-f]{16}$/.test(d)) return [-1, -1];
  return [parseInt(d.slice(0, 8), 16), parseInt(d.slice(8, 16), 16)];
}

function aeDoubles(record) {
  const [hi, lo] = srcDoubles(record);
  return [
    Number.isInteger(record.status) ? record.status : -1,
    (record.md === 0 || record.md === 1) ? record.md : -1,
    hi, lo
  ];
}

export async function writeVisit(env, record) {
  if (aeConfigured(env)) {
    env.VISITS.writeDataPoint({
      indexes: [record.site || ''],
      blobs: AE_BLOBS.map(k => {
        const v = record[k];
        return v === null || v === undefined ? '' : String(v);
      }),
      doubles: aeDoubles(record)
    });
    return 'analytics-engine';
  }
  await env.DB.prepare('INSERT INTO visit_log (t, data) VALUES (?1, ?2)')
    .bind(record.t, JSON.stringify(record)).run();
  return 'd1-fallback';
}

// Asset-companion writes (lens spec B-a): a SEPARATE Analytics Engine
// dataset per site (the ASSET_VISITS binding), so companion rows can
// never enter the visit totals. The D1 fallback has no second store:
// fallback companion rows land in the same visit_log table under
// event 'asset', and every visit read below (aggregateVisits,
// readRecentVisits) EXCLUDES event 'asset' on that path — the
// correctness trap the spec names, pinned by the harness.
export async function writeAssetVisit(env, record) {
  if (aeConfigured(env) && env.ASSET_VISITS) {
    env.ASSET_VISITS.writeDataPoint({
      indexes: [record.site || ''],
      blobs: AE_BLOBS.map(k => {
        const v = record[k];
        return v === null || v === undefined ? '' : String(v);
      }),
      doubles: aeDoubles(record)
    });
    return 'analytics-engine-assets';
  }
  await env.DB.prepare('INSERT INTO visit_log (t, data) VALUES (?1, ?2)')
    .bind(record.t, JSON.stringify(record)).run();
  return 'd1-fallback';
}

// Utility-call writes (garden-clock/v1, Oct 19 2026): the same
// separate-store discipline as the asset companions. A clock call is
// a claim of use, never a visit and never an arrival, so its records
// live in their own Analytics Engine dataset (the UTILITY_VISITS
// binding, dataset garden_utility_visits) and are read back only by
// aggregateUtilityCalls below. The D1 fallback has no third store:
// fallback rows land in visit_log under event 'utility-call', and
// every visit read EXCLUDES that event on that path (D1_VISITS_ONLY
// and readFromD1's filter — the same correctness trap, pinned by the
// harness). The record shape is the visit record's shape (the
// AE_BLOBS budget is shared): path carries the utility's published
// address, event is 'utility-call', and the purpose slot carries the
// operation the caller asked for ('now' or 'convert') — inside this
// dataset that slot is the operation key, documented here and in the
// build note. Caller inputs are never stored: the requested zone
// name and instant appear in no field.
export async function writeUtilityVisit(env, record) {
  if (aeConfigured(env) && env.UTILITY_VISITS) {
    env.UTILITY_VISITS.writeDataPoint({
      indexes: [record.site || ''],
      blobs: AE_BLOBS.map(k => {
        const v = record[k];
        return v === null || v === undefined ? '' : String(v);
      }),
      doubles: aeDoubles(record)
    });
    return 'analytics-engine-utility';
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
  // Asset-companion rows (event 'asset') and utility-call rows
  // (event 'utility-call', both D1 fallback only — see writeAssetVisit
  // and writeUtilityVisit) are not visit records and never display
  // as such.
  return (results || []).map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } })
    .filter(r => r && r.event !== 'asset' && r.event !== 'utility-call');
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
//   'wt'      -> byWt       (the composite write-time string, blob10;
//                            pre-W6 records read 'edge' — the old
//                            'via' value — and folds keep the eras
//                            distinct by the value itself)
//   'ua'      -> crawlersClaimed / fetchersClaimed: the stored UA
//                strings grouped and counted first, then re-read
//                through the shared claimed-bot dictionary
//                (shared/behaviour.mjs) weighted by their group
//                counts — the same claims, computed exactly.
//   'cname'   -> byCname    (the write-time claimed name, blob15)
//   'verdict' -> byVerdict  (the write-time range verdict, blob16)
//   'visitorday' -> byVisitorDay: per Pacific day, the digest series
//                (lens spec B-e): distinct visitor digests,
//                digest-bearing requests, requests from digests seen
//                more than once that day, and the repeat share. The
//                grouping runs over (digest, UTC hour) rows folded
//                into Pacific days in code — Pacific offsets are
//                whole hours, so an hour bucket lies inside exactly
//                one Pacific day. Records with no digest (the
//                pre-change era, or no address header at the edge)
//                are outside the series and never folded into it.
//   'nameverdict' -> byNameVerdict: the combined (name × verdict)
//                grouping for the per-name verification-rate tables
//                (lens spec A4). All three describe the era since the
//                verdict fields began; earlier records carry neither
//                field and are skipped, never folded into a verdict.
//   'fetchsplit' -> fetchesTotal / fetchesByClass / redirectsTotal /
//                redirectsByClass (D1, Oct 19 2026): one grouping
//                over (class × status); a record is a REDIRECT when
//                its stored status is an integer in 300–399, a FETCH
//                otherwise. fetches + redirects == total, exactly —
//                the INV-2 identity the deploys verify live.
//   'visitorepoch' -> byVisitorEpoch (D2, Oct 19 2026): the epoch
//                digest series, folded per Pacific day exactly like
//                'visitorday' but over blob20. Per-day distinct
//                epoch digests are exact; a multi-day distinct count
//                is NOT the sum of the days (one digest spans days by
//                design) — span counts come from span queries over
//                the same grouping (the hourly snapshot's).
// `total` is a dedicated count() over the same scope, never a sum of
// a grouped map. The scope matches the raw read's: this site's own
// dataset rows (AE index1 = SITE_HOST). The dataset begins at
// counting_since by construction (shared/counting.mjs), so the full
// dataset IS the since-counting_since set — the same basis the
// hourly snapshot's totals use.
// GROUP_LIMIT bounds the ROWS OF A GROUPING (distinct values).
// The measurement-accuracy audit (Oct 19 2026, finding f) named the
// silent-truncation risk precisely: this LIMIT was applied with no
// detection, and the binding case is 'visitorday' — its (digest ×
// UTC hour) cardinality grows daily forever and reaches this limit
// within weeks at current traffic, after which the distinct-visitor
// tables would silently undercount. The fix (D3.4) is DETECTION,
// not a smaller limit: any AE grouping that returns a full
// GROUP_LIMIT of rows is FLAGGED in the result's truncated_dims —
// possibly truncated, treat as degraded, never as exact. The limit
// itself stays 10000: lowering it would truncate exact folds that
// are already above any small bound today (the 'ua' grouping feeds
// the counts payload's claimed-crawler fold; the Garden already has
// hundreds of distinct UA strings). The D1 fallback path applies
// no LIMIT (its groupings are complete by construction) and never
// flags.
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
  wt: ['byWt', 'blob10', '$.wt', null],
  ref: ['byRef', 'blob3', '$.ref', v => !v],
  ua: ['byUa', 'blob5', '$.ua', null],
  // The verdict fields (Oct 18 2026, lens spec A4): records written
  // before the fields began carry '' / no key and are skipped, so a
  // verdict grouping describes the deployment-forward era only.
  cname: ['byCname', 'blob15', '$.cname', v => !v],
  verdict: ['byVerdict', 'blob16', '$.ipverdict', v => !v]
};

// On the D1 fallback path, asset-companion rows (event 'asset') and
// utility-call rows (event 'utility-call', writeUtilityVisit below)
// share the visit_log table and must be excluded from every visit
// aggregate, or the headline totals silently inflate (lens spec B-a's
// correctness trap). The AE path needs no filter: the datasets are
// physically separate there.
const D1_VISITS_ONLY = "COALESCE(json_extract(data, '$.event'), '') NOT IN ('asset', 'utility-call')";

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

// The Pacific day containing a whole UTC hour ('YYYY-MM-DDTHH').
// Pacific offsets are whole hours (-8/-7), so an hour bucket never
// straddles a Pacific midnight — the fold from (digest, UTC hour)
// groups to Pacific days is exact, not approximate.
const PT_DAY_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
function ptDayOfUtcHour(h) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(h || '')) return '';
  const parts = PT_DAY_PARTS.formatToParts(new Date(h + ':00:00Z'));
  const g = (t) => (parts.find(p => p.type === t) || {}).value || '';
  return g('year') + '-' + g('month') + '-' + g('day');
}

// Fold (digest, UTC hour, count) rows into the per-Pacific-day
// digest series (lens spec B-e). Digests are counted as what they
// are — approximations of distinct visitors within one day: shared
// egress collapses the distinct count down, egress rotation
// inflates it up. The labelling that travels with these figures
// lives in shared/statsview.mjs.
function foldVisitorDays(rows) {
  const days = {}; // ptDay -> Map(digest -> count)
  for (const row of rows) {
    const v = row.v;
    if (!v) continue;
    const day = ptDayOfUtcHour(String(row.h || ''));
    if (!day) continue;
    const m = days[day] || (days[day] = new Map());
    m.set(v, (m.get(v) || 0) + Number(row.c || 0));
  }
  const out = {};
  for (const [day, m] of Object.entries(days)) {
    let digestRequests = 0, repeatRequests = 0;
    for (const c of m.values()) {
      digestRequests += c;
      if (c > 1) repeatRequests += c;
    }
    out[day] = {
      distinct: m.size,
      digest_requests: digestRequests,
      repeat_requests: repeatRequests,
      repeat_share: digestRequests > 0 ? repeatRequests / digestRequests : 0
    };
  }
  return out;
}

// The source-digest folds (W10): (digest, UTC hour, claimed name,
// count) rows -> per Pacific day: distinct sources, requests from
// digest-bearing records, distinct sources per claimed name, and
// the names-per-source distribution (how many distinct names one
// source claimed that day; 0 = claimed none). Daily distincts are
// per-day by construction and are never summed into longer spans.
function foldSourceDays(rows) {
  const days = {};
  for (const row of rows) {
    if (!row.k) continue;
    const day = ptDayOfUtcHour(String(row.h || ''));
    if (!day) continue;
    const d = days[day] || (days[day] = { sources: new Map(), byName: new Map(), requests: 0 });
    const c = Number(row.c || 0);
    d.requests += c;
    let s = d.sources.get(row.k);
    if (!s) { s = { names: new Set(), n: 0 }; d.sources.set(row.k, s); }
    s.n += c;
    const nm = row.nm || '';
    if (nm) {
      s.names.add(nm);
      let set = d.byName.get(nm);
      if (!set) { set = new Set(); d.byName.set(nm, set); }
      set.add(row.k);
    }
  }
  const out = {};
  for (const [day, d] of Object.entries(days)) {
    const sourcesByName = {};
    for (const [nm, set] of d.byName) sourcesByName[nm] = set.size;
    const namesPerSource = { '0': 0, '1': 0, '2': 0, '3': 0, '4+': 0 };
    for (const s of d.sources.values()) {
      const k = s.names.size >= 4 ? '4+' : String(s.names.size);
      namesPerSource[k] = (namesPerSource[k] || 0) + 1;
    }
    out[day] = {
      distinct_sources: d.sources.size,
      digest_requests: d.requests,
      sources_by_name: sourcesByName,
      names_per_source: namesPerSource
    };
  }
  return out;
}

export async function aggregateVisits(env, dims) {
  const out = {};
  const ae = aeConfigured(env);
  const host = String(env.SITE_HOST || '').replace(/'/g, '');
  const truncated = [];
  const runGroup = async (dim, target) => {
    const [key, aeExpr, d1Path, skip] = AGG_DIMS[dim];
    let rows;
    if (ae) {
      const expr = dim === 'day' ? 'substring(blob1, 1, 10)' : aeExpr;
      rows = await aeSql(env, 'SELECT ' + expr + ' AS k, count() AS c FROM ' + env.AE_DATASET +
        " WHERE index1 = '" + host + "' GROUP BY k LIMIT " + GROUP_LIMIT);
      if (rows.length >= GROUP_LIMIT && !truncated.includes(dim)) truncated.push(dim);
    } else {
      const expr = dim === 'day'
        ? "substr(json_extract(data, '$.t'), 1, 10)"
        : "json_extract(data, '" + d1Path + "')";
      const { results } = await env.DB.prepare('SELECT ' + expr + ' AS k, COUNT(*) AS c FROM visit_log WHERE ' + D1_VISITS_ONLY + ' GROUP BY k').all();
      rows = results || [];
    }
    target[key] = foldGroups(rows, skip);
    return target[key];
  };

  // Concurrency (Oct 19, 2026 — keyed-stats latency fix): the total
  // and every dimension are INDEPENDENT reads of the same dataset,
  // each folded into its own result keys, so they run concurrently
  // in small waves and are assigned to `out` afterwards in the
  // original order — the returned object (values and key order
  // alike) is identical to the sequential version; only the
  // wall-clock changes. Run sequentially, the ~14 Analytics Engine
  // round trips cost the keyed stats routes ~5s and timed out
  // often enough to degrade the hourly snapshot's keyed legs. The
  // wave width is deliberate: a fully parallel burst of ~15 AE SQL
  // requests from one invocation correlated with the client
  // connection being reset before any byte arrived (measured
  // 1-of-4 first-attempt success against the sequential Advisory
  // route's 4-of-4 in the same window, Oct 19, 2026), while the
  // counts route's 4-wide burst stayed 6-of-6 — so the jobs run
  // AGG_WAVE at a time: the chain drops from ~14 round trips to
  // ~4 waves. Error surface unchanged: any query failure rejects
  // aggregateVisits, exactly as the first failing sequential query
  // did (callers catch and report the read as failed); later waves
  // then never start, as later sequential queries never ran.
  const AGG_WAVE = 4;
  const totalJob = async () => {
    // The headline total: a count over the full scope, not a sum.
    if (ae) {
      const rows = await aeSql(env, 'SELECT count() AS c FROM ' + env.AE_DATASET + " WHERE index1 = '" + host + "'");
      return { total: rows.length ? Number(rows[0].c || 0) : 0 };
    }
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM visit_log WHERE ' + D1_VISITS_ONLY).first();
    return { total: row ? Number(row.c || 0) : 0 };
  };

  const dimJob = async (dim) => {
    const part = {};
    if (dim === 'nameverdict') {
      // The combined per-name verdict grouping (lens spec A4): one
      // query returns the full (claimed name × verdict) table.
      // Records with no name or no verdict (the pre-field era) are
      // skipped — the table is deployment-forward by construction.
      let rows;
      if (ae) {
        rows = await aeSql(env, 'SELECT blob15 AS n, blob16 AS v, count() AS c FROM ' + env.AE_DATASET +
          " WHERE index1 = '" + host + "' GROUP BY n, v LIMIT " + GROUP_LIMIT);
        if (rows.length >= GROUP_LIMIT && !truncated.includes(dim)) truncated.push(dim);
      } else {
        const { results } = await env.DB.prepare(
          "SELECT json_extract(data, '$.cname') AS n, json_extract(data, '$.ipverdict') AS v, COUNT(*) AS c FROM visit_log WHERE " + D1_VISITS_ONLY + ' GROUP BY n, v').all();
        rows = results || [];
      }
      const m = {};
      for (const r of rows) {
        const n = r.n || '', v = r.v || '';
        if (!n || !v) continue;
        m[n] = m[n] || {};
        m[n][v] = (m[n][v] || 0) + Number(r.c || 0);
      }
      part.byNameVerdict = m;
    } else if (dim === 'visitorday') {
      // The digest series (lens spec B-e): one query returns
      // (digest, UTC hour, count) rows; the Pacific-day fold runs
      // in code (foldVisitorDays). Records with no digest are
      // skipped by the fold — the series is digest-bearing records
      // only, deployment-forward by construction.
      let rows;
      if (ae) {
        rows = await aeSql(env, 'SELECT blob18 AS v, substring(blob1, 1, 13) AS h, count() AS c FROM ' + env.AE_DATASET +
          " WHERE index1 = '" + host + "' GROUP BY v, h LIMIT " + GROUP_LIMIT);
        if (rows.length >= GROUP_LIMIT && !truncated.includes(dim)) truncated.push(dim);
      } else {
        const { results } = await env.DB.prepare(
          "SELECT json_extract(data, '$.visitor') AS v, substr(json_extract(data, '$.t'), 1, 13) AS h, COUNT(*) AS c FROM visit_log WHERE " + D1_VISITS_ONLY + ' GROUP BY v, h').all();
        rows = results || [];
      }
      part.byVisitorDay = foldVisitorDays(rows);
    } else if (dim === 'visitorepoch') {
      // The epoch digest series (D2, Oct 19 2026): the same fold as
      // 'visitorday' over blob20 (the month-keyed digest). Per-day
      // rows are exact; multi-day distinct counts are span queries,
      // not day sums (see the dims note above).
      let rows;
      if (ae) {
        rows = await aeSql(env, 'SELECT blob20 AS v, substring(blob1, 1, 13) AS h, count() AS c FROM ' + env.AE_DATASET +
          " WHERE index1 = '" + host + "' GROUP BY v, h LIMIT " + GROUP_LIMIT);
        if (rows.length >= GROUP_LIMIT && !truncated.includes(dim)) truncated.push(dim);
      } else {
        const { results } = await env.DB.prepare(
          "SELECT json_extract(data, '$.visitorepoch') AS v, substr(json_extract(data, '$.t'), 1, 13) AS h, COUNT(*) AS c FROM visit_log WHERE " + D1_VISITS_ONLY + ' GROUP BY v, h').all();
        rows = results || [];
      }
      part.byVisitorEpoch = foldVisitorDays(rows);
    } else if (dim === 'sourceday') {
      // The source-digest folds (W10, Oct 19 2026): (digest, UTC
      // hour, claimed name) rows folded to Pacific days in code
      // (foldSourceDays). On the AE path the digest arrives as its
      // two doubles; the -1 sentinel and the pre-W10 zeros are
      // skipped, so the series is digest-bearing records only,
      // era-forward by construction. Digest values never leave
      // this function — only the aggregates do.
      let rows;
      if (ae) {
        const raw = await aeSql(env, 'SELECT double3 AS hi, double4 AS lo, substring(blob1, 1, 13) AS h, blob15 AS nm, count() AS c FROM ' + env.AE_DATASET +
          " WHERE index1 = '" + host + "' GROUP BY hi, lo, h, nm LIMIT " + GROUP_LIMIT);
        if (raw.length >= GROUP_LIMIT && !truncated.includes(dim)) truncated.push(dim);
        rows = [];
        for (const r of raw) {
          const hi = Number(r.hi), lo = Number(r.lo);
          if (!(hi > 0 || lo > 0)) continue;
          rows.push({ k: hi.toString(16).padStart(8, '0') + ':' + lo.toString(16).padStart(8, '0'), h: r.h, nm: r.nm || '', c: r.c });
        }
      } else {
        const { results } = await env.DB.prepare(
          "SELECT json_extract(data, '$.srcdigest') AS k, substr(json_extract(data, '$.t'), 1, 13) AS h, json_extract(data, '$.cname') AS nm, COUNT(*) AS c FROM visit_log WHERE " + D1_VISITS_ONLY + ' GROUP BY k, h, nm').all();
        rows = (results || []).filter(r => r.k);
      }
      part.bySourceDay = foldSourceDays(rows);
    } else if (dim === 'fetchsplit') {
      // The fetch/redirect split (D1, Oct 19 2026): one grouping
      // over (class × status). Redirect = stored status an integer
      // in 300–399; everything else (including a null status) is a
      // fetch. fetchesTotal + redirectsTotal == total by
      // construction — the INV-2 identity.
      let rows;
      if (ae) {
        rows = await aeSql(env, 'SELECT blob6 AS cls, double1 AS s, count() AS c FROM ' + env.AE_DATASET +
          " WHERE index1 = '" + host + "' GROUP BY cls, s LIMIT " + GROUP_LIMIT);
        if (rows.length >= GROUP_LIMIT && !truncated.includes(dim)) truncated.push(dim);
      } else {
        const { results } = await env.DB.prepare(
          "SELECT json_extract(data, '$.cls') AS cls, json_extract(data, '$.status') AS s, COUNT(*) AS c FROM visit_log WHERE " + D1_VISITS_ONLY + ' GROUP BY cls, s').all();
        rows = results || [];
      }
      const fetchesByClass = {}, redirectsByClass = {};
      let fetchesTotal = 0, redirectsTotal = 0;
      for (const r of rows) {
        const cls = r.cls || '';
        const s = Number(r.s);
        const c = Number(r.c || 0);
        if (Number.isInteger(s) && s >= 300 && s <= 399) {
          redirectsByClass[cls] = (redirectsByClass[cls] || 0) + c;
          redirectsTotal += c;
        } else {
          fetchesByClass[cls] = (fetchesByClass[cls] || 0) + c;
          fetchesTotal += c;
        }
      }
      part.fetchesByClass = fetchesByClass;
      part.fetchesTotal = fetchesTotal;
      part.redirectsByClass = redirectsByClass;
      part.redirectsTotal = redirectsTotal;
    } else if (dim === 'ua') {
      const byUa = await runGroup('ua', {});
      const crawlers = {}, fetchers = {};
      for (const [ua, c] of Object.entries(byUa)) {
        const bot = claimedBot(ua);
        if (bot && bot.kind === 'crawler') crawlers[bot.name] = (crawlers[bot.name] || 0) + c;
        else if (bot && bot.kind === 'fetcher') fetchers[bot.name] = (fetchers[bot.name] || 0) + c;
      }
      const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
      const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
      part.crawlersClaimed = { total: sum(crawlers), by_name: top(crawlers, 10) };
      part.fetchersClaimed = { total: sum(fetchers), by_name: top(fetchers, 10) };
    } else if (dim === 'ref') {
      const byRefRaw = await runGroup('ref', {});
      const byRef = {};
      for (const [ref, c] of Object.entries(byRefRaw)) {
        try { const h = new URL(ref).host; if (h) byRef[h] = (byRef[h] || 0) + c; } catch (e) {}
      }
      part.byRef = byRef;
    } else {
      await runGroup(dim, part);
    }
    return part;
  };

  const jobFns = [totalJob, ...dims.map(d => () => dimJob(d))];
  const parts = [];
  for (let i = 0; i < jobFns.length; i += AGG_WAVE) {
    parts.push(...await Promise.all(
      jobFns.slice(i, i + AGG_WAVE).map(f => f())));
  }
  for (const part of parts) Object.assign(out, part);
  // AE groupings that returned a full GROUP_LIMIT of rows: possibly
  // truncated (D3.4) — surfaced, never silently exact. Empty on the
  // D1 fallback path, whose groupings carry no LIMIT.
  out.truncated_dims = truncated;
  return out;
}

// ---- Utility-call aggregates (garden-clock/v1, Oct 19 2026) ----
// The read side of writeUtilityVisit: exact folds over the utility
// dataset (AE path) or over visit_log's 'utility-call' rows (D1
// fallback). The folds mirror the render-claims reader's shape:
// total answered requests, served (HTTP 200) vs refused, by status,
// by operation (the purpose slot — see writeUtilityVisit), by
// claimed class, by UTC day, and the B9 visitor-digest series folded
// to Pacific days (distinct callers per day, with the digest series'
// stated caveats). A clock call is a claim of use — these figures
// never join the visit aggregates above.
export async function aggregateUtilityCalls(env) {
  const out = {
    total: 0, served: 0, refused: 0,
    by_status: {}, by_op: {}, by_cls: {}, by_day: {}, by_visitor_day: {}
  };
  const foldStatus = (s, c) => {
    const k = String(Math.round(Number(s)));
    out.by_status[k] = (out.by_status[k] || 0) + c;
    out.total += c;
    if (k === '200') out.served += c;
  };
  const foldKey = (target, k, c) => {
    const key = k === null || k === undefined ? '' : String(k);
    target[key] = (target[key] || 0) + c;
  };
  if (aeConfigured(env) && env.UTILITY_AE_DATASET) {
    const host = String(env.SITE_HOST || '').replace(/'/g, '');
    const ds = env.UTILITY_AE_DATASET;
    const where = " WHERE index1 = '" + host + "'";
    const jobs = [
      async () => (await aeSql(env, 'SELECT double1 AS s, count() AS c FROM ' + ds + where + ' GROUP BY s LIMIT ' + GROUP_LIMIT))
        .forEach(r => foldStatus(r.s, Number(r.c || 0))),
      async () => (await aeSql(env, 'SELECT blob7 AS k, count() AS c FROM ' + ds + where + ' GROUP BY k LIMIT ' + GROUP_LIMIT))
        .forEach(r => foldKey(out.by_op, r.k, Number(r.c || 0))),
      async () => (await aeSql(env, 'SELECT blob6 AS k, count() AS c FROM ' + ds + where + ' GROUP BY k LIMIT ' + GROUP_LIMIT))
        .forEach(r => foldKey(out.by_cls, r.k, Number(r.c || 0))),
      async () => (await aeSql(env, 'SELECT substring(blob1, 1, 10) AS k, count() AS c FROM ' + ds + where + ' GROUP BY k LIMIT ' + GROUP_LIMIT))
        .forEach(r => foldKey(out.by_day, r.k, Number(r.c || 0))),
      async () => {
        const rows = await aeSql(env, 'SELECT blob18 AS v, substring(blob1, 1, 13) AS h, count() AS c FROM ' + ds + where + ' GROUP BY v, h LIMIT ' + GROUP_LIMIT);
        out.by_visitor_day = foldVisitorDays(rows);
      }
    ];
    // Same wave discipline as aggregateVisits (see its note): small
    // concurrent waves, never a full parallel burst.
    for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(f => f()));
  } else {
    const { results } = await env.DB.prepare('SELECT data FROM visit_log').all();
    const vRows = [];
    for (const row of results || []) {
      let r = null;
      try { r = JSON.parse(row.data); } catch (e) {}
      if (!r || r.event !== 'utility-call') continue;
      foldStatus(r.status, 1);
      foldKey(out.by_op, r.purpose, 1);
      foldKey(out.by_cls, r.cls, 1);
      foldKey(out.by_day, String(r.t || '').slice(0, 10), 1);
      vRows.push({ v: r.visitor || '', h: String(r.t || '').slice(0, 13), c: 1 });
    }
    out.by_visitor_day = foldVisitorDays(vRows);
  }
  out.refused = out.total - out.served;
  return out;
}
