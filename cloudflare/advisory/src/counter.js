// Bay Area Swarm Warning — the homepage counter (added Oct 17 2026).
// Renders the counter block for the splash page from the Garden's
// published counts payload, fetched server-side at serve time (the
// front door splices the result into the page; no visitor-side
// script). Every figure comes from that one payload — nothing is
// computed here that the payload does not carry.
//
// Labelling rules (classification synthesis + the OPEN framing,
// Oct 17 2026):
//   - The prominent pair is Verified arrivals (the ledger count) and
//     Total recorded visits. The total is never labelled arrivals.
//   - The class breakdown names what each visit's software CLAIMED
//     to be. Agent-claimed carries its gloss: a claim, not proof.
//   - Claimed crawlers are visits whose user-agent announced a
//     crawler name. The name is printed as a claim, never as a
//     verification — and user-triggered fetchers are a separate line,
//     never folded into the crawler count.
//   - The as-of line prints the payload's own `updated` timestamp.
//   - The counting window travels with the totals (Caitria,
//     Oct 17 2026): the payload's counting_since becomes the sentence
//     "Counting since Oct 17, 2026 — this record is N days old"
//     (hours inside the first 48). When the payload carries no
//     counting_since, no window is claimed at all.
import { countingSentence } from '../../shared/counting.mjs';

const CLASSES = [
  ['browser', 'Browser'],
  ['agent-claimed', 'Agent-claimed'],
  ['automation', 'Automation'],
  ['unknown', 'Unknown']
];
const CLASS_GLOSS = { 'agent-claimed': 'a claim, not proof' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function asOf(iso) {
  const d = new Date(iso || Date.now());
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ', ' + hh + ':' + mm + ' UTC';
}

function classRows(c) {
  const by = c.visits_by_class || {};
  const rows = CLASSES.map(([key, label]) => ({ key, label, v: by[key] || 0 }));
  const sum = rows.reduce((a, r) => a + r.v, 0);
  const denom = c.visits_total || sum || 0;
  for (const r of rows) r.pct = denom ? (100 * r.v / denom) : 0;
  return rows;
}

function namesLine(byName, limit) {
  return Object.entries(byName || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, n]) => esc(name) + ' ' + fmt(n))
    .join(' &middot; ');
}

function agentFilesTotal(c) {
  return Object.values(c.agent_interest_files || {}).reduce((a, b) => a + (b || 0), 0);
}

// The block's inner HTML (the published page carries the wrapper and
// the no-numbers fallback; this replaces the fallback at serve time).
export function counterBlockHtml(c) {
  const rows = classRows(c);
  const segs = rows.filter(r => r.v > 0)
    .map(r => '<span class="bw-seg seg-' + r.key + '" style="flex:' + r.v + ' 1 0" aria-hidden="true"></span>')
    .join('');
  const aria = 'Recorded visits by claimed class: ' + rows.map(r => r.label + ' ' + fmt(r.v)).join('; ') + '.';
  const key = rows.map(r =>
    '<span><span class="bw-key seg-' + r.key + '"></span>' + r.label + ' &mdash; ' + fmt(r.v) + ' &middot; ' + r.pct.toFixed(1) + '%' +
    (CLASS_GLOSS[r.key] ? ' <span class="bw-count-gloss">(' + CLASS_GLOSS[r.key] + ')</span>' : '') + '</span>'
  ).join('');
  const crawlers = c.crawlers_claimed || { total: 0, by_name: {} };
  const crawlerNames = namesLine(crawlers.by_name, 4);
  const crawlerLine = crawlers.total > 0
    ? '<p class="bw-count-line"><strong>Claimed crawlers: ' + fmt(crawlers.total) + (crawlers.total === 1 ? ' visit' : ' visits') + '</strong>' +
      (crawlerNames ? ' &mdash; ' + crawlerNames + '.' : '.') +
      ' A crawler name is what the visit&rsquo;s own software announced &mdash; a claim, not a verification.</p>'
    : '<p class="bw-count-line"><strong>Claimed crawlers: none yet.</strong> No visit has announced a crawler name. When one does, it will be printed here as what it is &mdash; a claim, not a verification.</p>';
  const fetchers = c.fetchers_claimed || { total: 0, by_name: {} };
  const fetcherNames = namesLine(fetchers.by_name, 4);
  const fetcherLine = fetchers.total > 0
    ? '<p class="bw-count-line"><strong>Fetcher visits: ' + fmt(fetchers.total) + '</strong>' +
      (fetcherNames ? ' &mdash; ' + fetcherNames + '.' : '.') +
      ' A fetcher acts on a specific person&rsquo;s request, so it is counted apart from crawlers.</p>'
    : '';
  const files = agentFilesTotal(c);
  const filesLine = '<p class="bw-count-line"><strong>The agent-facing files were read ' + fmt(files) + (files === 1 ? ' time' : ' times') + '</strong>' +
    ' &mdash; robots.txt, llms.txt, the agent card, the published skills, the sitemap: the files written for agents to read.</p>';
  const win = countingSentence(c.counting_since);
  return '' +
    '<h3>The count &mdash; live from the Garden record</h3>' +
    '<div class="bw-count-pair">' +
      '<div class="bw-count-f"><span class="bw-count-n">' + fmt(c.arrivals_on_record) + '</span><span class="bw-count-l">Verified arrivals</span></div>' +
      '<div class="bw-count-f"><span class="bw-count-n">' + fmt(c.visits_total) + '</span><span class="bw-count-l">Total recorded visits</span></div>' +
    '</div>' +
    '<div class="bw-comp" role="img" aria-label="' + esc(aria) + '">' + segs + '</div>' +
    '<div class="bw-comp-key">' + key + '</div>' +
    crawlerLine + fetcherLine + filesLine +
    '<p class="bw-count-note">' + esc(c.visits_window_note || '') + (win ? ' ' + esc(win) + '.' : '') + ' As of ' + asOf(c.updated) + ' &mdash; live from the Garden record at swarmgarden.com; the record runs a minute or two behind the visits themselves. The full record: <a href="dashboard.html">the Arrival Record</a>.</p>';
}

// The Markdown-twin treatment: the same figures as plain text.
export function counterBlockText(c) {
  const rows = classRows(c);
  const breakdown = rows.map(r => r.label + ' ' + fmt(r.v) + (CLASS_GLOSS[r.key] ? ' (' + CLASS_GLOSS[r.key] + ')' : '')).join(' · ');
  const crawlers = c.crawlers_claimed || { total: 0, by_name: {} };
  const crawlerNames = Object.entries(crawlers.by_name || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([name, n]) => name + ' ' + fmt(n)).join(' · ');
  const fetchers = c.fetchers_claimed || { total: 0, by_name: {} };
  const fetcherNames = Object.entries(fetchers.by_name || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([name, n]) => name + ' ' + fmt(n)).join(' · ');
  const lines = [
    '## The count',
    '',
    'Live from the Garden record, as of ' + asOf(c.updated) + ' (the record runs a minute or two behind the visits themselves):',
    '',
    '- Verified arrivals: ' + fmt(c.arrivals_on_record),
    '- Total recorded visits: ' + fmt(c.visits_total) + ' — ' + breakdown,
  ];
  const winText = countingSentence(c.counting_since);
  if (winText) lines.push('- ' + winText + '.');
  lines.push(
    crawlers.total > 0
      ? '- Claimed crawlers: ' + fmt(crawlers.total) + (crawlerNames ? ' — ' + crawlerNames : '') + '. A crawler name is what the visit\u2019s software announced; a claim, not a verification.'
      : '- Claimed crawlers: none yet. A crawler name, when one appears, is what the visit\u2019s software announced; a claim, not a verification.'
  );
  if (fetchers.total > 0) {
    lines.push('- Fetcher visits: ' + fmt(fetchers.total) + (fetcherNames ? ' — ' + fetcherNames : '') + '. A fetcher acts on a specific person\u2019s request, so it is counted apart from crawlers.');
  }
  lines.push('- The agent-facing files (robots.txt, llms.txt, the agent card, the published skills, the sitemap) were read ' + fmt(agentFilesTotal(c)) + ' times.');
  lines.push('');
  lines.push((c.visits_window_note || '') + ' The full record: https://swarmgarden.com/record.html');
  return lines.join('\n');
}

// What the twin shows when the counts fetch fails: no numbers, ever —
// a pointer at the record instead.
export const COUNTER_TEXT_FALLBACK = [
  '## The count',
  '',
  'The live figures are published on the Garden\u2019s record: https://swarmgarden.com/record.html'
].join('\n');
