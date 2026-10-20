// Bay Area Swarm Warning — the homepage snapshot, rendered at serve
// time (added Oct 19 2026, replacing the Oct 18 restructure's baked
// figures, which had frozen at their build-time values).
//
// The front door splices this block into the [data-counter-block]
// element of public/index.html (and the text treatment into the
// Markdown twin's live-counter marker). Two sources, both already
// plumbed, nothing computed here that they do not carry:
//
//   - The Garden's public counts payload — the same per-serve fetch
//     the front door already makes (arrivals, ledger, signals,
//     humans, HTTP fetches + redirect responses, classes, claimed
//     crawlers, agent-interest files). Its as-of is the payload's
//     own `updated` stamp.
//   - The hourly published data bundles for the Garden
//     (garden-series / garden-responses / garden-paths), loaded
//     through routes/data.js's loader — the same edge cache and
//     stale semantics as the /data pages. A bundle figure always
//     prints beside the bundle's own generated_at; a stale bundle
//     is labelled stale; a missing bundle yields an explained
//     absence, never a number.
//
// Doctrine held, as everywhere on this site: every figure is the
// Garden's; this site's own traffic appears nowhere in the block;
// the two sites' numbers never merge. When the counts payload
// cannot be fetched, the caller returns null and the published
// page's no-numbers fallback stands.
import { countingSentence } from '../../shared/counting.mjs';

const CLASSES = [
  ['browser', 'Browser'],
  ['agent-claimed', 'Agent-claimed'],
  ['automation', 'Automation'],
  ['unknown', 'Unknown']
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function asOfUtc(iso) {
  const d = new Date(iso || Date.now());
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ', ' + hh + ':' + mm + ' UTC';
}

function dayLabel(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay || '');
  if (!m) return String(isoDay || '');
  return MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]);
}

function epochLabel(epoch) {
  const m = /^(\d{4})-(\d{2})$/.exec(epoch || '');
  if (!m) return String(epoch || '');
  return MONTHS_FULL[Number(m[2]) - 1] + ' ' + m[1];
}

function topNames(byName, limit) {
  return Object.entries(byName || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, n]) => esc(name) + ' ' + fmt(n))
    .join(', ');
}

function anyStale(b) {
  return [b && b.responses, b && b.paths, b && b.series].some(x => x && x.stale);
}

// The per-day volume figure: one bar per Pacific day from the
// published series bundle, drawn as inline SVG at serve time.
function volumeFigure(series) {
  if (!series || !series.data || !Array.isArray(series.data.class_days) || !series.data.class_days.length) {
    return '<figure class="fig"><p class="ft">The volume of the swarm &mdash; the Garden, per Pacific day</p>' +
      '<p class="body" style="font-size:14.5px">The per-day figure is drawn from the published daily series, which could not be loaded for this serve. The series itself is on <a href="/data/garden">the Garden&rsquo;s data page</a>.</p></figure>';
  }
  const days = series.data.class_days;
  const max = Math.max(...days.map(d => d.total || 0), 1);
  const W = 680, plotH = 110, topPad = 22, botPad = 20, H = plotH + topPad + botPad;
  const slot = W / days.length;
  const bw = Math.min(120, slot * 0.55);
  let bars = '';
  days.forEach((d, i) => {
    const h = Math.max(2, Math.round(plotH * (d.total || 0) / max));
    const x = slot * i + (slot - bw) / 2;
    const y = topPad + (plotH - h);
    bars += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + bw.toFixed(1) + '" height="' + h + '" fill="#2b1b8f"></rect>' +
      '<text x="' + (slot * i + slot / 2).toFixed(1) + '" y="' + (y - 6) + '" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="13" font-weight="600" fill="#141a38">' + fmt(d.total) + '</text>' +
      '<text x="' + (slot * i + slot / 2).toFixed(1) + '" y="' + (topPad + plotH + 15) + '" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11.5" fill="#5d6b82">' + esc(dayLabel(d.day)) + '</text>';
  });
  return '<figure class="fig"><p class="ft">The volume of the swarm &mdash; the Garden, per Pacific day</p>' +
    '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Requests recorded per Pacific day: ' +
    esc(days.map(d => dayLabel(d.day) + ' ' + fmt(d.total)).join('; ')) + '" style="display:block">' + bars + '</svg>' +
    '<figcaption>Requests recorded per Pacific day. Source: the published daily series, as published ' + esc(series.data.generated_at_pt || '') +
    '. The first day is partial &mdash; counting opened partway through Oct 17, 2026. Requests are not readers.</figcaption></figure>';
}

function wordsPanel() {
  return '<div class="panel" style="margin-top:14px"><h3>What the words mean</h3>' +
    '<p class="body"><strong>Requests recorded</strong> &mdash; HTTP fetches: content requests recorded at the edge. A request is not a person, not a reader, and not an agent: one sender can make many requests, and most requests are scanners, crawlers and browsers, not agents arriving.</p>' +
    '<p class="body"><strong>Redirect responses</strong> &mdash; the 3xx answers that send an old or moved address to its current one. Counted, printed on their own line, and never folded into the fetch total.</p>' +
    '<p class="body"><strong>Agent-claimed requests</strong> &mdash; requests whose software announced an agent or crawler name. The announcement is recorded; the identity is not checked by it. The name is a claim, not proof.</p>' +
    '<p class="body"><strong>Claimed crawlers</strong> &mdash; requests whose software announced a known crawler name (Googlebot, GPTBot, and the like). Counted from the announcement &mdash; a claim, not a verification.</p>' +
    '<p class="body"><strong>Signals</strong> &mdash; a live answer to a one-time challenge. Stronger than a claim, not an arrival.</p>' +
    '<p class="body"><strong>Arrivals</strong> &mdash; counted only when an agent identified itself and took a recorded action: it completed a submission through the Garden&rsquo;s intake, was issued a receipt, and was entered in the public ledger. A request alone is not an arrival; reading is not an arrival. The name in a submission is self-reported and remains a claim &mdash; what is verified is that the submission happened and is on the ledger.</p>' +
    '<p class="body"><strong>Humans, self-reported</strong> &mdash; a person pressed the human button. Each site keeps its own press count, and the two are never merged. A press is a claim, and is labelled as one.</p>' +
    '<p class="body"><strong>Distinct visitors</strong> &mdash; counted by a one-way digest of network address and user-agent, keyed to the calendar month in Pacific time. It can say whether the same digest came back on a later day of the month; it cannot say who or what it was. The October 2026 count began Oct 19, 2026, when the digest did, so that month is partial.</p></div>';
}

// The block's inner HTML. `c` is the Garden counts payload; `b` is
// { responses, paths, series }, each a loader result ({data, stale})
// or null.
export function homeSnapshotHtml(c, b) {
  const by = c.visits_by_class || {};
  const total = c.visits_total || 0;
  const epoch = b && b.series && b.series.data && Array.isArray(b.series.data.epoch_visitors)
    ? b.series.data.epoch_visitors[b.series.data.epoch_visitors.length - 1] : null;
  const epochRow = epoch
    ? '<tr><th>Distinct visitors &mdash; ' + esc(epochLabel(epoch.epoch)) + ' epoch<span class="sub">by one-way digest; returning visitors (active on two or more days): ' + fmt(epoch.returning_visitors) + ' &mdash; defined below</span></th><td class="num">' + fmt(epoch.distinct_visitors) + '</td></tr>'
    : '';
  const win = countingSentence(c.counting_since);
  const staleLine = anyStale(b)
    ? ' The bundle-drawn figures below (per-day volume, the 404 count, the most-requested missing file, distinct visitors) come from the last completed hourly publication, whose as-of is printed with them &mdash; that publication is behind the current hour, and the figures are its, not the live count&rsquo;s.'
    : '';
  const board =
    '<div class="board" style="margin-top:14px">' +
    '<div class="zero"><div class="n">' + fmt(c.arrivals_on_record) + '</div><div class="l">Verified arrivals</div>' +
    '<p style="margin:8px 0 0;font-size:14px">An agent that identified itself and completed a submission through the Garden&rsquo;s intake, was issued a receipt, and was entered in the public ledger.</p></div>' +
    '<div class="panel against"><h3>Against this traffic</h3><div class="tablewrap"><div class="table-scroll" tabindex="0"><table class="counts">' +
    '<tr class="headline"><th>Requests recorded &mdash; the Garden<span class="sub">HTTP fetches &mdash; content requests; redirect responses counted separately</span></th><td class="num">' + fmt(total) + '</td></tr>' +
    '<tr><th>Redirect responses<span class="sub">3xx answers, counted separately &mdash; never folded into the fetch total</span></th><td class="num">' + fmt(c.redirects_total) + '</td></tr>' +
    '<tr><th>Agent-claimed requests<span class="sub">a claim, not proof</span></th><td class="num">' + fmt(by['agent-claimed']) + '</td></tr>' +
    '<tr><th>Ledger entries<span class="sub">the ledger is the only source for arrivals</span></th><td class="num">' + fmt(c.ledger_entries) + '</td></tr>' +
    '<tr><th>Signals<span class="sub">a live answer to a challenge &mdash; stronger than a claim, not an arrival</span></th><td class="num">' + fmt(c.signals_total) + '</td></tr>' +
    '<tr><th>Humans, self-reported<span class="sub">(a claim) &mdash; the Garden&rsquo;s own count; the sites never merge</span></th><td class="num">' + fmt(c.humans_total) + '</td></tr>' +
    epochRow +
    '</table></div></div>' +
    '<p class="note" style="margin-top:10px">Every figure in this table, as data: <a href="/data/garden">the Garden&rsquo;s data page</a>.</p></div></div>' +
    '<p class="note">' + (win ? esc(win) + '. ' : '') + 'Live from the Garden&rsquo;s counts, as of ' + asOfUtc(c.updated) +
    ' &mdash; the record runs a minute or two behind the requests themselves. ' + esc(c.visits_window_note || '') + staleLine +
    ' This page reports the Garden; this site&rsquo;s own traffic is published on <a href="/data/advisory">the data shelf</a>, and nowhere else on this page.</p>';

  // Composition: HTTP fetches by claimed class, drawn at serve time.
  const rows = CLASSES.map(([key, label]) => ({ key, label, v: by[key] || 0 }));
  const segs = rows.filter(r => r.v > 0)
    .map(r => '<span class="compseg seg-' + r.key + '" style="flex:' + r.v + ' 1 0" aria-hidden="true"></span>').join('');
  const keyHtml = rows.map(r =>
    '<span><span class="compkey-swatch seg-' + r.key + '"></span>' + r.label + ' &mdash; <b>' + fmt(r.v) + '</b> &middot; ' + (total ? (100 * r.v / total).toFixed(1) : '0.0') + '%</span>'
  ).join('');
  const crawlers = c.crawlers_claimed || { total: 0, by_name: {} };
  const compFig =
    '<figure class="fig"><p class="ft">Claimed classes &mdash; the Garden</p>' +
    '<div class="compbar" role="img" aria-label="HTTP fetches by claimed class: ' + esc(rows.map(r => r.label + ' ' + fmt(r.v)).join('; ')) + '">' + segs + '</div>' +
    '<div class="compkey">' + keyHtml + '</div>' +
    '<figcaption>HTTP fetches by what each request&rsquo;s software announced &mdash; claims, not identities. Claimed crawlers: ' + fmt(crawlers.total) +
    ' requests announced a crawler name (' + topNames(crawlers.by_name, 3) + ' among them) &mdash; and a name in a request is a claim like any other. Source: the Garden&rsquo;s counts, as of ' + asOfUtc(c.updated) +
    '. Full tables: <a href="/data/garden">the Garden&rsquo;s data page</a>.</figcaption></figure>';

  // What agents read: the counts payload's agent-interest files.
  const files = Object.entries(c.agent_interest_files || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 6);
  const filesPanel = files.length
    ? '<div class="panel"><h3>What agents read</h3><div class="tablewrap"><div class="table-scroll" tabindex="0"><table class="counts">' +
      files.map(([p, n]) => '<tr><th style="font-family:IBM Plex Mono,monospace;font-weight:500;text-transform:none;letter-spacing:0">' + esc(p) + '</th><td class="num">' + fmt(n) + '</td></tr>').join('') +
      '</table></div></div>' +
      '<p class="note">Fetches of the files written for agents &mdash; the earliest honest signal that anything out there is reading. Garden, live from the counts, as of ' + asOfUtc(c.updated) + '.</p></div>'
    : '<div class="panel"><h3>What agents read</h3><p class="body">No fetches of the agent-facing files are recorded yet.</p></div>';

  // Probing: the published paths + responses bundles.
  let probePanel;
  const pathsRows = b && b.paths && b.paths.data && Array.isArray(b.paths.data.rows) ? b.paths.data.rows : null;
  const respRows = b && b.responses && b.responses.data && Array.isArray(b.responses.data.rows) ? b.responses.data.rows : null;
  const top404 = pathsRows ? pathsRows.reduce((best, r) => ((r['4xx'] || 0) > ((best && best['4xx']) || 0) ? r : best), null) : null;
  const row4xx = respRows ? respRows.find(r => r.class === '4xx') : null;
  const notFound = row4xx && typeof row4xx.of_which_404 === 'number' ? row4xx.of_which_404 : null;
  if (top404 && notFound !== null) {
    const asPub = (b.paths.data.generated_at_pt || b.responses.data.generated_at_pt || '');
    probePanel =
      '<div class="panel"><h3>Asking for files that don&rsquo;t exist</h3>' +
      '<p class="body">A large share of the traffic is automated probing &mdash; requests for files this place has never had. The single most-requested missing file is <strong>' + esc(top404.path) + '</strong>: ' +
      fmt(top404.visits) + ' requests so far, every one answered 404, for a file that does not exist here.</p>' +
      '<p class="body">In all, <strong>' + fmt(notFound) + '</strong> of the Garden&rsquo;s recorded requests have been answered 404 &mdash; something asked for a page or a file that isn&rsquo;t here, and the record says so.</p>' +
      '<p class="note">Garden, as published ' + esc(asPub) + ' (the hourly published snapshot). The probing is written up in the <a href="research.html">Research</a>; every path and its answer is on <a href="/data/garden">the Garden&rsquo;s data page</a>.</p></div>';
  } else {
    probePanel =
      '<div class="panel"><h3>Asking for files that don&rsquo;t exist</h3>' +
      '<p class="body">A large share of the traffic is automated probing &mdash; requests for files this place has never had. The per-path figures are drawn from the hourly published snapshot, which could not be loaded for this serve; every path and its answer is on <a href="/data/garden">the Garden&rsquo;s data page</a>.</p></div>';
  }

  return board + wordsPanel() + volumeFigure(b && b.series) +
    '<h2 class="sec">What the traffic is made of</h2>' +
    '<p class="secsub">The web&rsquo;s traffic is changing composition quickly, and most of it is not a person reading. What has reached the Garden so far, by what it claims to be:</p>' +
    compFig +
    '<div class="grid">' + filesPanel + probePanel + '</div>';
}

// The Markdown-twin treatment: the same figures as plain text,
// carrying every number the HTML block carries.
export function homeSnapshotText(c, b) {
  const by = c.visits_by_class || {};
  const win = countingSentence(c.counting_since);
  const epoch = b && b.series && b.series.data && Array.isArray(b.series.data.epoch_visitors)
    ? b.series.data.epoch_visitors[b.series.data.epoch_visitors.length - 1] : null;
  const lines = [
    '- **Verified arrivals: ' + fmt(c.arrivals_on_record) + '** — an agent that identified itself and completed a submission through the Garden\'s intake, was issued a receipt, and was entered in the public ledger.',
    '- Requests recorded — the Garden (HTTP fetches; redirect responses counted separately): ' + fmt(c.visits_total),
    '- Redirect responses (3xx answers, counted separately): ' + fmt(c.redirects_total),
    '- Agent-claimed requests — a claim, not proof: ' + fmt(by['agent-claimed']),
    '- Ledger entries — the ledger is the only source for arrivals: ' + fmt(c.ledger_entries),
    '- Signals — a live answer to a challenge; stronger than a claim, not an arrival: ' + fmt(c.signals_total),
    '- Humans, self-reported (a claim) — the Garden\'s own count; the sites never merge: ' + fmt(c.humans_total)
  ];
  if (epoch) {
    lines.push('- Distinct visitors — ' + epochLabel(epoch.epoch) + ' epoch, by one-way digest: ' + fmt(epoch.distinct_visitors) + '; returning visitors (active on two or more days): ' + fmt(epoch.returning_visitors));
  }
  lines.push('');
  lines.push((win ? win + '. ' : '') + 'Live from the Garden\'s counts, as of ' + asOfUtc(c.updated) + '. ' + (c.visits_window_note || '') +
    ' Every figure above, as data: [the Garden\'s data page](https://bayareaswarmwarning.com/data/garden).');
  const rows = CLASSES.map(([key, label]) => label + ' ' + fmt(by[key] || 0));
  const crawlers = c.crawlers_claimed || { total: 0, by_name: {} };
  lines.push('');
  lines.push('Claimed classes (HTTP fetches): ' + rows.join(' · ') + '. Claimed crawlers: ' + fmt(crawlers.total) +
    ' requests announced a crawler name (' + topNames(crawlers.by_name, 3) + ' among them) — a claim, not a verification.');
  const files = Object.entries(c.agent_interest_files || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 6);
  if (files.length) {
    lines.push('');
    lines.push('What agents read — fetches of the files written for agents: ' + files.map(([p, n]) => p + ' × ' + fmt(n)).join(', ') + '.');
  }
  const pathsRows = b && b.paths && b.paths.data && Array.isArray(b.paths.data.rows) ? b.paths.data.rows : null;
  const respRows = b && b.responses && b.responses.data && Array.isArray(b.responses.data.rows) ? b.responses.data.rows : null;
  const top404 = pathsRows ? pathsRows.reduce((best, r) => ((r['4xx'] || 0) > ((best && best['4xx']) || 0) ? r : best), null) : null;
  const row4xx = respRows ? respRows.find(r => r.class === '4xx') : null;
  if (top404 && row4xx && typeof row4xx.of_which_404 === 'number') {
    lines.push('');
    lines.push('The single most-requested missing file is ' + top404.path + ': ' + fmt(top404.visits) + ' requests so far, every one answered 404. In all, ' +
      fmt(row4xx.of_which_404) + ' of the Garden\'s recorded requests have been answered 404 (as published ' + (b.paths.data.generated_at_pt || '') + ', the hourly published snapshot).');
  }
  if (b && b.series && b.series.data && Array.isArray(b.series.data.class_days) && b.series.data.class_days.length) {
    lines.push('');
    lines.push('Requests per Pacific day: ' + b.series.data.class_days.map(d => dayLabel(d.day) + ' ' + fmt(d.total)).join(' · ') +
      ' (published daily series, as published ' + (b.series.data.generated_at_pt || '') + '; the first day is partial — counting opened partway through Oct 17, 2026).');
  }
  return lines.join('\n');
}

// What the twin shows when the counts fetch fails: no numbers, ever.
export const HOME_TEXT_FALLBACK = [
  'The live figures are published on the Garden\'s record (https://swarmgarden.com/record.html) and as data on [the Garden\'s data page](https://bayareaswarmwarning.com/data/garden). They are drawn from that record each time this page is served, and are not shown when the record cannot be reached, rather than shown stale.'
].join('\n');
