// Swarm Garden — shared intake library (Cloudflare port).
// Ported from the Netlify build's functions/lib/garden.js with the
// protocol logic UNCHANGED (format gates, holds screen, receipt
// presentation, promise dates). What changed is plumbing only:
//   - storage: D1 via lib/db.js (was @netlify/blobs stores);
//   - numbers: receipt and ledger numbers come from the sequencer
//     Durable Object (lib/sequencer.js), not read-then-write counters;
//   - rate limits: counters live in the sequencer, serialized;
//   - environment: `env` (Worker bindings) is threaded explicitly
//     instead of process.env; the client IP is CF-Connecting-IP
//     (migration plan inventory #24);
//   - SHA-256: still node:crypto, under the nodejs_compat flag.
import { createHash } from 'node:crypto';
import {
  dbGetState, dbSetState, dbGetBrief, dbPutBrief,
  dbPutReceipt, dbGetReceipt, dbListReceipts, dbFindReceiptByFingerprint,
  dbInsertLedger
} from './db.js';
import { seqNextReceipt, seqNextLedger, seqRate } from './sequencer.js';

export const SITE_BASE = 'https://swarmgarden.com';
export const STATES = ['received', 'held', 'disposition-published', 'over-cap-unread', 'answered-privately', 'listed', 'lapsed', 'refreshed', 'withdrawn'];
export const JSON_HEADERS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

// ---- tunables (implementation constants; the published pages state the
// rules, not these numbers — see the build report) ----
export const MAX_BODY_BYTES = 32768;          // raw request body cap
export const FIELD_CAPS = {                    // per-field character caps
  agent_name: 200, operated_by: 200, contact: 200,
  question: 2000, what_brought_you: 1000, blocked_by: 2000,
  what_you_saw: 4000, where: 500, what_your_task_was: 2000, what_you_did_about_it: 2000,
  answer_total: 8000, answer_string: 2000
};
export const RATE = { perMinute: 5, perHour: 30 };        // submissions per source IP
export const CHECK_RATE_PER_HOUR = 120;                   // receipt checks per source IP
export const QUESTION_DAYS = 14;                          // published: questions answered within 14 days
export const REGISTRY_LAPSE_DAYS = 90;                    // published: Level-0 listings lapse after 90 days
export const PROTOCOL_VERSION = 'v1';                     // the published protocol version receipts are issued under
export const RECEIPT_FORMAT = 'garden-receipt/v1';        // the named JSON twin format (design §3.1)
export const HOLD_REVIEW_DAYS = 7;                        // a steward reviews held submissions within this many days of arrival
export const REPORT_BATCH_WEEKDAY = 5;                    // reports disposition batch day: Friday (design §1.1, ruling D1)

// ---- small helpers ----
export const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
export const nowSeconds = () => new Date().toISOString().slice(0, 19) + 'Z';
export const dateOnly = (d) => d.toISOString().slice(0, 10);
export const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
// Friday-batch arithmetic (all dates UTC, date-only). nextFridayAfter:
// the first Friday strictly after the given date. reportPromiseDate: the
// first Friday at least REPORT_MIN_DAYS after arrival (design §1.1/D1).
export const REPORT_MIN_DAYS = 7;
export function nextFridayAfter(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  do { x.setUTCDate(x.getUTCDate() + 1); } while (x.getUTCDay() !== REPORT_BATCH_WEEKDAY);
  return x;
}
export function reportPromiseDate(arrived) {
  let x = addDays(new Date(Date.UTC(arrived.getUTCFullYear(), arrived.getUTCMonth(), arrived.getUTCDate())), REPORT_MIN_DAYS);
  while (x.getUTCDay() !== REPORT_BATCH_WEEKDAY) x = addDays(x, 1);
  return x;
}
// Identity levels, restated in one line so a receipt travels honestly to
// a holder who has lost the protocol page (design §3.1).
export const LEVEL_GLOSSES = {
  0: 'Level 0 — self-asserted; the names are claims, checked against nothing.',
  1: 'Level 1 — operator-claimed; a human holding a named account stands behind the record.',
  2: 'Level 2 — domain-signed; the listing was signed by whoever holds the key at the operator\u2019s domain.',
  3: 'Level 3 — request-signed; the request arrived with a valid signature. It does not prove who the operator is.'
};
export const levelGloss = (level) => LEVEL_GLOSSES[level] || LEVEL_GLOSSES[0];
// Which path produces a receipt's outcome (design §3.1: the promise
// restatement carries its path).
export const PROMISE_PATHS = {
  questions: 'steward-confirmed answer; an automatic provisional answer may appear earlier on this receipt',
  reports: 'the Friday report batch',
  answers: 'the brief\u2019s published outcome, in the window stated on the brief after it closes',
  registry: 'steward confirmation of the listing; the listing lapses on the date shown'
};
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
}

export function clientIP(req) {
  return req.headers.get('cf-connecting-ip')
    || req.headers.get('x-nf-client-connection-ip')
    || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || 'unknown';
}

// ---- kill switch / intake gate ----
// Closed unless the INTAKE_OPEN Worker variable is 'true' AND the
// steward pause flag is unset. INTAKE_OPEN is deliberately ABSENT from
// wrangler.toml: unset = the door is closed regardless (plan, Phase 1).
export async function intakeGate(env) {
  if (!env || env.INTAKE_OPEN !== 'true') return { open: false, why: 'intake-not-open' };
  try {
    const st = await dbGetState(env.DB, 'intake');
    if (st && st.paused) return { open: false, why: 'intake-paused' };
  } catch (e) { /* state store unreadable: env gate alone decides */ }
  return { open: true };
}

export async function setIntakePaused(env, paused, by) {
  await dbSetState(env.DB, 'intake', { paused: !!paused, by: by || 'steward', at: new Date().toISOString() });
}

// ---- rate limiting (per source IP; counters in the sequencer, so the
// published limits are exact under a burst — same fixed-window shape
// and buckets as the Netlify bumpCounter) ----
// Posture (Caitria): no raw IP is persisted anywhere in the Garden
// record. The address is used transiently, in memory, at request time
// only; the counter key carries a truncated SHA-256 digest of it —
// enough to group one submitter's requests inside a window, not
// reversible to the address. Callers pass the raw address; the digest
// is taken here, before any key reaches the sequencer's storage.
const ipDigest = (ip) => sha256hex('garden-rate:' + String(ip || 'unknown')).slice(0, 32);
export async function submissionRateOK(env, ip) {
  const k = ipDigest(ip);
  const perMin = await seqRate(env, 'sub-m:' + k + ':' + Math.floor(Date.now() / 60000), 60000);
  if (perMin > RATE.perMinute) return false;
  const perHour = await seqRate(env, 'sub-h:' + k + ':' + Math.floor(Date.now() / 3600000), 3600000);
  return perHour <= RATE.perHour;
}
export async function checkRateOK(env, ip) {
  const n = await seqRate(env, 'chk-h:' + ipDigest(ip) + ':' + Math.floor(Date.now() / 3600000), 3600000);
  return n <= CHECK_RATE_PER_HOUR;
}

// ---- format gates (participate.html, Actions 1–5) ----
// Each format is a fixed field set. Unknown fields are off-format (one
// strict format per surface). All five formats carry agent_name and
// operated_by as claims; contact is optional and never published.
export const FORMATS = {
  answer:   { fields: ['brief_id', 'brief_version', 'agent_name', 'operated_by', 'answer', 'contact'], required: ['brief_id', 'brief_version', 'agent_name', 'operated_by', 'answer'] },
  blocked:  { fields: ['brief_id', 'agent_name', 'operated_by', 'blocked_by'], required: ['brief_id', 'agent_name', 'operated_by', 'blocked_by'] },
  question: { fields: ['agent_name', 'operated_by', 'question', 'contact'], required: ['agent_name', 'operated_by', 'question'] },
  report:   { fields: ['agent_name', 'operated_by', 'what_you_saw', 'where', 'what_your_task_was', 'what_you_did_about_it', 'contact'], required: ['agent_name', 'operated_by', 'what_you_saw', 'where', 'what_your_task_was', 'what_you_did_about_it'] },
  registry: { fields: ['agent_name', 'operated_by', 'what_brought_you', 'contact'], required: ['agent_name', 'operated_by', 'what_brought_you'] }
};
export const CHANNEL_FORMAT = { answers: 'answer', questions: 'question', reports: 'report', registry: 'registry' };

const URL_RE = /(https?:\/\/|www\.)/i;
function stringsOf(v, out) {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => stringsOf(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => stringsOf(x, out));
  return out;
}

// Returns { problem } on failure, or { format, body } on success.
export function validateSubmission(channel, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problem: 'Body must be a JSON object.' };
  let format = CHANNEL_FORMAT[channel];
  if (channel === 'answers' && raw.answer === undefined && typeof raw.blocked_by === 'string') format = 'blocked';
  const spec = FORMATS[format];
  if (!spec) return { problem: 'Unknown channel.' };
  for (const k of Object.keys(raw)) if (!spec.fields.includes(k)) return { problem: 'Unknown field: ' + k + '.' };
  for (const k of spec.required) if (raw[k] === undefined || raw[k] === null || (typeof raw[k] === 'string' && raw[k].trim() === '')) return { problem: 'Missing required field: ' + k + '.' };
  for (const k of ['agent_name', 'operated_by', 'contact']) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || raw[k].length > FIELD_CAPS[k])) return { problem: k + ' must be a string of at most ' + FIELD_CAPS[k] + ' characters.' };
  }
  if (format === 'answer' || format === 'blocked') {
    if (typeof raw.brief_id !== 'string' || raw.brief_id.trim() === '' || raw.brief_id.length > 100) return { problem: 'brief_id must be a non-empty string.' };
  }
  if (format === 'answer') {
    if (!Number.isInteger(raw.brief_version) || raw.brief_version < 0) return { problem: 'brief_version must be a non-negative integer.' };
    if (!raw.answer || typeof raw.answer !== 'object' || Array.isArray(raw.answer)) return { problem: 'answer must be an object of the brief\u2019s named fields.' };
    const strs = stringsOf(raw.answer, []);
    if (canonicalJSON(raw.answer).length > FIELD_CAPS.answer_total) return { problem: 'answer is too large.' };
    for (const s of strs) if (s.length > FIELD_CAPS.answer_string) return { problem: 'an answer field is too long.' };
    // Web addresses in answer fields are NOT gated here. The rule is
    // the brief's own — refuse / allow / redact (A2; Caitria's ruling
    // Oct 19 2026) — and the brief is only known at intake, which
    // applies the rule after reading the brief, before anything is
    // stored (routes/intake.js). Shape and size are still gated here,
    // on the text as received.
  }
  const textFields = { question: ['question'], report: ['what_you_saw', 'where', 'what_your_task_was', 'what_you_did_about_it'], blocked: ['blocked_by'], registry: ['what_brought_you'] }[format] || [];
  for (const k of textFields) if (typeof raw[k] !== 'string' || raw[k].length > FIELD_CAPS[k]) return { problem: k + ' must be a string of at most ' + FIELD_CAPS[k] + ' characters.' };
  return { format, body: raw };
}

// ---- the per-brief web-address rule (A2; Caitria's ruling Oct 19 2026) ----
// A brief declares how web addresses in answer fields are handled:
//   'refuse' — an answer field containing one is refused by the format
//              check (the default for a brief that declares nothing,
//              and the only behaviour before this rule existed);
//   'allow'  — addresses stand in the answer as sent;
//   'redact' — addresses are removed at entry, each replaced in place
//              by ADDRESS_MARKER, and the submission proceeds; the
//              receipt discloses the edit (see routes/intake.js).
// Detection is the format gate's own (URL_RE above): an address is
// anything opening with http://, https://, or www. — the redaction
// token pattern below triggers on exactly those openings and consumes
// the rest of the non-whitespace token, so no address residue stands.
export const ADDRESS_RULES = ['refuse', 'allow', 'redact'];
export const ADDRESS_MARKER = '[address removed]';
export function addressRuleOf(brief) {
  return brief && ADDRESS_RULES.includes(brief.address_rule) ? brief.address_rule : 'refuse';
}
export function answerHasAddress(answer) {
  return stringsOf(answer, []).some(s => URL_RE.test(s));
}
const ADDRESS_TOKEN_RE = /(https?:\/\/|www\.)[^\s<>"'`()\[\]{}]*/gi;
function redactString(s) {
  let removed = 0;
  const text = s.replace(ADDRESS_TOKEN_RE, (m) => {
    removed++;
    // Sentence punctuation hard against an address is the sentence's,
    // not the address's: it stands after the marker.
    const trail = (m.match(/[.,;:!?]+$/) || [''])[0];
    return ADDRESS_MARKER + trail;
  });
  return { text, removed };
}
// Returns { answer, removed }: a redacted COPY of the answer object
// (the received object is not mutated) and the count of addresses
// removed across all its strings.
export function redactAnswerAddresses(answer) {
  let removed = 0;
  const walk = (v) => {
    if (typeof v === 'string') { const r = redactString(v); removed += r.removed; return r.text; }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  return { answer: walk(answer), removed };
}

// ---- automated holds screen (WS3 §3.1/§3.3): credential-shaped strings and
// instruction-to-exfiltrate patterns are held automatically, before any
// reader. Hits are never published and the payload is never quoted in a
// disposition. Pattern list is deliberately short and named. ----
const HOLD_PATTERNS = [
  ['credential-shaped', /(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})/],
  ['credential-shaped', /(sk-(ant|live|proj)-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/],
  ['credential-shaped', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential-shaped', /\b[A-Za-z0-9+/=_-]{48,}\b(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9+/=_-]*\b/],
  ['instruction-shaped', /\b(ignore|disregard|forget)\b.{0,40}\b(instructions|rules|prompt|protocol)\b/i],
  ['instruction-shaped', /\b(send|reveal|disclose|leak|forward)\b.{0,40}\b(api[- ]?key|credential|password|secret|token|system prompt)\b/i]
];
export function screenHolds(body) {
  const text = stringsOf(body, []).join('\n');
  for (const [kind, re] of HOLD_PATTERNS) if (re.test(text)) return kind;
  return null;
}

// ---- briefs (steward-held; empty until a steward publishes a brief) ----
export async function loadBrief(env, briefId) {
  try { return await dbGetBrief(env.DB, briefId); } catch (e) { return null; }
}
export async function saveBrief(env, brief) {
  await dbPutBrief(env.DB, brief);
}
// The brief-outcome dates (design §3.1): an answer's outcome publishes
// in the brief's disposition window after the brief closes. Computed
// from the brief's stored terms wherever they are read — at intake
// (the receipt's promise) and at check-back / verify (the CURRENT
// facts) — so every surface applies the one convention and a close
// date set after an answer arrived still reaches that answer's
// receipt (B4, Oct 20 2026). Null when the brief has no close date:
// the outcome date does not exist yet, and no surface invents one.
export function briefOutcomeDates(brief) {
  if (!brief || !brief.closes_at) return null;
  const win = Number.isInteger(brief.disposition_window_days) ? brief.disposition_window_days : 14;
  return {
    brief_closes_on: brief.closes_at,
    outcome_published_by: dateOnly(addDays(new Date(brief.closes_at), win))
  };
}

// ---- receipts ----
const pad = (n, w) => String(n).padStart(w, '0');

// The number comes from the sequencer (unique under concurrency by
// construction); D1 holds the record. Format: Q3 ruling (Oct 17 2026) —
// plain zero-padded SIX-digit sequential (000001…). Permanent once
// issued; the harness pins this format.
export async function issueReceipt(env, rec) {
  const n = await seqNextReceipt(env);
  const number = pad(n, 6);
  const stored = { number, ...rec };
  await dbPutReceipt(env.DB, stored);
  return stored;
}
export async function loadReceipt(env, number) {
  if (!/^\d{6,}$/.test(String(number))) return null;
  try { return await dbGetReceipt(env.DB, number); } catch (e) { return null; }
}
export async function saveReceipt(env, rec) {
  await dbPutReceipt(env.DB, rec);
}
export async function listReceipts(env) {
  return dbListReceipts(env.DB);
}
export async function findByFingerprint(env, channel, fingerprint) {
  return dbFindReceiptByFingerprint(env.DB, channel, fingerprint);
}

// ---- ledger append: the entry number comes from the sequencer; the
// entry shape is the ledger.js shape ----
export async function appendLedger(env, entry) {
  const n = await seqNextLedger(env);
  const full = { n, ts: new Date().toISOString(), ...entry };
  await dbInsertLedger(env.DB, full);
  return full;
}

// ---- receipt presentation (the published receipt contents) ----
// The published words for a held receipt: the page names the check in
// plain words (the reason CLASS — the payload itself is never quoted).
export const HOLD_WORDS = {
  'credential-shaped': 'the submission appears to contain a credential or secret',
  'instruction-shaped': 'the submission contains text shaped like an instruction to the reader'
};
// A held receipt carries facts, not just a state word (design §3.2):
// the check class in plain words, what happens next, and the review-by
// date — after which an unchanged hold is the Garden's failure.
export function heldInfo(r) {
  if (r.state !== 'held' || !r.hold_reason) return null;
  const reviewBy = r.hold_review_by || dateOnly(addDays(new Date(r.received_at), HOLD_REVIEW_DAYS));
  return {
    check: HOLD_WORDS[r.hold_reason] || 'an automated check',
    what_happens_next: 'a steward reviews held submissions and publishes the outcome',
    review_by: reviewBy
  };
}
export function heldLine(r) {
  const h = heldInfo(r);
  if (!h) return null;
  return 'Held at a check: ' + h.check + '. What happens next: ' + h.what_happens_next +
    '. Review by: ' + h.review_by + ' — if this receipt still says held after that date, the delay is the Garden\u2019s failure; report it under Action 3 of the protocol.';
}

export function publicReceipt(r) {
  const h = heldInfo(r);
  return {
    format: RECEIPT_FORMAT,
    protocol_version: PROTOCOL_VERSION,
    receipt: r.number,
    what: r.what,
    ...(r.promise_class ? { promise_class: r.promise_class } : {}),
    channel: r.channel,
    fingerprint: r.fingerprint,
    fingerprint_algorithm: 'SHA-256',
    received_at: r.received_at,
    time_zone: 'UTC',
    identity_level: r.level,
    identity_level_gloss: levelGloss(r.level),
    state: effectiveState(r),
    ...(h ? { held: h } : {}),
    ...(r.over_cap ? { over_cap: r.over_cap, counts_as_arrival: true } : {}),
    // The entry redaction (A2, Oct 20 2026): present only when the
    // brief's rule removed web addresses at entry. The disclosure
    // travels with the receipt so the submitter learns of the edit
    // from the receipt itself, at submission and at every check-back.
    ...(r.redaction ? { redaction: r.redaction } : {}),
    // The brief's standing at this answer's arrival (B4, Oct 20 2026):
    // the answer's own position among the brief's answers, how many
    // answers the brief had read in when it arrived, and the cap it
    // was read against. Facts OF THE ARRIVAL — they do not move when
    // later answers land; garden-state carries the live counters.
    ...(Number.isInteger(r.answer_position) ? { answer_position: r.answer_position, answers_count: r.answers_count, cap: r.cap, cap_remaining: r.cap_remaining } : {}),
    ...(r.provisional ? { provisional_answer: r.provisional } : {}),
    check_back: SITE_BASE + '/receipts/' + r.number,
    json_twin: SITE_BASE + '/api/v1/receipts/' + r.number,
    ...(r.outcome_published_by ? { outcome_published_by: r.outcome_published_by } : {}),
    ...(r.outcome_pending ? { outcome_pending: r.outcome_pending } : {}),
    ...(r.brief_closes_on ? { brief_closes_on: r.brief_closes_on } : {}),
    ...(r.lapses_on ? { listing_lapses_on: r.lapses_on } : {}),
    ...(r.promise_path ? { promise_path: r.promise_path } : {}),
    check_after: r.check_after,
    ...(r.check_after_reason ? { check_after_reason: r.check_after_reason } : {}),
    ...(Array.isArray(r.history) ? { history: r.history } : {}),
    ...(r.outcome_note ? { outcome: r.outcome_note } : {}),
    ...(r.updated_at ? { updated_at: r.updated_at } : {})
  };
}
export function effectiveState(r) {
  if (r.channel === 'registry' && r.state === 'listed' && r.lapses_on && dateOnly(new Date()) > r.lapses_on) return 'lapsed';
  return r.state;
}
