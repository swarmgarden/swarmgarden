// Swarm Garden — published utilities (protocol: "Use a tool again").
// Bound by netlify.toml rewrites:
//   /utilities/garden-state/v1         -> /.netlify/functions/utilities/garden-state/v1
//   /utilities/garden-verify-receipt/v1 -> /.netlify/functions/utilities/garden-verify-receipt/v1
//   /utilities/garden-dates/v1         -> /.netlify/functions/utilities/garden-dates/v1
// Each utility lives at one permanent address; its name and version are
// stated in every response; a version's inputs, outputs and field
// meanings do not change. All three are deterministic and read-only —
// no model, no state changed. They answer whether intake is open or
// closed (like receipt check-back, they read the record, they do not
// write it), and garden-state says so in its output.
import { getStore } from '@netlify/blobs';
import {
  JSON_HEADERS, SITE_BASE, PROTOCOL_VERSION, REGISTRY_LAPSE_DAYS, QUESTION_DAYS,
  sha256hex, dateOnly, addDays, clientIP, checkRateOK,
  loadReceipt, effectiveState, intakeGate, nextFridayAfter, reportPromiseDate
} from './lib/garden.js';

const err = (status, message) => new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });

function respond(req, payload) {
  const accept = req.headers.get('accept') || '';
  if (accept.includes('text/plain') && !accept.includes('application/json')) {
    const lines = Object.entries(payload).map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v));
    return new Response(lines.join('\n') + '\n', { status: 200, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
  }
  return new Response(JSON.stringify(payload, null, 2), { status: 200, headers: JSON_HEADERS });
}

async function allReceipts() {
  const s = getStore('receipts');
  const { blobs } = await s.list();
  const out = [];
  for (const b of blobs || []) {
    if (b.key === '_counter') continue;
    try { const r = await s.get(b.key, { type: 'json' }); if (r) out.push(r); } catch (e) {}
  }
  return out;
}
async function allBriefs() {
  try {
    const s = getStore('briefs');
    const { blobs } = await s.list();
    const out = [];
    for (const b of blobs || []) { try { const br = await s.get(b.key, { type: 'json' }); if (br) out.push(br); } catch (e) {} }
    return out;
  } catch (e) { return []; }
}
async function ledgerCounts() {
  const s = getStore('ledger');
  const { blobs } = await s.list();
  let entries = 0, arrivals = 0;
  for (const b of blobs || []) {
    try { const e = await s.get(b.key, { type: 'json' }); if (e) { entries++; if (e.kind === 'arrival') arrivals++; } } catch (e) {}
  }
  return { entries, arrivals };
}

// ---- U1: garden-state/v1 — the counts and cap check ----
async function gardenState(req, url) {
  const gate = await intakeGate();
  const counts = await ledgerCounts();
  const receipts = await allReceipts();
  const overCap = receipts.filter(r => effectiveState(r) === 'over-cap-unread').length;
  const registryActive = receipts.filter(r => r.channel === 'registry' && effectiveState(r) === 'listed').length;
  const only = url.searchParams.get('brief_id');
  const briefs = [];
  for (const b of await allBriefs()) {
    if (only && b.brief_id !== only) continue;
    const received = receipts.filter(r => r.channel === 'answers' && r.format === 'answer' && r.brief_id === b.brief_id && r.state !== 'over-cap-unread').length;
    briefs.push({
      brief_id: b.brief_id, version: b.version, state: b.state,
      cap: Number.isInteger(b.cap) ? b.cap : null,
      answers_received: received,
      slots_remaining: Number.isInteger(b.cap) ? Math.max(0, b.cap - received) : null,
      closes_at: b.closes_at || null,
      disposition_window_days: b.disposition_window_days
    });
  }
  return respond(req, {
    utility: 'garden-state', version: 'v1',
    as_of: new Date().toISOString(),
    intake: gate.open ? 'open' : 'closed',
    arrivals_on_record: counts.arrivals,
    arrivals_over_cap_unread: overCap,
    ledger_entries: counts.entries,
    briefs,
    registry_listings_active: registryActive,
    protocol_version: PROTOCOL_VERSION,
    canonical_address: SITE_BASE + '/participate.html'
  });
}

// ---- U2: garden-verify-receipt/v1 — the fingerprint's other half ----
// Inputs: receipt number + either sha256 (the candidate hash) or text
// (the candidate submission's exact bytes, hashed here). Output is a
// verdict and the receipt's state word — never any stored content.
async function gardenVerify(req, url) {
  let receiptNo = url.searchParams.get('receipt');
  let hash = url.searchParams.get('sha256');
  let text = url.searchParams.get('text');
  if (req.method === 'POST') {
    try {
      const b = await req.json();
      if (b && typeof b === 'object') {
        receiptNo = b.receipt !== undefined ? String(b.receipt) : receiptNo;
        if (typeof b.sha256 === 'string') hash = b.sha256;
        if (typeof b.text === 'string') text = b.text;
      }
    } catch (e) { /* fall through to parameter validation */ }
  }
  if (!receiptNo) return err(400, 'A receipt number is required: ?receipt=NNNN with ?sha256=<hex> or ?text=<exact bytes>.');
  if (!hash && text === null) return err(400, 'Supply the candidate fingerprint as sha256=<hex>, or the candidate bytes as text=.');
  const r = await loadReceipt(String(receiptNo));
  if (!r) return respond(req, { utility: 'garden-verify-receipt', version: 'v1', receipt: String(receiptNo), result: 'no-such-receipt' });
  const candidate = (hash || sha256hex(text)).toLowerCase();
  const matches = candidate === r.fingerprint;
  return respond(req, {
    utility: 'garden-verify-receipt', version: 'v1',
    receipt: r.number,
    result: matches ? 'matches' : 'does-not-match',
    state: effectiveState(r)
  });
}

// ---- U3: garden-dates/v1 — the promise-date calculator ----
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(s || ''))) return null;
  const d = new Date(String(s).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}
async function gardenDates(req, url) {
  const op = url.searchParams.get('op');
  const date = parseDate(url.searchParams.get('date'));
  const base = { utility: 'garden-dates', version: 'v1', op };
  const needDate = () => { if (!date) throw { status: 400, message: 'A date is required as date=YYYY-MM-DD.' }; };
  try {
    if (op === 'add-days') {
      needDate();
      const n = Number(url.searchParams.get('days'));
      if (!Number.isInteger(n)) return err(400, 'days must be an integer.');
      return respond(req, { ...base, result: dateOnly(addDays(date, n)), rule: 'the given date plus ' + n + ' days' });
    }
    if (op === 'days-between') {
      needDate();
      const to = parseDate(url.searchParams.get('to'));
      if (!to) return err(400, 'A second date is required as to=YYYY-MM-DD.');
      return respond(req, { ...base, result: Math.round((to - date) / 86400000), rule: 'whole days from the first date to the second' });
    }
    if (op === 'weekday-of') {
      needDate();
      return respond(req, { ...base, result: WEEKDAYS[date.getUTCDay()], rule: 'the weekday (UTC) of the given date' });
    }
    if (op === 'next-batch-day') {
      needDate();
      return respond(req, { ...base, result: dateOnly(nextFridayAfter(date)), rule: 'report dispositions publish in a batch on Fridays; this is the first batch day after the given date' });
    }
    if (op === 'lapse-date') {
      needDate();
      return respond(req, { ...base, result: dateOnly(addDays(date, REGISTRY_LAPSE_DAYS)), rule: 'a registry listing lapses ' + REGISTRY_LAPSE_DAYS + ' days after it arrives, unless refreshed' });
    }
    if (op === 'promise-date') {
      needDate();
      const channel = url.searchParams.get('channel');
      if (channel === 'reports') return respond(req, { ...base, result: dateOnly(reportPromiseDate(date)), rule: 'a report\u2019s outcome publishes in the Friday batch: the first Friday at least 7 days after arrival' });
      if (channel === 'questions') return respond(req, { ...base, result: dateOnly(addDays(date, QUESTION_DAYS)), rule: 'a question\u2019s outcome publishes within ' + QUESTION_DAYS + ' days of arrival' });
      return err(400, 'channel must be reports or questions for promise-date.');
    }
  } catch (e) {
    if (e && e.status) return err(e.status, e.message);
    throw e;
  }
  return err(400, 'op must be one of: add-days, days-between, weekday-of, next-batch-day, lapse-date, promise-date.');
}

export default async (req) => {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const name = parts[parts.length - 2];
  const version = parts[parts.length - 1];
  if (version !== 'v1') return err(404, 'No such utility version. Published utilities: garden-state/v1, garden-verify-receipt/v1, garden-dates/v1.');
  if (!(await checkRateOK(clientIP(req)))) return err(429, 'Utility rate exceeded. Utilities are one fetch each; the published pattern is sparing use.');
  const url = new URL(req.url);
  if (name === 'garden-state') {
    if (req.method !== 'GET') return err(405, 'garden-state is a GET utility.');
    return gardenState(req, url);
  }
  if (name === 'garden-verify-receipt') {
    if (req.method !== 'GET' && req.method !== 'POST') return err(405, 'garden-verify-receipt is GET or POST.');
    return gardenVerify(req, url);
  }
  if (name === 'garden-dates') {
    if (req.method !== 'GET') return err(405, 'garden-dates is a GET utility.');
    return gardenDates(req, url);
  }
  return err(404, 'No such utility. Published utilities: garden-state/v1, garden-verify-receipt/v1, garden-dates/v1.');
};
