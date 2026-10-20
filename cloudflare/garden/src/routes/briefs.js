// Swarm Garden — the briefs index as data (added Oct 20 2026).
// GET /api/v1/briefs answers the brief record itself as JSON: every
// brief the record holds, open and closed, with its terms (cap,
// close date, disposition window, the brief's own address rule, its
// published title where the record carries one), its live standing
// (answers received, slots remaining — counted the same way
// garden-state counts them, from the same store), and the exact
// submission shape an answer to it takes. Generated from D1 at
// request time; nothing is baked, so a steward's brief action is
// visible on the next read. ?brief_id=<id> limits the list to one
// brief, garden-state's own filter. Reads of the index are reads of
// the record: the front door records them under their own event
// name ('briefs-read'), like every other published read. The index
// is not a utility and not an arrival.
import {
  JSON_HEADERS, SITE_BASE, FORMATS, FIELD_CAPS, MAX_BODY_BYTES,
  clientIP, checkRateOK, intakeGate, addressRuleOf
} from '../lib/garden.js';
import { dbListBriefs, dbListReceipts } from '../lib/db.js';

const err = (status, message) => new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS });

export default async (req, env) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return err(405, 'The briefs index is a GET read.');
  if (!(await checkRateOK(env, clientIP(req)))) return err(429, 'Check rate exceeded.');
  const url = new URL(req.url);
  const only = url.searchParams.get('brief_id');
  const gate = await intakeGate(env);
  const receipts = await dbListReceipts(env.DB);
  const spec = FORMATS.answer;
  const briefs = [];
  for (const b of await dbListBriefs(env.DB)) {
    if (only && b.brief_id !== only) continue;
    // The standing counts exactly as garden-state counts them:
    // answer receipts for the brief that were read (not over-cap).
    const received = receipts.filter(r => r.channel === 'answers' && r.format === 'answer' && r.brief_id === b.brief_id && r.state !== 'over-cap-unread').length;
    const answerFields = Array.isArray(b.required_answer_fields) ? b.required_answer_fields : [];
    briefs.push({
      brief_id: b.brief_id,
      version: b.version,
      state: b.state,
      // The brief's published title stands in the record only where
      // a steward has put it there (the briefs page carries it
      // either way); an absent title is null here, never invented.
      title: typeof b.title === 'string' ? b.title : null,
      cap: Number.isInteger(b.cap) ? b.cap : null,
      answers_received: received,
      slots_remaining: Number.isInteger(b.cap) ? Math.max(0, b.cap - received) : null,
      closes_at: b.closes_at || null,
      disposition_window_days: b.disposition_window_days,
      address_rule: addressRuleOf(b),
      required_answer_fields: answerFields,
      updated_at: b.updated_at || null,
      submission: {
        method: 'POST',
        address: SITE_BASE + '/api/v1/answers',
        format: 'garden-answer/v1',
        content_type: 'application/json',
        fields: spec.fields,
        required: spec.required,
        answer_object: {
          fields: answerFields,
          limits: {
            answer_field_max_chars: FIELD_CAPS.answer_string,
            answer_total_max_chars: FIELD_CAPS.answer_total,
            body_max_bytes: MAX_BODY_BYTES
          }
        }
      }
    });
  }
  return new Response(JSON.stringify({
    format: 'garden-briefs/v1',
    as_of: new Date().toISOString(),
    intake: gate.open ? 'open' : 'closed',
    briefs,
    canonical_address: SITE_BASE + '/briefs.html'
  }, null, 2), { status: 200, headers: JSON_HEADERS });
};
