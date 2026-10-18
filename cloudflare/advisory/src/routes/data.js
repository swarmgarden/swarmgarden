// Bay Area Swarm Warning — the public data pages (added Oct 18
// 2026, steward commission): /data, /data/garden, /data/advisory,
// and the same-origin JSON files under /data/*.json.
//
// What these pages are: the project's record, published as data —
// per-site snapshot figures, the per-name claimed table with its
// address-range verdicts, and the 100 most recent requests per
// site — in a black-and-white raw-data register, easy for humans
// to read and navigate. (v1.1, Oct 18 2026: four aggregate tables
// join each site page — visits by path with a status-class split,
// visits by country under a small-count fold, response totals by
// status class with the 404 count broken out, and the daily
// series: visits by claimed class and the distinct-visitor
// counts, per Pacific day.)
// to read and navigate. Design basis: the public-data-page
// research (hidden_files/swarm-garden-design/
// public-data-page-research-2026-10-18.md) — semantic tables with
// the as-of stamp in the caption, visible filters with counts,
// facet filters, URL-encoded filter/sort state, per-view CSV/JSON
// downloads, a method + limitations block, dated corrections, and
// failed pulls rendered as an explained stale state.
//
// Where the data comes from: NOT this Worker's stores. The hourly
// snapshot job publishes the data files into the public repository
// (github.com/swarmgarden/swarmgarden, data/ tree) from its own
// pulls; these pages render the latest published files, fetched
// from the repository and cached at the edge. The git history is
// the permanent archive; a page as rendered here is archivable as
// served. Publishing into the repo first is what keeps this page
// honest when a pull fails: the last completed pull stays up,
// wearing its own as-of, with the failure stated — never a fresh
// timestamp over stale numbers (the crt.sh ambiguity failure mode
// the research names).
//
// These routes are answered directly, like the counts and stats
// routes: reads of the record are not visit-logged (a reader of
// the recent-100 should not write themselves into it), and a data
// failure can never reach page serving.
//
// PRIVACY (hard): the published files carry no visitor digest
// values (the per-day distinct COUNTS are published; the digests
// never are), no referers, no region/ASN/network fields, no raw
// addresses (the record stores none). Country appears only as the
// suppressed aggregate the producer built. This route publishes
// nothing beyond what the files carry.
//
// Every page ends with the steward-rule footer (Oct 18 2026):
// a prominent link to the record itself, https://swarmgarden.com.

const DATA_BASE_DEFAULT = 'https://raw.githubusercontent.com/swarmgarden/swarmgarden/main';
const DATA_FILES = ['garden.json', 'garden-claims.json', 'garden-recent.json',
  'garden-paths.json', 'garden-countries.json', 'garden-series.json', 'garden-responses.json',
  'advisory.json', 'advisory-claims.json', 'advisory-recent.json',
  'advisory-paths.json', 'advisory-countries.json', 'advisory-series.json', 'advisory-responses.json',
  'status.json'];
const REPO_DATA_URL = 'https://github.com/swarmgarden/swarmgarden/tree/main/data';
const REPO_RECORDS_URL = 'https://github.com/swarmgarden/swarmgarden/tree/main/records';
const FRESH_MS = 10 * 60 * 1000; // publication cadence is hourly

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const jsonForEmbed = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');

// ---------------------------------------------------------------- loading

function dataBase(env) {
  return (env && env.DATA_BASE_URL) || DATA_BASE_DEFAULT;
}

async function loadDataFile(env, ctx, name) {
  // Test/override seam: DATA_INLINE carries {filename: contents}.
  if (env && env.DATA_INLINE) {
    try {
      const m = JSON.parse(env.DATA_INLINE);
      if (m && typeof m[name] === 'string') return { text: m[name], stale: false };
    } catch (e) {}
  }
  const url = dataBase(env) + '/data/' + name;
  let cache = null;
  try { cache = caches.default; } catch (e) {}
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) {
        const at = Number(hit.headers.get('x-data-fetched-at') || 0);
        if (Date.now() - at < FRESH_MS) return { text: await hit.text(), stale: false };
      }
    } catch (e) {}
  }
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'swarm-garden-data-page/1.0' } });
    if (!r.ok) throw new Error('data fetch ' + r.status);
    const text = await r.text();
    if (cache) {
      const put = cache.put(url, new Response(text, {
        headers: { 'content-type': 'application/json', 'x-data-fetched-at': String(Date.now()) }
      })).catch(() => {});
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put); else await put;
    }
    return { text, stale: false };
  } catch (e) {
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) return { text: await hit.text(), stale: true };
      } catch (e2) {}
    }
    return null;
  }
}

async function loadJson(env, ctx, name) {
  const got = await loadDataFile(env, ctx, name);
  if (!got) return null;
  try { return { data: JSON.parse(got.text), stale: got.stale }; }
  catch (e) { return null; }
}

// ---------------------------------------------------------------- shell

const CSS = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;line-height:1.5}
main{max-width:1100px;margin:0 auto;padding:24px 16px 8px}
a{color:#000;text-decoration:underline}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid #000;outline-offset:2px}
.mono,.num{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.kicker{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:13px;letter-spacing:.08em;text-transform:uppercase;border-bottom:3px solid #000;padding-bottom:8px}
h1{font-size:28px;line-height:1.2;margin:14px 0 6px}
h2{font-size:20px;margin:34px 0 4px;border-bottom:2px solid #000;padding-bottom:4px}
h3{font-size:16px;margin:22px 0 4px}
p{max-width:75ch}
nav.pagenav{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:14px;margin:10px 0 0}
nav.pagenav a{margin-right:14px}
.banner{border:2px solid #000;padding:10px 14px;margin:18px 0}
.banner p{margin:4px 0}
.tablewrap{margin:10px 0 6px}
.table-scroll{overflow-x:auto;border:1px solid #000}
.table-scroll:focus{outline:2px solid #000;outline-offset:2px}
table{border-collapse:collapse;width:100%;font-size:14px}
caption{text-align:left;font-weight:600;padding:8px 2px;caption-side:top}
thead th{border-bottom:2px solid #000;background:#fff;position:sticky;top:0;text-align:left;padding:6px 8px;white-space:nowrap}
tbody td{border-bottom:1px solid #ccc;padding:5px 8px;vertical-align:top}
tbody tr:nth-child(even){background:#f5f5f5}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
td.path,th.path{word-break:break-all}
.gloss{font-size:13px;color:#000;max-width:85ch}
.controls{border:1px solid #000;padding:10px 14px;margin:10px 0}
.controls label{font-weight:600}
.controls input[type="search"]{font:inherit;padding:4px 8px;border:1px solid #000;width:min(420px,100%)}
fieldset{border:1px solid #000;margin:10px 0;padding:8px 12px}
legend{font-weight:600;padding:0 4px}
fieldset label{font-weight:400;margin-right:14px;white-space:nowrap}
.showing{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:14px}
button.dl{font:inherit;background:#fff;border:1px solid #000;padding:4px 10px;cursor:pointer;margin-right:8px}
button.dl:hover{background:#000;color:#fff}
th button.sort{font:inherit;font-weight:600;background:none;border:none;cursor:pointer;padding:0;text-decoration:underline}
.dlrow{margin:8px 0;font-size:14px}
ul.shelf{list-style:none;padding:0}
ul.shelf li{border:1px solid #000;padding:14px 16px;margin:12px 0}
ul.shelf h3{margin:0 0 4px}
footer.record-footer{border-top:3px solid #000;margin-top:56px;padding:22px 0 34px}
footer.record-footer p{font-size:22px;margin:0;max-width:none}
footer.record-footer a{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-weight:700}
.small{font-size:13px}
`;

function shell(title, bodyHtml, scriptHtml) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + esc(title) + '</title>' +
    '<meta name="description" content="The Swarm Garden\u2019s record, published as data: per-site figures, claimed-visitor tables with verdicts, and the 100 most recent requests per site, refreshed hourly.">' +
    '<style>' + CSS + '</style></head><body><main>' + bodyHtml +
    '<footer class="record-footer"><p>The record itself: <a href="https://swarmgarden.com">swarmgarden.com</a></p></footer>' +
    '</main>' + (scriptHtml || '') + '</body></html>';
}

function pageHead(kicker, h1, navSite) {
  let nav = '<nav class="pagenav"><a href="/data">Data index</a>' +
    '<a href="/data/garden">Garden data</a><a href="/data/advisory">Advisory data</a></nav>';
  return '<p class="kicker">' + esc(kicker) + '</p><h1>' + esc(h1) + '</h1>' + nav;
}

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' };

// ---------------------------------------------------------------- method

function methodBlock(siteLabel) {
  return '<h2>How this is counted — and what it cannot show</h2>' +
    '<p>Every figure on this page comes from the project\u2019s hourly snapshot of the two sites\u2019 records. ' +
    'A visit record is written at the edge when a request arrives. It carries the time, the path, the response status, ' +
    'and what the request\u2019s user-agent claimed. <strong>Classes and names are claims</strong>: a request announcing ' +
    '\u201cGPTBot\u201d is recorded as <em>claiming</em> to be GPTBot — never as proof of what sent it. The address-range ' +
    'verdict is the one check the record runs on a claim: whether the request\u2019s network address falls inside the ' +
    'ranges the claimed operator publishes. The address itself is never stored, and the verdict certifies ' +
    'origin-network membership only — nothing about intent.</p>' +
    '<p><strong>Verified arrivals come only from the Garden\u2019s ledger</strong> — an agent counts as arrived when it ' +
    'lands and verifies. Claims, signals, render reports and button presses never enter that figure. ' +
    'The stewards\u2019 own visits are included in these figures and are not filtered out; that is disclosed here ' +
    'rather than corrected away.</p>' +
    '<p><strong>Published as aggregates only:</strong> countries are published as counts, and any country ' +
    'with fewer than five visits in the window is folded into a single \u201cAll other countries\u201d ' +
    'row \u2014 the number folded is printed with the table, and no folded country is named. Distinct ' +
    'visitors are published as per-day counts (the series table below); the visitor digests those counts ' +
    'are made from are never printed, and because a digest is date-scoped the per-day counts cannot be ' +
    'added into a count of distinct visitors over time.</p>' +
    '<p><strong>Not published, by design:</strong> referers are not printed; region and network-operator ' +
    'facts stay in the steward copy; and no raw network address exists anywhere in the record to print. ' +
    'Paths are printed with query strings stripped.</p>' +
    '<p>The underlying store (Cloudflare Analytics Engine) retains raw records for three months, rolling. ' +
    'The hourly files in the public repository are the permanent form of this series — see the archive link ' +
    'below. This page shows ' + esc(siteLabel) + ' only; the two sites\u2019 figures are never added together.</p>';
}

function correctionsBlock(corrections) {
  let h = '<h2>Corrections</h2>';
  if (!corrections || !corrections.length) {
    return h + '<p>No corrections to the figures published here have been recorded. ' +
      'A correction, when one is needed, is dated and printed here — never folded silently into a later figure.</p>';
  }
  h += '<ul>';
  for (const c of corrections) h += '<li><strong>' + esc(c.date || '') + '</strong> — ' + esc(c.text || '') + '</li>';
  return h + '</ul>';
}

function archiveBlock(bundle) {
  return '<h2>The archive</h2><p>Every hour\u2019s data files are kept in the public repository: ' +
    '<a href="' + REPO_DATA_URL + '">github.com/swarmgarden/swarmgarden — data/</a> ' +
    '(the full time-series, in git history, so any figure here can be recounted from the first publication forward). ' +
    'The daily records export — counts series, daily detail, the ledger in public form — lives beside it: ' +
    '<a href="' + REPO_RECORDS_URL + '">records/</a>.</p>' +
    '<p class="small">Reuse: ' + esc(bundle && bundle.licence ? bundle.licence :
      'CC BY 4.0 — republish freely with attribution to the Swarm Garden record; keep each figure\u2019s counting window and as-of time attached to it.') + '</p>';
}

// ---------------------------------------------------------------- figures

function shareCell(v, total) {
  return (typeof v === 'number' && total > 0) ? (100 * v / total).toFixed(1) + '%' : '—';
}

function figuresHtml(bundle) {
  const f = bundle.figures || {};
  const total = (f.rows || []).find(r => r.label === 'Total recorded visits');
  const totalVal = total && typeof total.value === 'number' ? total.value : 0;
  let h = '<h2>Latest snapshot — figures</h2>';
  h += '<div class="tablewrap"><div class="table-scroll" tabindex="0"><table>' +
    '<caption>Figures for ' + esc(bundle.site_label) + '. Counting window: ' + esc(bundle.counting_window || '') +
    (bundle.counting_since ? ' (opens ' + esc(bundle.counting_since) + ')' : '') +
    '. As of the pull completed ' + esc(bundle.generated_at_pt || '') + '; refreshed hourly.</caption>' +
    '<thead><tr><th scope="col">Figure</th><th scope="col" class="num">Value</th><th scope="col">What it is</th></tr></thead><tbody>';
  for (const r of f.rows || []) {
    h += '<tr><td>' + esc(r.label) + '</td><td class="num mono">' +
      (r.value === null || r.value === undefined ? 'not a number — see the note' : Number(r.value).toLocaleString('en-US')) +
      '</td><td>' + esc(r.note || '—') + '</td></tr>';
  }
  h += '</tbody></table></div></div>';
  if (f.by_class) {
    h += '<h3>Visits by claimed class</h3><div class="tablewrap"><div class="table-scroll" tabindex="0"><table>' +
      '<caption>What each request\u2019s user-agent claimed, over the same window. A claim is not a verification.</caption>' +
      '<thead><tr><th scope="col">Claimed class</th><th scope="col" class="num">Requests</th><th scope="col" class="num">Share</th></tr></thead><tbody>';
    for (const r of f.by_class) {
      h += '<tr><td>' + esc(r.label) + '</td><td class="num mono">' + Number(r.value).toLocaleString('en-US') +
        '</td><td class="num mono">' + shareCell(r.value, totalVal) + '</td></tr>';
    }
    h += '</tbody></table></div></div>';
  } else {
    h += '<p>The claimed-class breakdown was unavailable in the latest pull — see the pull status above.</p>';
  }
  if (f.by_status) {
    h += '<h3>Responses by status</h3><div class="tablewrap"><div class="table-scroll" tabindex="0"><table>' +
      '<caption>Response statuses over the same window.</caption>' +
      '<thead><tr><th scope="col">Status</th><th scope="col" class="num">Responses</th><th scope="col" class="num">Share</th></tr></thead><tbody>';
    for (const r of f.by_status) {
      h += '<tr><td>' + esc(r.label) + '</td><td class="num mono">' + Number(r.value).toLocaleString('en-US') +
        '</td><td class="num mono">' + shareCell(r.value, totalVal) + '</td></tr>';
    }
    h += '</tbody></table></div></div>';
  } else {
    h += '<p>The status breakdown was unavailable in the latest pull — see the pull status above.</p>';
  }
  return h;
}

// ---------------------------------------------------------------- responses (v1.1)

function responsesHtml(responses, bundle) {
  let h = '<h3>Response totals by status class</h3>';
  if (!responses) {
    return h + '<p>The status-class totals were unavailable in the latest pull — see the pull status above.</p>';
  }
  const rows = responses.rows || [];
  const total = rows.reduce((a, r) => a + (r.value || 0), 0);
  h += '<div class="tablewrap"><div class="table-scroll" tabindex="0"><table>' +
    '<caption>Every response over the same window, rolled into its status class. The 404 count \u2014 ' +
    'addresses that are not here, most of them probes for files this site has never had \u2014 is broken ' +
    'out of the 4xx class. As of ' + esc(responses.generated_at_pt || bundle.generated_at_pt || '') + '.</caption>' +
    '<thead><tr><th scope="col">Status class</th><th scope="col" class="num">Responses</th>' +
    '<th scope="col" class="num">Share</th></tr></thead><tbody>';
  for (const r of rows) {
    h += '<tr><td>' + esc(r.label) + '</td><td class="num mono">' + Number(r.value).toLocaleString('en-US') +
      '</td><td class="num mono">' + shareCell(r.value, total) + '</td></tr>';
    if (r.class === '4xx' && typeof r.of_which_404 === 'number') {
      h += '<tr><td>\u2003of which: status 404</td><td class="num mono">' +
        Number(r.of_which_404).toLocaleString('en-US') + '</td><td class="num mono">' +
        shareCell(r.of_which_404, total) + '</td></tr>';
    }
  }
  h += '</tbody></table></div></div>';
  return h;
}

// ---------------------------------------------------------------- paths (v1.1)

function pathsHtml(paths, bundle) {
  let h = '<h2>Visits by page</h2>';
  if (!paths) {
    return h + '<p>This table was unavailable in the latest pull — it was not refreshed, and the previous ' +
      'hour\u2019s table is in the <a href="' + REPO_DATA_URL + '">data archive</a>. Its absence is a failed ' +
      'pull, not an empty record.</p>';
  }
  const rows = paths.rows || [];
  h += '<p class="gloss">Every path recorded for this site over the counting window \u2014 the pages ' +
    'visitors asked for, and the files the probes asked for. Query strings are stripped, so paths that ' +
    'differ only in a query string are folded together. Most of the 4xx column is the probe traffic: ' +
    'addresses for credential and configuration files this site has never had.</p>';
  h += '<div class="controls" data-controls="paths">' +
    '<label for="paths-q">Filter by path</label> ' +
    '<input type="search" id="paths-q" data-q placeholder="e.g. /llms.txt" autocomplete="off">' +
    '<p class="showing" id="paths-count" aria-live="polite">Showing ' + rows.length + ' of ' + rows.length + ' paths.</p>' +
    '<p class="dlrow"><button type="button" class="dl" data-dl="csv" data-table="paths">Download CSV (current view)</button>' +
    '<button type="button" class="dl" data-dl="json" data-table="paths">Download JSON (current view)</button>' +
    '<a href="/data/' + esc(bundle.site) + '-paths.json">Full table as JSON</a></p></div>';
  h += '<div class="tablewrap"><div class="table-scroll" tabindex="0"><table id="paths-table" data-enhance="paths">' +
    '<caption>Visits by path, ' + esc(bundle.site_label) + ', split by response status class. ' +
    esc(paths.window || '') + ' As of ' + esc(paths.generated_at_pt || bundle.generated_at_pt || '') + '.</caption>' +
    '<thead><tr>' +
    '<th scope="col"><button type="button" class="sort" data-sort="path">Path</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="visits">Visits</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="2xx">2xx</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="3xx">3xx</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="4xx">4xx</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="5xx">5xx</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="none_recorded">No status</button></th>' +
    '</tr></thead><tbody>';
  if (!rows.length) h += '<tr><td colspan="7">No paths recorded yet in this window.</td></tr>';
  for (const r of rows) {
    h += '<tr><td class="path mono">' + esc(r.path) + '</td><td class="num mono">' + r.visits +
      '</td><td class="num mono">' + r['2xx'] + '</td><td class="num mono">' + r['3xx'] +
      '</td><td class="num mono">' + r['4xx'] + '</td><td class="num mono">' + r['5xx'] +
      '</td><td class="num mono">' + r.none_recorded + '</td></tr>';
  }
  h += '</tbody></table></div></div>';
  h += '<script type="application/json" id="paths-rows">' + jsonForEmbed(rows) + '</script>';
  return h;
}

// ---------------------------------------------------------------- countries (v1.1)

function countriesHtml(countries, bundle) {
  let h = '<h2>Visits by country</h2>';
  if (!countries) {
    return h + '<p>This table was unavailable in the latest pull — it was not refreshed, and the previous ' +
      'hour\u2019s table is in the <a href="' + REPO_DATA_URL + '">data archive</a>. Its absence is a failed ' +
      'pull, not an empty record.</p>';
  }
  const sup = countries.suppression || {};
  const display = (countries.rows || []).slice();
  if (sup.folded_countries > 0) {
    display.push({ country: 'All other countries', visits: sup.folded_visits || 0,
      note: sup.folded_countries + (sup.folded_countries === 1 ? ' country' : ' countries') +
        ', each with fewer than ' + (sup.threshold || 5) + ' visits \u2014 folded, not named' });
  }
  for (const r of display) if (!r.note) r.note = '';
  h += '<p class="gloss">Country is the one geography this record publishes, and only as this ' +
    'aggregate: a country with fewer than ' + (sup.threshold || 5) + ' visits in the window folds into ' +
    '\u201cAll other countries\u201d and is not named. Region and network operator stay in the ' +
    'steward copy. Country codes are the two-letter codes the edge reported.</p>';
  h += '<div class="controls" data-controls="countries">' +
    '<label for="countries-q">Filter by country</label> ' +
    '<input type="search" id="countries-q" data-q placeholder="e.g. US" autocomplete="off">' +
    '<p class="showing" id="countries-count" aria-live="polite">Showing ' + display.length + ' of ' + display.length + ' rows.</p>' +
    '<p class="dlrow"><button type="button" class="dl" data-dl="csv" data-table="countries">Download CSV (current view)</button>' +
    '<button type="button" class="dl" data-dl="json" data-table="countries">Download JSON (current view)</button>' +
    '<a href="/data/' + esc(bundle.site) + '-countries.json">Full table as JSON</a></p></div>';
  h += '<div class="tablewrap"><div class="table-scroll" tabindex="0"><table id="countries-table" data-enhance="countries">' +
    '<caption>Visits by country, ' + esc(bundle.site_label) + '. ' + esc(countries.window || '') +
    ' Suppression: ' + esc(sup.rule || '') +
    (countries.not_recorded ? ' Visits with no country recorded: ' + Number(countries.not_recorded).toLocaleString('en-US') +
      ' \u2014 counted in the site total, in no country row.' : '') +
    ' As of ' + esc(countries.generated_at_pt || bundle.generated_at_pt || '') + '.</caption>' +
    '<thead><tr>' +
    '<th scope="col"><button type="button" class="sort" data-sort="country">Country</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="visits">Visits</button></th>' +
    '<th scope="col">Note</th>' +
    '</tr></thead><tbody>';
  if (!display.length) h += '<tr><td colspan="3">No visits with a recorded country yet in this window.</td></tr>';
  for (const r of display) {
    h += '<tr><td>' + esc(r.country) + '</td><td class="num mono">' + r.visits +
      '</td><td>' + esc(r.note || '\u2014') + '</td></tr>';
  }
  h += '</tbody></table></div></div>';
  h += '<script type="application/json" id="countries-rows">' + jsonForEmbed(display) + '</script>';
  return h;
}

// ---------------------------------------------------------------- series (v1.1)

function seriesHtml(series, bundle) {
  let h = '<h2>The daily series</h2>';
  if (!series) {
    return h + '<p>The daily series was unavailable in the latest pull — it was not refreshed, and the ' +
      'previous hour\u2019s series is in the <a href="' + REPO_DATA_URL + '">data archive</a>. Its absence ' +
      'is a failed pull, not an empty record.</p>';
  }
  for (const note of series.unavailable_notes || []) {
    h += '<p>' + esc(note) + '</p>';
  }
  if (series.class_days) {
    const classes = series.classes || ['agent-claimed', 'browser', 'automation', 'unknown'];
    h += '<h3>Visits by claimed class, by day</h3><div class="tablewrap"><div class="table-scroll" tabindex="0"><table>' +
      '<caption>' + esc(series.class_note || '') + ' As of ' +
      esc(series.generated_at_pt || bundle.generated_at_pt || '') +
      '. Full series as JSON: <a href="/data/' + esc(bundle.site) + '-series.json">' + esc(bundle.site) + '-series.json</a>.</caption>' +
      '<thead><tr><th scope="col">Day (Pacific)</th>' +
      classes.map(c => '<th scope="col" class="num">' + esc(c) + '</th>').join('') +
      '<th scope="col" class="num">Total</th></tr></thead><tbody>';
    if (!series.class_days.length) h += '<tr><td colspan="' + (classes.length + 2) + '">No days recorded yet.</td></tr>';
    for (const r of series.class_days) {
      h += '<tr><td class="mono">' + esc(r.day) + '</td>' +
        classes.map(c => '<td class="num mono">' + (r[c] || 0) + '</td>').join('') +
        '<td class="num mono">' + r.total + '</td></tr>';
    }
    h += '</tbody></table></div></div>';
  } else {
    h += '<h3>Visits by claimed class, by day</h3><p>That half of the series was not refreshed in the ' +
      'latest pull — see the note above.</p>';
  }
  if (series.visitor_days) {
    h += '<h3>Distinct visitors, by day</h3><div class="tablewrap"><div class="table-scroll" tabindex="0"><table>' +
      '<caption>' + esc(series.visitor_note || '') + ' As of ' +
      esc(series.generated_at_pt || bundle.generated_at_pt || '') + '.</caption>' +
      '<thead><tr><th scope="col">Day (Pacific)</th><th scope="col" class="num">Distinct visitors</th>' +
      '<th scope="col" class="num">Requests carrying a digest</th>' +
      '<th scope="col" class="num">Of those, requests from visitors seen more than once that day</th></tr></thead><tbody>';
    if (!series.visitor_days.length) h += '<tr><td colspan="4">No digest-bearing days recorded yet.</td></tr>';
    for (const r of series.visitor_days) {
      h += '<tr><td class="mono">' + esc(r.day) + '</td><td class="num mono">' + r.distinct_visitors +
        '</td><td class="num mono">' + r.digest_requests + '</td><td class="num mono">' +
        r.repeat_requests + '</td></tr>';
    }
    h += '</tbody></table></div></div>';
  } else {
    h += '<h3>Distinct visitors, by day</h3><p>That half of the series was not refreshed in the ' +
      'latest pull — see the note above.</p>';
  }
  return h;
}

// ---------------------------------------------------------------- claims

function claimsHtml(claims, bundle) {
  let h = '<h2>Claimed visitors, by name — with address-range verdicts</h2>';
  if (!claims) {
    return h + '<p>This table was unavailable in the latest pull — it was not refreshed, and the previous ' +
      'hour\u2019s table is in the <a href="' + REPO_DATA_URL + '">data archive</a>. Its absence is a failed ' +
      'pull, not an empty record.</p>';
  }
  const rows = claims.rows || [];
  h += '<p class="gloss">Each name is a claim read from the visiting software\u2019s own announcement. The verdict ' +
    'checks the request\u2019s network address against the ranges the claimed operator publishes: ' +
    '<strong>verified-range</strong> (inside them), <strong>wrong-range</strong> (outside them), ' +
    '<strong>unverifiable-no-list</strong> (the operator publishes no list to check against), ' +
    '<strong>not-checked</strong> (the instrument could not test this request — never folded into wrong-range). ' +
    'Counts first: the verified share prints only at 20 or more checkable claims — below that, a percentage ' +
    'is a costume on a small n.</p>';
  h += '<div class="controls" data-controls="claims">' +
    '<label for="claims-q">Filter by name</label> ' +
    '<input type="search" id="claims-q" data-q placeholder="e.g. GPTBot" autocomplete="off">' +
    '<p class="showing" id="claims-count" aria-live="polite">Showing ' + rows.length + ' of ' + rows.length + ' claimed names.</p>' +
    '<p class="dlrow"><button type="button" class="dl" data-dl="csv" data-table="claims">Download CSV (current view)</button>' +
    '<button type="button" class="dl" data-dl="json" data-table="claims">Download JSON (current view)</button>' +
    '<a href="/data/' + esc(bundle.site) + '-claims.json">Full table as JSON</a></p></div>';
  h += '<div class="tablewrap"><div class="table-scroll" tabindex="0"><table id="claims-table" data-enhance="claims">' +
    '<caption>Claimed names with verdicts, ' + esc(bundle.site_label) + '. ' + esc(claims.era_note || '') +
    ' As of ' + esc(claims.generated_at_pt || bundle.generated_at_pt || '') + '.</caption>' +
    '<thead><tr>' +
    '<th scope="col"><button type="button" class="sort" data-sort="name">Claimed name</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="claimed">Claimed</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="verified-range">Verified-range</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="wrong-range">Wrong-range</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="unverifiable-no-list">Unverifiable-no-list</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="not-checked">Not checked</button></th>' +
    '<th scope="col"><button type="button" class="sort" data-sort="verified_share_of_checkable">Verified share of checkable</button></th>' +
    '</tr></thead><tbody>';
  if (!rows.length) h += '<tr><td colspan="7">No verdict-bearing records yet — verdicts exist only on records written since the verdict fields began.</td></tr>';
  for (const r of rows) {
    h += '<tr><td>' + esc(r.name) + '</td><td class="num mono">' + r.claimed + '</td><td class="num mono">' +
      r['verified-range'] + '</td><td class="num mono">' + r['wrong-range'] + '</td><td class="num mono">' +
      r['unverifiable-no-list'] + '</td><td class="num mono">' + r['not-checked'] + '</td><td>' +
      esc(r.verified_share_of_checkable) + '</td></tr>';
  }
  h += '</tbody></table></div></div>';
  h += '<script type="application/json" id="claims-rows">' + jsonForEmbed(rows) + '</script>';
  return h;
}

// ---------------------------------------------------------------- recent

function statusClass(r) {
  return (r.status === null || r.status === undefined) ? 'none recorded' : Math.floor(r.status / 100) + 'xx';
}

function facetFieldset(kind, title, values) {
  let h = '<fieldset><legend>' + esc(title) + '</legend>';
  for (const [val, count] of values) {
    const id = 'f-' + kind + '-' + val.replace(/[^a-z0-9]+/gi, '-');
    h += '<label for="' + esc(id) + '"><input type="checkbox" id="' + esc(id) + '" data-facet="' + kind +
      '" value="' + esc(val) + '"> ' + esc(val) + ' <span class="mono">×' + count + '</span></label>';
  }
  return h + '</fieldset>';
}

function recentHtml(recent, bundle) {
  let h = '<h2>The 100 most recent requests</h2>';
  if (!recent) {
    return h + '<p>This table was unavailable in the latest pull — it was not refreshed, and the previous ' +
      'hour\u2019s table is in the <a href="' + REPO_DATA_URL + '">data archive</a>. Its absence is a failed ' +
      'pull, not an empty record.</p>';
  }
  const rows = recent.rows || [];
  const scCounts = {}, vdCounts = {};
  for (const r of rows) {
    const sc = statusClass(r); scCounts[sc] = (scCounts[sc] || 0) + 1;
    vdCounts[r.verdict_text] = (vdCounts[r.verdict_text] || 0) + 1;
  }
  const byCount = (a, b) => b[1] - a[1];
  h += '<div class="controls" data-controls="recent">' +
    '<label for="recent-q">Filter by path or claimed name</label> ' +
    '<input type="search" id="recent-q" data-q placeholder="e.g. /llms.txt or GPTBot" autocomplete="off">' +
    facetFieldset('sc', 'Status class', Object.entries(scCounts).sort(byCount)) +
    facetFieldset('vd', 'Verdict', Object.entries(vdCounts).sort(byCount)) +
    '<p class="showing" id="recent-count" aria-live="polite">Showing ' + rows.length + ' of ' + rows.length + ' requests.</p>' +
    '<p class="dlrow"><button type="button" class="dl" data-dl="csv" data-table="recent">Download CSV (current view)</button>' +
    '<button type="button" class="dl" data-dl="json" data-table="recent">Download JSON (current view)</button>' +
    '<a href="/data/' + esc(bundle.site) + '-recent.json">Full table as JSON</a></p></div>';
  h += '<div class="tablewrap"><div class="table-scroll" tabindex="0"><table id="recent-table" data-enhance="recent">' +
    '<caption>The 100 most recent requests recorded for ' + esc(bundle.site_label) + ', newest first. ' +
    'Times are Pacific. As of the pull completed ' + esc(recent.generated_at_pt || bundle.generated_at_pt || '') +
    '; refreshed hourly. A name in the claimed-name column is what the request announced — a claim, not a verification.</caption>' +
    '<thead><tr>' +
    '<th scope="col"><button type="button" class="sort" data-sort="t_utc">Time (Pacific)</button></th>' +
    '<th scope="col"><button type="button" class="sort" data-sort="path">Path</button></th>' +
    '<th scope="col"><button type="button" class="sort" data-sort="claimed_name">Claimed name</button></th>' +
    '<th scope="col" class="num"><button type="button" class="sort" data-sort="status">Status</button></th>' +
    '<th scope="col"><button type="button" class="sort" data-sort="verdict_text">Verdict</button></th>' +
    '</tr></thead><tbody>';
  if (!rows.length) h += '<tr><td colspan="5">No requests recorded yet in this window.</td></tr>';
  for (const r of rows) {
    h += '<tr><td class="mono">' + esc(r.t_pt) + '</td><td class="path mono">' + esc(r.path) + '</td><td>' +
      esc(r.claimed_name) + '</td><td class="num mono">' + esc(r.status_text) + '</td><td>' +
      esc(r.verdict_text) + '</td></tr>';
  }
  h += '</tbody></table></div></div>';
  h += '<script type="application/json" id="recent-rows">' + jsonForEmbed(rows) + '</script>';
  return h;
}

// ---------------------------------------------------------------- pages

function statusBanner(bundle, siteStatus) {
  if (!siteStatus) return '';
  if (siteStatus.state === 'failed') {
    return '<div class="banner"><p><strong>The latest hourly pull failed for this site</strong> ' +
      '(attempted ' + esc(siteStatus.last_attempt_pt || '') + '). The figures and tables below are from the ' +
      'last completed pull, ' + esc(bundle.generated_at_pt || '') + ' — they are labelled with that time ' +
      'everywhere they appear. A failed pull is recorded here, never dressed as fresh data.</p></div>';
  }
  if (siteStatus.state === 'degraded' || bundle.pull_status === 'degraded') {
    const notes = (siteStatus.notes && siteStatus.notes.length ? siteStatus.notes : bundle.unavailable_notes) || [];
    return '<div class="banner"><p><strong>The latest pull was partial.</strong> ' +
      notes.map(esc).join(' ') + ' Everything below is labelled with the pull it came from.</p></div>';
  }
  return '';
}

function sitePage(bundle, claims, recent, siteStatus, agg) {
  const other = bundle.site === 'garden'
    ? '<a href="/data/advisory">The Advisory\u2019s data</a>'
    : '<a href="/data/garden">The Garden\u2019s data</a>';
  let body = pageHead('The Swarm Garden — the data', bundle.site_label + ' — the data');
  body += '<p>Requests as recorded at the edge of this site, counted from its own window. ' +
    'This is the raw record, published hourly — the same figures the project keeps for itself, ' +
    'with nothing held back but what the privacy paragraph below names. The other site\u2019s data ' +
    'is published separately, never added to this: ' + other + '.</p>';
  body += statusBanner(bundle, siteStatus);
  body += methodBlock(bundle.site_label);
  body += figuresHtml(bundle);
  body += responsesHtml(agg && agg.responses, bundle);
  body += pathsHtml(agg && agg.paths, bundle);
  body += countriesHtml(agg && agg.countries, bundle);
  body += seriesHtml(agg && agg.series, bundle);
  body += claimsHtml(claims, bundle);
  body += recentHtml(recent, bundle);
  body += correctionsBlock(bundle.corrections);
  body += archiveBlock(bundle);
  return shell(bundle.site_label + ' — the data', body, CLIENT_JS);
}

function siteShelf(site, bundle, siteStatus) {
  if (!bundle) {
    return '<li><h3>' + esc(site === 'garden' ? 'Garden — swarmgarden.com' : 'Advisory — bayareaswarmwarning.com') +
      '</h3><p>Its data file could not be loaded for this rendering. The archive holds every hour: ' +
      '<a href="' + REPO_DATA_URL + '">data/</a>.</p></li>';
  }
  const total = (bundle.figures.rows || []).find(r => r.label === 'Total recorded visits');
  const arr = (bundle.figures.rows || []).find(r => r.label === 'Verified agent arrivals on record');
  return '<li><h3><a href="/data/' + esc(site) + '">' + esc(bundle.site_label) + '</a></h3>' +
    '<p>Latest snapshot figures, visits by page and by country, the daily series, the per-name claimed table with verdicts, and the 100 most recent requests. ' +
    'Total recorded visits: <span class="mono">' + (total && total.value !== null && total.value !== undefined ? Number(total.value).toLocaleString('en-US') : 'unavailable in the latest pull') + '</span> · ' +
    'Verified agent arrivals on record: <span class="mono">' + (arr && arr.value !== null && arr.value !== undefined ? arr.value : 'see the page') + '</span> · ' +
    'As of ' + esc(bundle.generated_at_pt || '') + ', refreshed hourly' +
    (siteStatus && siteStatus.state === 'failed' ? ' — <strong>the latest pull failed; the page says so and shows the last completed pull</strong>' : '') + '.</p>' +
    '<p class="small">Formats: <a href="/data/' + esc(site) + '">page</a> · ' +
    '<a href="/data/' + esc(site) + '.json">figures JSON</a> · ' +
    '<a href="/data/' + esc(site) + '-claims.json">claims JSON</a> · ' +
    '<a href="/data/' + esc(site) + '-recent.json">recent-requests JSON</a> · ' +
    '<a href="/data/' + esc(site) + '-paths.json">paths JSON</a> · ' +
    '<a href="/data/' + esc(site) + '-countries.json">countries JSON</a> · ' +
    '<a href="/data/' + esc(site) + '-series.json">daily-series JSON</a> · ' +
    '<a href="/data/' + esc(site) + '-responses.json">status-class JSON</a></p></li>';
}

function indexPage(garden, advisory, status) {
  let body = pageHead('The Swarm Garden — the data', 'The data — both sites, in the open');
  body += '<p>The data can speak for itself. These pages publish the project\u2019s record — the same ' +
    'figures the stewards read — refreshed hourly, with every hour kept in the public repository so ' +
    'the record stands outside our own systems. Each site is a separate dataset, on its own page, ' +
    'counted from its own window; the two are never added together.</p>';
  body += '<ul class="shelf">' +
    siteShelf('garden', garden && garden.data, status && status.data && status.data.sites && status.data.sites.garden) +
    siteShelf('advisory', advisory && advisory.data, status && status.data && status.data.sites && status.data.sites.advisory) +
    '</ul>';
  body += methodBlock('each site');
  body += correctionsBlock([]);
  body += archiveBlock(null);
  return shell('The data — The Swarm Garden', body, '');
}

function unavailablePage(what) {
  let body = pageHead('The Swarm Garden — the data', 'The data — temporarily unavailable');
  body += '<div class="banner"><p><strong>The published data files could not be loaded for this rendering.</strong> ' +
    'That is a loading failure, not an empty record: the record itself stands, and every hour\u2019s files ' +
    'are in the public repository: <a href="' + REPO_DATA_URL + '">github.com/swarmgarden/swarmgarden — data/</a>. ' +
    'This page will render again from the next completed load.</p></div>';
  body += methodBlock('each site');
  return shell('The data — temporarily unavailable', body, '');
}

// ---------------------------------------------------------------- client JS
// Progressive enhancement only: the tables above are complete with
// JS off. With JS on, this wires the visible filters, the facet
// checkboxes, single-column sort (aria-sort), the live "Showing N
// of M" count, URL-encoded state (params prefixed per table), and
// CSV/JSON downloads of the CURRENT view.

const CLIENT_JS = `<script>
(function(){
  function parseRows(id){ try { return JSON.parse(document.getElementById(id).textContent); } catch(e){ return []; } }
  function csvCell(v){ v = (v===null||v===undefined)?'':String(v); return /[",\\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v; }
  function toCSV(headers, rows){ return [headers.join(',')].concat(rows.map(function(r){ return r.map(csvCell).join(','); })).join('\\n') + '\\n'; }
  function download(name, text, type){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], {type: type}));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }
  function setup(cfg){
    var table = document.getElementById(cfg.tableId);
    if (!table) return;
    var rows = parseRows(cfg.dataId);
    var state = { q:'', facets:{}, sort: cfg.defaultSort, dir: cfg.defaultDir };
    var params = new URLSearchParams(location.search);
    state.q = params.get(cfg.prefix+'q') || '';
    state.sort = params.get(cfg.prefix+'sort') || state.sort;
    state.dir = params.get(cfg.prefix+'dir') || state.dir;
    cfg.facetKinds.forEach(function(kind){
      var v = params.get(cfg.prefix+kind);
      state.facets[kind] = v ? v.split('|') : [];
    });
    var qInput = document.querySelector('[data-controls="'+cfg.name+'"] [data-q]');
    if (qInput) { qInput.value = state.q; qInput.addEventListener('input', function(){ state.q = qInput.value; render(); }); }
    document.querySelectorAll('[data-controls="'+cfg.name+'"] [data-facet]').forEach(function(box){
      var kind = box.getAttribute('data-facet');
      if ((state.facets[kind]||[]).indexOf(box.value) >= 0) box.checked = true;
      box.addEventListener('change', function(){
        var set = state.facets[kind] || (state.facets[kind] = []);
        var i = set.indexOf(box.value);
        if (box.checked && i < 0) set.push(box.value);
        if (!box.checked && i >= 0) set.splice(i, 1);
        render();
      });
    });
    table.querySelectorAll('th button.sort').forEach(function(btn){
      btn.addEventListener('click', function(){
        var key = btn.getAttribute('data-sort');
        if (state.sort === key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = key; state.dir = cfg.defaultDirFor ? cfg.defaultDirFor(key) : 'asc'; }
        render();
      });
    });
    document.querySelectorAll('[data-dl][data-table="'+cfg.name+'"]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var view = currentView();
        if (btn.getAttribute('data-dl') === 'csv') download(cfg.name+'-current-view.csv', toCSV(cfg.headers, view.map(cfg.rowArray)), 'text/csv');
        else download(cfg.name+'-current-view.json', JSON.stringify(view, null, 2) + '\\n', 'application/json');
      });
    });
    function currentView(){
      var view = rows.filter(function(r){
        if (state.q) {
          var hay = cfg.searchText(r).toLowerCase();
          if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
        }
        for (var kind of cfg.facetKinds) {
          var set = state.facets[kind] || [];
          if (set.length && set.indexOf(cfg.facetValue(r, kind)) < 0) return false;
        }
        return true;
      });
      var key = state.sort, dir = state.dir === 'desc' ? -1 : 1;
      view.sort(function(a, b){
        var x = a[key], y = b[key];
        if (x === null || x === undefined) x = '';
        if (y === null || y === undefined) y = '';
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
      return view;
    }
    function render(){
      var view = currentView();
      var tbody = table.querySelector('tbody');
      tbody.innerHTML = '';
      if (!view.length) {
        var tr = document.createElement('tr');
        var td = document.createElement('td');
        td.colSpan = cfg.headers.length;
        td.textContent = cfg.zeroText(rows.length);
        tr.appendChild(td); tbody.appendChild(tr);
      } else {
        view.forEach(function(r){
          var tr = document.createElement('tr');
          cfg.cells(r).forEach(function(c){
            var td = document.createElement('td');
            if (c.cls) td.className = c.cls;
            td.textContent = c.text;
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
      }
      table.querySelectorAll('th').forEach(function(th){
        var btn = th.querySelector('button.sort');
        if (btn && btn.getAttribute('data-sort') === state.sort) th.setAttribute('aria-sort', state.dir === 'desc' ? 'descending' : 'ascending');
        else th.removeAttribute('aria-sort');
      });
      var count = document.getElementById(cfg.countId);
      if (count) count.textContent = cfg.countText(view.length, rows.length);
      var p = new URLSearchParams(location.search);
      if (state.q) p.set(cfg.prefix+'q', state.q); else p.delete(cfg.prefix+'q');
      cfg.facetKinds.forEach(function(kind){
        var set = state.facets[kind] || [];
        if (set.length) p.set(cfg.prefix+kind, set.join('|')); else p.delete(cfg.prefix+kind);
      });
      p.set(cfg.prefix+'sort', state.sort); p.set(cfg.prefix+'dir', state.dir);
      history.replaceState(null, '', location.pathname + '?' + p.toString());
    }
    render();
  }
  setup({
    name: 'recent', tableId: 'recent-table', dataId: 'recent-rows', countId: 'recent-count',
    prefix: 'r_', facetKinds: ['sc','vd'], defaultSort: 't_utc', defaultDir: 'desc',
    defaultDirFor: function(k){ return k === 't_utc' ? 'desc' : 'asc'; },
    headers: ['time_utc','time_pt','path','claimed_name','status','verdict'],
    searchText: function(r){ return r.path + ' ' + r.claimed_name; },
    facetValue: function(r, kind){
      if (kind === 'sc') return (r.status === null || r.status === undefined) ? 'none recorded' : Math.floor(r.status/100) + 'xx';
      return r.verdict_text;
    },
    rowArray: function(r){ return [r.t_utc, r.t_pt, r.path, r.claimed_name, r.status_text, r.verdict_text]; },
    cells: function(r){ return [
      {text: r.t_pt, cls: 'mono'}, {text: r.path, cls: 'path mono'}, {text: r.claimed_name},
      {text: r.status_text, cls: 'num mono'}, {text: r.verdict_text} ]; },
    countText: function(n, m){ return 'Showing ' + n + ' of ' + m + ' requests.'; },
    zeroText: function(m){ return '0 of the last ' + m + ' requests match the current filters — that is a result, not an error. Clear a filter to see more of the record.'; }
  });
  setup({
    name: 'claims', tableId: 'claims-table', dataId: 'claims-rows', countId: 'claims-count',
    prefix: 'c_', facetKinds: [], defaultSort: 'claimed', defaultDir: 'desc',
    defaultDirFor: function(k){ return k === 'name' ? 'asc' : 'desc'; },
    headers: ['name','claimed','verified-range','wrong-range','unverifiable-no-list','not-checked','verified_share_of_checkable'],
    searchText: function(r){ return r.name; },
    facetValue: function(){ return ''; },
    rowArray: function(r){ return [r.name, r.claimed, r['verified-range'], r['wrong-range'], r['unverifiable-no-list'], r['not-checked'], r.verified_share_of_checkable]; },
    cells: function(r){ return [
      {text: r.name}, {text: String(r.claimed), cls: 'num mono'}, {text: String(r['verified-range']), cls: 'num mono'},
      {text: String(r['wrong-range']), cls: 'num mono'}, {text: String(r['unverifiable-no-list']), cls: 'num mono'},
      {text: String(r['not-checked']), cls: 'num mono'}, {text: r.verified_share_of_checkable} ]; },
    countText: function(n, m){ return 'Showing ' + n + ' of ' + m + ' claimed names.'; },
    zeroText: function(m){ return '0 of the ' + m + ' claimed names match the current filter — that is a result, not an error.'; }
  });
  setup({
    name: 'paths', tableId: 'paths-table', dataId: 'paths-rows', countId: 'paths-count',
    prefix: 'p_', facetKinds: [], defaultSort: 'visits', defaultDir: 'desc',
    defaultDirFor: function(k){ return k === 'path' ? 'asc' : 'desc'; },
    headers: ['path','visits','2xx','3xx','4xx','5xx','none_recorded'],
    searchText: function(r){ return r.path; },
    facetValue: function(){ return ''; },
    rowArray: function(r){ return [r.path, r.visits, r['2xx'], r['3xx'], r['4xx'], r['5xx'], r.none_recorded]; },
    cells: function(r){ return [
      {text: r.path, cls: 'path mono'}, {text: String(r.visits), cls: 'num mono'},
      {text: String(r['2xx']), cls: 'num mono'}, {text: String(r['3xx']), cls: 'num mono'},
      {text: String(r['4xx']), cls: 'num mono'}, {text: String(r['5xx']), cls: 'num mono'},
      {text: String(r.none_recorded), cls: 'num mono'} ]; },
    countText: function(n, m){ return 'Showing ' + n + ' of ' + m + ' paths.'; },
    zeroText: function(m){ return '0 of the ' + m + ' recorded paths match the current filter — that is a result, not an error.'; }
  });
  setup({
    name: 'countries', tableId: 'countries-table', dataId: 'countries-rows', countId: 'countries-count',
    prefix: 'g_', facetKinds: [], defaultSort: 'visits', defaultDir: 'desc',
    defaultDirFor: function(k){ return k === 'country' ? 'asc' : 'desc'; },
    headers: ['country','visits','note'],
    searchText: function(r){ return r.country; },
    facetValue: function(){ return ''; },
    rowArray: function(r){ return [r.country, r.visits, r.note || '']; },
    cells: function(r){ return [
      {text: r.country}, {text: String(r.visits), cls: 'num mono'}, {text: r.note || '\u2014'} ]; },
    countText: function(n, m){ return 'Showing ' + n + ' of ' + m + ' rows.'; },
    zeroText: function(m){ return '0 of the ' + m + ' rows match the current filter — that is a result, not an error.'; }
  });
})();
</script>`;

// ---------------------------------------------------------------- routes

export async function dataJsonRoute(req, env, ctx, name) {
  if (!DATA_FILES.includes(name)) {
    return new Response(JSON.stringify({ error: 'No such data file. The published files are listed at https://bayareaswarmwarning.com/data' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } });
  }
  const got = await loadDataFile(env, ctx, name);
  if (!got) {
    return new Response(JSON.stringify({ error: 'The published data file could not be loaded for this request. The archive is at ' + REPO_DATA_URL }),
      { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(got.text, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }
  });
}

export default async (req, env, ctx) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/data';
  const status = await loadJson(env, ctx, 'status.json');
  if (path === '/data') {
    const [g, a] = await Promise.all([
      loadJson(env, ctx, 'garden.json'), loadJson(env, ctx, 'advisory.json')]);
    if (!g && !a) return new Response(unavailablePage('index'), { status: 200, headers: HTML_HEADERS });
    return new Response(indexPage(g, a, status), { status: 200, headers: HTML_HEADERS });
  }
  const site = path === '/data/garden' ? 'garden' : path === '/data/advisory' ? 'advisory' : null;
  if (!site) return new Response(unavailablePage('unknown'), { status: 404, headers: HTML_HEADERS });
  const [bundle, claims, recent, paths, countries, series, responses] = await Promise.all([
    loadJson(env, ctx, site + '.json'),
    loadJson(env, ctx, site + '-claims.json'),
    loadJson(env, ctx, site + '-recent.json'),
    loadJson(env, ctx, site + '-paths.json'),
    loadJson(env, ctx, site + '-countries.json'),
    loadJson(env, ctx, site + '-series.json'),
    loadJson(env, ctx, site + '-responses.json')]);
  if (!bundle) return new Response(unavailablePage(site), { status: 200, headers: HTML_HEADERS });
  const siteStatus = status && status.data && status.data.sites ? status.data.sites[site] : null;
  const agg = { paths: paths && paths.data, countries: countries && countries.data,
    series: series && series.data, responses: responses && responses.data };
  return new Response(sitePage(bundle.data, claims && claims.data, recent && recent.data, siteStatus, agg),
    { status: 200, headers: HTML_HEADERS });
};
