// Swarm Garden — shared rendering for the two keyed stats pages
// (B1 standardization, Oct 18 2026). One section grammar on both
// pages: label | count | share %, largest first, every list. The two
// routes keep their own record blocks (the record is the Garden's;
// the Advisory shows structural labels) and share everything about
// the visit blocks, including the per-name verdict table (lens spec
// A4) and the referrer table's honesty labels (B1 §5, verbatim in
// substance).

export const sortedPairs = (obj) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
export const share = (n, total) => (total > 0 ? (100 * n / total).toFixed(1) + '%' : '—');

// A label | count | share % table. rows: [[label, count], ...],
// already sorted by the caller; shareOf: the denominator (defaults
// to the rows' own sum — pass the page total where the basis differs).
export function countTable(esc, rows, shareOf) {
  const denom = typeof shareOf === 'number' ? shareOf : rows.reduce((a, [, c]) => a + c, 0);
  if (!rows.length) return '<p>None yet.</p>';
  let h = '<table border="1" cellspacing="0" cellpadding="4"><tr><th></th><th>count</th><th>share</th></tr>';
  for (const [k, v] of rows) h += '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + share(v, denom) + '</td></tr>';
  return h + '</table>';
}

// The per-name verdict table (lens spec A4). Input: byNameVerdict —
// { name: { verdict: count } } from aggregateVisits' 'nameverdict'
// dimension (deployment-forward records only; earlier records carry
// no verdict and are not in this table at all). Columns per the
// spec: claimed name | claimed | verified-range | wrong-range |
// unverifiable-no-list | not-checked | verified share of checkable.
// Small-n discipline (the methods doc's wording governs): counts
// first — on a small number of checkable claims, a percentage is a
// costume on the counts, so the share prints only when the checkable
// count is at least 20; below that it reads "small n".
export const VERDICT_COLUMNS = ['verified-range', 'wrong-range', 'unverifiable-no-list', 'not-checked'];
export const VERDICT_TIER_LABEL = 'Address-grade, published ranges; the governing list version is carried in each record (rangever).';
export const VERDICT_ERA_NOTE = 'Verdicts exist only on records written since the verdict fields began (the Oct 18, 2026 deployment). Earlier records carry no verdict and are not counted here; the pre-change record stays ASN-grade forever, and the two eras are not mixed.';
export const VERDICT_SMALL_N = 20;

export function verdictRows(byNameVerdict) {
  const rows = [];
  for (const [name, byVerdict] of Object.entries(byNameVerdict || {})) {
    const r = { name, claimed: 0 };
    for (const col of VERDICT_COLUMNS) r[col] = (byVerdict && byVerdict[col]) || 0;
    r.claimed = VERDICT_COLUMNS.reduce((a, col) => a + r[col], 0);
    const checkable = r['verified-range'] + r['wrong-range'];
    r.verified_share_of_checkable = checkable >= VERDICT_SMALL_N
      ? (100 * r['verified-range'] / checkable).toFixed(1) + '%'
      : (checkable === 0 ? '—' : 'small n (' + checkable + ' checkable)');
    rows.push(r);
  }
  return rows.sort((a, b) => b.claimed - a.claimed);
}

export function verdictTableHtml(esc, byNameVerdict) {
  const rows = verdictRows(byNameVerdict);
  let h = '<p>' + esc(VERDICT_TIER_LABEL) + ' ' + esc(VERDICT_ERA_NOTE) + '</p>';
  h += '<p>Counts first: the verified share of checkable claims prints only at 20 or more checkable claims — below that, a percentage is a costume on a small n. A verdict is a statement about one request, one list version, one moment: verified-range certifies origin-network membership in the operator&rsquo;s published ranges, nothing about intent. not-checked is an instrument gap (no address header, or the list could not be bundled) — it is never folded into wrong-range.</p>';
  if (!rows.length) return h + '<p>No verdict-bearing records yet.</p>';
  h += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>claimed name</th><th>claimed</th><th>verified-range</th><th>wrong-range</th><th>unverifiable-no-list</th><th>not-checked</th><th>verified share of checkable</th></tr>';
  for (const r of rows) {
    h += '<tr><td>' + esc(r.name) + '</td><td>' + r.claimed + '</td><td>' + r['verified-range'] + '</td><td>' + r['wrong-range'] + '</td><td>' + r['unverifiable-no-list'] + '</td><td>' + r['not-checked'] + '</td><td>' + esc(r.verified_share_of_checkable) + '</td></tr>';
  }
  return h + '</table>';
}

// The visitor-digest series (lens spec B-e). Published name, on any
// surface: "distinct visitor digests (one day; unlinked across
// days)" — never bare "visitors". A digest is 16 hex chars of an
// HMAC over (Pacific day, egress address, user-agent) under a
// per-site secret (shared/visitor.mjs); equal digests mean the same
// (Pacific day, egress address, user-agent) triple — not the same
// person or device. The error directions travel with the figures,
// in one line: shared egress collapses distinct counts down; egress
// rotation inflates them. Days are Pacific days.
export const DIGEST_NAME = 'Distinct visitor digests (one day; unlinked across days)';
export const DIGEST_NOTE = 'A digest count is an approximation, not a census: shared egress (a NAT household, a corporate proxy) collapses distinct counts down; egress rotation inflates them up. Equal digests mean the same (Pacific day, egress address, user-agent) triple — never the same person. Nothing links across days in this series: the Pacific date is inside the keyed message, so digests from a previous day cannot be recomputed or matched.';
export const DIGEST_ERA_NOTE = 'The series begins with the first digest-bearing record (the Oct 18, 2026 deployment); earlier records carry no digest and none is implied for them. Records whose request reached the edge without an address header carry no digest either and sit outside this series. Era note (Oct 19, 2026): the first day\u2019s digests (Oct 18, 2026) were keyed on the UTC date, so that day\u2019s Pacific fold straddles two digest days and reads high; from Oct 19, 2026 the daily digest is keyed on the Pacific date itself.';

// The epoch digest series (D2, Oct 19 2026): the same construction
// keyed on the Pacific calendar month, published so distinct counts
// can span days. Per-day rows count distinct epoch digests on that
// Pacific day; a span count is a separate query, never a day sum.
export const EPOCH_NAME = 'Distinct visitor digests (epoch: one Pacific calendar month; linked across days within the month)';
export const EPOCH_NOTE = 'The epoch digest links a visitor\u2019s requests across the days of one Pacific calendar month, so a distinct count can span a week or the month — the daily series above cannot measure that span at all. The rows below count distinct epoch digests per Pacific day; a multi-day distinct count is NOT the sum of its days (one digest spans days by design) — span counts are computed over the epoch grouping by the hourly snapshot. Same approximation directions as the daily series: shared egress collapses the count down, egress rotation inflates it up, and a changed user-agent string counts as a new digest. The series begins with the Oct 19, 2026 deployment; earlier records carry no epoch digest.';

export function visitorDigestDays(byVisitorDay) {
  return Object.entries(byVisitorDay || {}).sort().map(([day, d]) => ({
    day,
    distinct_visitor_digests: d.distinct,
    digest_requests: d.digest_requests,
    repeat_requests: d.repeat_requests,
    repeat_share: d.digest_requests > 0 ? (100 * d.repeat_requests / d.digest_requests).toFixed(1) + '%' : '—'
  }));
}

export function visitorDigestTableHtml(esc, byVisitorDay) {
  const days = Object.entries(byVisitorDay || {}).sort();
  let h = '<p>' + esc(DIGEST_NAME) + '. ' + esc(DIGEST_NOTE) + ' ' + esc(DIGEST_ERA_NOTE) + '</p>';
  if (!days.length) return h + '<p>No digest-bearing records yet.</p>';
  h += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>day (Pacific)</th><th>distinct visitor digests</th><th>digest-bearing requests</th><th>requests from digests seen more than once</th><th>repeat share</th></tr>';
  for (const [day, d] of days) {
    h += '<tr><td>' + esc(day) + '</td><td>' + d.distinct + '</td><td>' + d.digest_requests + '</td><td>' + d.repeat_requests + '</td><td>' + (d.digest_requests > 0 ? (100 * d.repeat_requests / d.digest_requests).toFixed(1) + '%' : '—') + '</td></tr>';
  }
  return h + '</table>';
}

export function visitorEpochDays(byVisitorEpoch) {
  return visitorDigestDays(byVisitorEpoch);
}

export function visitorEpochTableHtml(esc, byVisitorEpoch) {
  const days = Object.entries(byVisitorEpoch || {}).sort();
  let h = '<p>' + esc(EPOCH_NAME) + '. ' + esc(EPOCH_NOTE) + '</p>';
  if (!days.length) return h + '<p>No epoch-digest-bearing records yet.</p>';
  h += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>day (Pacific)</th><th>distinct epoch digests</th><th>epoch-digest-bearing requests</th><th>requests from digests seen more than once that day</th><th>repeat share</th></tr>';
  for (const [day, d] of days) {
    h += '<tr><td>' + esc(day) + '</td><td>' + d.distinct + '</td><td>' + d.digest_requests + '</td><td>' + d.repeat_requests + '</td><td>' + (d.digest_requests > 0 ? (100 * d.repeat_requests / d.digest_requests).toFixed(1) + '%' : '—') + '</td></tr>';
  }
  return h + '</table>';
}

// The standardized `visits` block for the ?format=json shape — the
// B1 verification step diffs this block's key set between the two
// sites' pages: identical keys, per-site values. Both routes build
// it from their aggregate() result through this one function.
// The basis sentence for the visits block and the stats pages (D1,
// Oct 19 2026): the headline is HTTP fetches; `total` stays in the
// block as the all-records denominator the tables use, and the
// fetch/redirect split rides beside it.
export const VISITS_BASIS = 'HTTP fetches since Oct 17, 2026 — content requests; redirect responses counted separately';

export function visitsBlock(agg, asOf) {
  return {
    basis: VISITS_BASIS,
    as_of: asOf,
    total: agg.total,
    fetches_total: agg.fetchesTotal,
    redirects_total: agg.redirectsTotal,
    by_class: agg.byClass,
    by_class_fetches: agg.fetchesByClass,
    by_class_redirects: agg.redirectsByClass,
    by_purpose: agg.byPurpose,
    crawlers_claimed: agg.crawlersClaimed,
    fetchers_claimed: agg.fetchersClaimed,
    by_behaviour: agg.byBehaviour,
    by_status: agg.byStatus,
    by_event: agg.byEvent,
    top_paths: agg.topPaths,
    agent_interest_files: agg.interest,
    distinct_paths: agg.readDepth,
    by_day: agg.byDay,
    by_country: agg.topCountries,
    referrers: {
      grouped: agg.referrersGrouped.grouped,
      no_referer_recorded: agg.referrersGrouped.no_referer_recorded
    },
    by_verdict: agg.byVerdict,
    verdicts_by_name: verdictRows(agg.byNameVerdict),
    visitor_digests: { name: DIGEST_NAME, days: visitorDigestDays(agg.byVisitorDay) },
    visitor_epochs: { name: EPOCH_NAME, days: visitorEpochDays(agg.byVisitorEpoch) },
    truncated_dims: agg.truncatedDims || []
  };
}

// The referrer table (B1 §5): grouped name | count | share %, raw
// hosts printed beside the grouped name, then the closing
// "No referer recorded" line and the labels that ship with it.
export function referrerTableHtml(esc, groupedRefs, total) {
  let h = '';
  if (!groupedRefs.grouped.length && !groupedRefs.no_referer_recorded) return '<p>None yet.</p>';
  h += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>referrer</th><th>count</th><th>share</th></tr>';
  for (const g of groupedRefs.grouped.slice(0, 12)) {
    const hosts = g.hosts.map(([host, c]) => esc(host) + ' ' + c).join(' · ');
    h += '<tr><td>' + esc(g.name) + ' <span>(' + hosts + ')</span></td><td>' + g.count + '</td><td>' + share(g.count, total) + '</td></tr>';
  }
  h += '<tr><td>No referer recorded</td><td>' + groupedRefs.no_referer_recorded + '</td><td>' + share(groupedRefs.no_referer_recorded, total) + '</td></tr></table>';
  h += '<p>The referer is a claim sent by the browser. It is often absent or stripped — social apps and in-app browsers frequently send none, or only a generic shim host. Platform figures are a <strong>lower bound</strong>. &ldquo;No referer recorded&rdquo; is this site&rsquo;s total requests recorded minus the grouped referrer hosts; the residual also absorbs the rare unparseable referer. The request records cover GET/HEAD requests — referrer figures describe page traffic, not POSTs to the intake, signal, notes or press endpoints.</p>';
  return h;
}
