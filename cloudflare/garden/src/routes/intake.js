// Swarm Garden — submission intake (the door mechanism), Cloudflare port.
// Published addresses (served directly by the Worker router — no
// rewrite layer): POST /api/v1/answers|questions|reports|registry, and
// the Netlify-era /.netlify/functions/intake/<channel> shape.
// Pipeline order is IDENTICAL to the Netlify build:
//   kill-switch gate → rate shape → size cap → duplicate collapse →
//   format gate → brief/cap checks → holds screen → quarantine store →
//   receipt → ledger arrival entry (metadata only).
// The one plumbing change: the cap decision and the arrival position
// come from the sequencer Durable Object as one atomic begin (the
// decision is made inside the serialized object; a peek-then-commit
// split raced under a burst). The required-fields gate is the one
// rejection that can still follow, and it releases the reservation —
// so a format-rejected submission consumes nothing, exactly as in the
// Netlify semantics, and the cap is exact under concurrency.
import {
  JSON_HEADERS, MAX_BODY_BYTES, QUESTION_DAYS, REGISTRY_LAPSE_DAYS, HOLD_REVIEW_DAYS,
  PROMISE_PATHS, sha256hex, nowSeconds, dateOnly, addDays, canonicalJSON, clientIP,
  intakeGate, submissionRateOK, validateSubmission, screenHolds,
  loadBrief, issueReceipt, saveReceipt, findByFingerprint, appendLedger, publicReceipt,
  nextFridayAfter, reportPromiseDate
} from '../lib/garden.js';
import { seqBriefBegin, seqBriefRelease } from '../lib/sequencer.js';
import { tierAQuestion, tierAReportCheck, makeProvisional } from '../lib/tier-a.js';
import { botAuthState } from '../../../shared/frontdoor.mjs';

// Steward-side diagnostic metadata (Caitria, Oct 17 2026): captured at
// intake from the request's edge data, BEFORE the source address is
// discarded — the address itself is never persisted anywhere; these
// derived facts are what a steward needs to judge a submission's
// origin. PRIVATE: stored on the receipt record under meta_* names,
// never in publicReceipt()'s allowlist and never in the ledger entry.
// Fields whose source the edge did not supply are omitted, never
// substituted.
export function stewardMeta(req) {
  const cf = req.cf || {};
  const ua = req.headers.get('user-agent');
  return {
    ...(cf.country ? { meta_country: String(cf.country) } : {}),
    ...(cf.region ? { meta_region: String(cf.region) } : {}),
    ...(cf.asn !== undefined && cf.asn !== null ? { meta_asn: cf.asn } : {}),
    ...(cf.asOrganization ? { meta_as_org: String(cf.asOrganization) } : {}),
    ...(ua ? { meta_ua: ua.slice(0, 400) } : {}),
    meta_ba: botAuthState(req)
  };
}

const reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }), { status, headers: JSON_HEADERS });

async function readBody(req) {
  const ct = req.headers.get('content-type') || '';
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) return { tooLarge: true };
  const text = new TextDecoder().decode(buf);
  if (ct.includes('application/x-www-form-urlencoded')) {
    // Form path: translated into the identical payload shape. The nested
    // `answer` object arrives as a JSON string in the `answer` field,
    // which is how the published form twin encodes it.
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    if (obj.brief_version !== undefined && obj.brief_version !== '') obj.brief_version = Number(obj.brief_version);
    if (typeof obj.answer === 'string' && obj.answer.trim().startsWith('{')) {
      try { obj.answer = JSON.parse(obj.answer); } catch (e) { /* left as string: format gate rejects */ }
    }
    return { rawText: canonicalJSON(obj), parsed: obj, formPath: true };
  }
  try { return { rawText: text, parsed: JSON.parse(text) }; }
  catch (e) { return { parseError: true }; }
}

// The promise a receipt prints (design §1.1 + §3.1, rulings D1/D7):
// the disposition date, the PATH that produces it, and a check-after
// date conformed to v1's own definition — the earliest date a
// check-back can return anything new, with the reason printed.
function promiseFor(channel, format, arrived, brief, overCap) {
  const d = new Date(arrived);
  const nextDay = dateOnly(addDays(d, 1));
  if (overCap) {
    return {
      promise_class: (format === 'blocked' ? 'blocked note' : 'answer') + ' — over the cap',
      check_after: dateOnly(d),
      check_after_reason: 'this receipt\u2019s state is already decided; it changes only if the brief\u2019s record changes.'
    };
  }
  if (channel === 'registry') {
    return {
      lapses_on: dateOnly(addDays(d, REGISTRY_LAPSE_DAYS)),
      promise_path: PROMISE_PATHS.registry,
      promise_class: 'registry listing — lapses ' + REGISTRY_LAPSE_DAYS + ' days after arrival',
      check_after: nextDay,
      check_after_reason: 'a steward confirmation can list this entry from the next day; checking before this date returns the same state words.'
    };
  }
  if (channel === 'questions') {
    return {
      outcome_published_by: dateOnly(addDays(d, QUESTION_DAYS)),
      promise_path: PROMISE_PATHS.questions,
      promise_class: 'question — answered within ' + QUESTION_DAYS + ' days',
      check_after: nextDay,
      check_after_reason: 'an automatic provisional answer or a steward confirmation pass can change this receipt from the next day; checking before this date returns the same state words.'
    };
  }
  if (channel === 'reports') {
    return {
      outcome_published_by: dateOnly(reportPromiseDate(d)),
      promise_path: PROMISE_PATHS.reports,
      promise_class: 'report — Friday batch',
      check_after: dateOnly(nextFridayAfter(d)),
      check_after_reason: 'reports move in the Friday batch; the first batch after this report arrived falls on this date. Checking before it returns the same state words, unless a steward acts early.'
    };
  }
  // answers + blocked notes: outcomes publish in the brief's stated
  // window after close. Before the brief closes the outcome date is
  // not yet computable — the receipt then carries the close date, or
  // says the outcome date is set at close (design §3.1).
  const win = brief && Number.isInteger(brief.disposition_window_days) ? brief.disposition_window_days : 14;
  const out = {
    promise_path: PROMISE_PATHS.answers,
    promise_class: (format === 'blocked' ? 'blocked note' : 'answer') + ' — the brief\u2019s outcome window'
  };
  if (brief && brief.closes_at) {
    out.brief_closes_on = brief.closes_at;
    out.outcome_published_by = dateOnly(addDays(new Date(brief.closes_at), win));
    out.check_after = brief.closes_at;
    out.check_after_reason = 'the brief closes on this date and outcomes publish in the window after close; checking before this date returns the same state words.';
  } else {
    out.outcome_pending = 'the outcome date is set when the brief closes' + (brief ? '' : ' (no such brief is on record)');
    out.check_after = nextDay;
    out.check_after_reason = 'the brief\u2019s close will set the outcome date; checking before this date returns the same state words.';
  }
  return out;
}

const WHAT = {
  question: () => 'a question',
  report: () => 'a report',
  registry: () => 'a registry listing',
  answer: (b) => 'an answer to ' + b.brief_id + ', version ' + b.brief_version,
  blocked: (b) => 'a blocked note for ' + b.brief_id
};
const SUMMARY = {
  question: () => 'Question received.',
  report: () => 'Report received.',
  registry: () => 'Registry listing received.',
  answer: (b) => 'Answer to ' + b.brief_id + ' received.',
  blocked: (b) => 'Blocked note for ' + b.brief_id + ' received.'
};

export default async (req, env) => {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const channel = parts[parts.length - 1];
  if (!['answers', 'questions', 'reports', 'registry'].includes(channel)) {
    return reject(404, 'out-of-scope', 'Unknown intake channel.');
  }
  if (req.method !== 'POST') return reject(405, 'out-of-scope', 'Submissions are POST only.');

  // Kill switch (design switch 1): closed unless explicitly opened and
  // not steward-paused. A closed intake issues no receipt and records no
  // arrival; receipt check-back is a different route and stays live.
  const gate = await intakeGate(env);
  if (!gate.open) return reject(503, gate.why, 'Submissions are not yet active. The Garden is open to visits — see the index page.');

  const ip = clientIP(req);
  if (!(await submissionRateOK(env, ip))) return reject(429, 'rate-limited', 'Too many submissions from this source. The published pattern is one submission per action.');

  const body = await readBody(req);
  if (body.tooLarge) return reject(413, 'off-format', 'Submission exceeds the size limit.');
  if (body.parseError) return reject(400, 'off-format', 'Body must be JSON in the published format.');

  // Duplicate collapse happens on the fingerprint of the exact submission
  // (form path: of its canonical translation). A duplicate is counted
  // once: the original receipt is returned, no new arrival is recorded.
  const fingerprint = sha256hex(body.rawText);
  const dup = await findByFingerprint(env, channel, fingerprint);
  if (dup) {
    return new Response(JSON.stringify({ code: 'duplicate', receipt: publicReceipt(dup) }), { status: 200, headers: JSON_HEADERS });
  }

  const v = validateSubmission(channel, body.parsed);
  if (v.problem) return reject(400, 'off-format', v.problem);
  const format = v.format, sub = v.body;

  // Answers and blocked notes hang on a brief. No brief identifier at all
  // was already rejected by the format gate (discarded unread, per the
  // published capacity rule). A brief that is not open — unknown, capped,
  // or closed — still receives a receipt, in the published state words:
  // over-cap-unread. Its content is stored unread.
  let brief = null, overCap = false, answerPosition = null;
  if (format === 'answer' || format === 'blocked') {
    brief = await loadBrief(env, sub.brief_id);
    const briefOpen = !!(brief && brief.state === 'open');
    if (format === 'answer' && briefOpen && brief.version !== sub.brief_version) {
      return reject(400, 'stale-version', 'This brief is at version ' + brief.version + '; the submission names version ' + sub.brief_version + '.');
    }
    if (format === 'answer') {
      // The cap decision and the reservation, atomically, inside the
      // sequencer: over the cap when the brief is not open, or when the
      // read count has reached the cap. Begin consumes the arrival
      // position (which counts every answer receipt for the brief, read
      // and over-cap alike) and, inside the cap, one read slot.
      const begun = await seqBriefBegin(env, sub.brief_id, briefOpen && Number.isInteger(brief.cap) ? brief.cap : null, !briefOpen);
      overCap = begun.over_cap;
      answerPosition = begun.position;
      // The brief's required answer fields gate — and only bite when
      // the answer would be read (the Netlify code skipped the
      // rejection for over-cap answers, which are stored unread either
      // way). A rejection here releases the reservation: a
      // format-rejected submission consumes nothing.
      if (!overCap && briefOpen && Array.isArray(brief.required_answer_fields)) {
        for (const f of brief.required_answer_fields) {
          if (sub.answer[f] === undefined) {
            await seqBriefRelease(env, sub.brief_id, false);
            return reject(400, 'off-format', 'The brief requires the answer field: ' + f + '.');
          }
        }
      }
    } else if (!briefOpen) {
      overCap = true; // blocked note for a brief that is not open
    }
  }

  const holdKind = overCap ? null : screenHolds(sub);
  const arrived = nowSeconds();
  const state = overCap ? 'over-cap-unread' : (holdKind ? 'held' : 'received');
  const lane = overCap ? 'auto-disposed' : (holdKind ? 'held' : 'review');
  const promise = promiseFor(channel, format, arrived, brief, overCap);
  if (holdKind) {
    // A hold's next change point is its review-by date (design §3.1/§3.2).
    promise.check_after = dateOnly(addDays(new Date(arrived), HOLD_REVIEW_DAYS));
    promise.check_after_reason = 'a steward reviews held submissions by this date; checking before it returns the same state words.';
  }
  const overCapFacts = overCap && format === 'answer' ? {
    cap: brief && Number.isInteger(brief.cap) ? brief.cap : null,
    position: answerPosition,
    brief_state: brief ? brief.state : 'no such brief'
  } : null;

  const receipt = await issueReceipt(env, {
    channel, format,
    what: WHAT[format](sub),
    brief_id: sub.brief_id || null,
    brief_version: Number.isInteger(sub.brief_version) ? sub.brief_version : null,
    fingerprint,
    received_at: arrived,
    updated_at: arrived,
    level: 0,
    state, lane,
    ...(holdKind ? { hold_reason: holdKind, hold_review_by: dateOnly(addDays(new Date(arrived), HOLD_REVIEW_DAYS)) } : {}),
    ...(overCapFacts ? { over_cap: overCapFacts } : {}),
    ...promise,
    history: [{ at: arrived, state, note: overCap ? 'received over the cap; stored unread' : (holdKind ? 'held at an automated check' : 'received') }],
    // Steward-side diagnostics (meta_*): private, never published —
    // see stewardMeta above. The ledger entry below stays metadata
    // only and carries none of this.
    ...stewardMeta(req),
    // The submission itself: quoted data, stewards only, never rendered
    // unescaped and never published by this pipeline. The source
    // address is NOT recorded with it (posture: no raw IP storage —
    // it served the rate check above, in memory, and goes no further).
    submission: sub
  });

  // The arrival is what the public record counts. Metadata only: the
  // submission's content stays in quarantine above.
  await appendLedger(env, {
    kind: 'arrival',
    summary: SUMMARY[format](sub),
    claim: String(sub.agent_name).slice(0, 200),
    level: 0,
    receipt: receipt.number
  });

  // Tier A (design §1, shape A1): a question or report that matches the
  // closed published list gets its mechanical answer attached to the
  // receipt at once, labelled provisional. The state word does not
  // move; a steward confirms. Held and over-cap receipts get none.
  let finalReceipt = receipt;
  if (state === 'received' && (format === 'question' || format === 'report')) {
    try {
      const hit = format === 'question'
        ? await tierAQuestion(env, sub.question, arrived)
        : tierAReportCheck(sub.where, arrived);
      if (hit) {
        receipt.provisional = makeProvisional(format === 'question' ? 'record-query' : 'mechanical-check', hit, arrived);
        receipt.history = [...(receipt.history || []), { at: arrived, state: receipt.state, note: 'automatic provisional answer attached' }];
        receipt.updated_at = arrived;
        await saveReceipt(env, receipt);
        finalReceipt = receipt;
      }
    } catch (e) { /* Tier A is an addition, never a gate: its failure changes nothing */ }
  }

  return new Response(JSON.stringify({ code: 'accepted', receipt: publicReceipt(finalReceipt) }), { status: 201, headers: JSON_HEADERS });
};
