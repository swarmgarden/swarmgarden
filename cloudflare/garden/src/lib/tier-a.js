// Swarm Garden — Tier A: instant, mechanical answers (Cloudflare port;
// logic unchanged from the Netlify build — see the original header:
// design §1, ruling D3 shape A1, D4: the answerable set is a closed,
// PUBLISHED list; a Tier A answer is a pure function of the Garden's own
// record, deterministic, no model; it attaches to the receipt as a
// PROVISIONAL answer and the state word stays 'received' until a
// steward confirms. Anything that does not match a listed shape falls
// through untouched.)
//
// THE PUBLISHED LIST (printed on the questions page; keep in sync):
//   1. The current protocol version and canonical address.
//   2. The counts on record: arrivals, ledger entries.
//   3. A named brief: whether it is open, its cap, answers received,
//      slots remaining, close date.
//   4. The state of a named receipt, by number.
//   5. When a named registry listing lapses, by receipt number.
// For reports, one mechanical check: whether the Garden address named
// in the report is a page the Garden publishes (checked against the
// published page list below — our own pages only, never a fetched URL).
import { SITE_BASE, PROTOCOL_VERSION, loadReceipt, effectiveState } from './garden.js';
import { dbLedgerCounts, dbListBriefs, dbCountBriefReadAnswers } from './db.js';

export const TIER_A_LIST_VERSION = '2026-10-17';

// The Garden's published addresses, for the reports mechanical check.
export const PUBLISHED_PATHS = new Set([
  '/', '/index.html', '/participate.html', '/briefs.html', '/questions.html',
  '/reports.html', '/registry.html', '/record.html', '/changed',
  '/robots.txt', '/sitemap.xml', '/llms.txt', '/security.txt',
  '/.well-known/security.txt', '/.well-known/agent-card.json',
  '/.well-known/agent-skills/index.json',
  '/.well-known/agent-skills/swarm-garden/SKILL.md',
  '/.well-known/agent-skills/attend-the-garden/SKILL.md',
  '/.well-known/agent-skills/answer-a-brief/SKILL.md',
  '/.well-known/agent-skills/keep-a-return-file/SKILL.md',
  '/.well-known/agent-skills/file-a-good-report/SKILL.md',
  '/.well-known/agent-skills/ask-the-garden/SKILL.md',
  '/utilities/garden-state/v1', '/utilities/garden-verify-receipt/v1', '/utilities/garden-dates/v1'
]);

const basis = (at) => 'per the Garden\u2019s record at ' + at;

// Question matcher: returns { text, basis } or null.
export async function tierAQuestion(env, questionText, at) {
  const q = String(questionText || '');
  const ql = q.toLowerCase();
  const num = (q.match(/\b(\d{6,})\b/) || [])[1];

  // 4/5. A named receipt: its state, or a registry listing's lapse.
  if (num && /(receipt|listing|submission)/.test(ql)) {
    const r = await loadReceipt(env, num);
    if (!r) return { text: 'There is no receipt ' + num + ' in the record.', basis: basis(at) };
    if (/(lapse|expire|expiry)/.test(ql)) {
      if (r.channel === 'registry' && r.lapses_on) return { text: 'Listing ' + num + ' lapses on ' + r.lapses_on + '.', basis: basis(at) };
      return { text: 'Receipt ' + num + ' is not a registry listing; it carries no lapse date.', basis: basis(at) };
    }
    if (/(state|status|outcome|disposition)/.test(ql)) {
      let text = 'Receipt ' + num + ' (' + r.what + ') is in state: ' + effectiveState(r) + '.';
      if (r.outcome_published_by) text += ' Outcome published by ' + r.outcome_published_by + '.';
      if (r.lapses_on) text += ' Listing lapses on ' + r.lapses_on + '.';
      return { text, basis: basis(at) };
    }
  }

  // 3. A named brief, by its published identifier appearing in the text.
  const briefs = await dbListBriefs(env.DB);
  const named = briefs.find(b => q.includes(b.brief_id));
  if (named && /(brief|open|closed|cap|slot|remain|answer)/.test(ql)) {
    const received = await dbCountBriefReadAnswers(env.DB, named.brief_id);
    const cap = Number.isInteger(named.cap) ? named.cap : null;
    const slots = cap === null ? null : Math.max(0, cap - received);
    let text = 'Brief ' + named.brief_id + ' (version ' + named.version + ') is ' + named.state + '.';
    if (cap !== null) text += ' Cap: ' + cap + ' answers; received: ' + received + '; slots remaining: ' + slots + '.';
    text += named.closes_at ? ' It closes on ' + named.closes_at + '.' : ' It has no close date set.';
    return { text, basis: basis(at) };
  }

  // 2. The counts on record.
  if (/(how many|number of|count)/.test(ql) && /(arrival|ledger|submission|receipt|on record)/.test(ql)) {
    const c = await dbLedgerCounts(env.DB);
    return { text: 'Arrivals on record: ' + c.arrivals + '. Ledger entries: ' + c.entries + '.', basis: basis(at) };
  }

  // 1. Protocol version and canonical address.
  if (/(protocol version|version of the protocol|current protocol|canonical address)/.test(ql)) {
    return { text: 'The current protocol is ' + PROTOCOL_VERSION + ', published at ' + SITE_BASE + '/participate.html.', basis: basis(at) };
  }
  return null;
}

// Reports mechanical check: is the named Garden address one the Garden
// publishes? Returns { text, basis } or null (e.g. "in the wild").
export function tierAReportCheck(where, at) {
  const w = String(where || '').trim();
  let path = null;
  const m = w.match(/swarmgarden\.com(\/[^\s]*)?/i);
  if (m) path = (m[1] || '/').split(/[?#]/)[0];
  else if (w.startsWith('/')) path = w.split(/[?#]/)[0];
  if (!path) return null;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const known = PUBLISHED_PATHS.has(path);
  return {
    text: 'Mechanical check: ' + path + (known
      ? ' is a page the Garden publishes (checked against the published page list).'
      : ' is not a page the Garden publishes (checked against the published page list).') +
      ' This is an automatic note, not the disposition; the binding disposition appears in the Friday batch.',
    basis: basis(at)
  };
}

export function makeProvisional(kind, hit, at) {
  return { kind, text: hit.text, basis: hit.basis, at, status: 'provisional' };
}
