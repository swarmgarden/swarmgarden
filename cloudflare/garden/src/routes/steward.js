// Swarm Garden — steward actions on the intake pipeline (Cloudflare
// port; logic unchanged). Key-gated (header x-steward-key, or ?k=, must
// match the STEWARD_KEY Worker secret). This is the ONLY path that
// changes a submission's state. Submission content is returned as JSON
// data for the isolated reader — quoted data, never instructions.
//
// POST actions (JSON body):
//   { action: 'disposition', receipt: '0007', state: '<state word>', note: 'optional one line' }
//   { action: 'confirm-provisional', receipt: '0007' }
//   { action: 'pause' } / { action: 'resume' }        — the kill switch
//   { action: 'brief', brief: { brief_id, version, state, cap, closes_at, disposition_window_days, required_answer_fields } }
// GET: the quarantine queue (every receipt, with its stored submission).
import { JSON_HEADERS, STATES, setIntakePaused, listReceipts, loadReceipt, saveReceipt, appendLedger, saveBrief } from '../lib/garden.js';
import { setSignalPaused } from '../lib/signal.js';
import { setHumanPaused } from '../lib/human.js';
import { setRenderPaused } from '../lib/render.js';

const REGISTRY_STATES = ['listed', 'lapsed', 'refreshed'];

function authed(req, env) {
  const KEY = env.STEWARD_KEY || '';
  if (!KEY) return false;
  const url = new URL(req.url);
  return req.headers.get('x-steward-key') === KEY || url.searchParams.get('k') === KEY;
}
const deny = (status, msg) => new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS });

export default async (req, env) => {
  if (!env.STEWARD_KEY) return deny(503, 'Steward actions are not configured on this site (STEWARD_KEY is not set).');
  if (!authed(req, env)) return deny(403, 'Steward key required.');

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const lane = url.searchParams.get('lane');
    let all = await listReceipts(env);
    if (lane) all = all.filter(r => r.lane === lane);
    return new Response(JSON.stringify({ count: all.length, queue: all }, null, 2), { status: 200, headers: JSON_HEADERS });
  }
  if (req.method !== 'POST') return deny(405, 'Method not allowed.');

  let body;
  try { body = await req.json(); } catch (e) { return deny(400, 'Body must be JSON.'); }

  if (body.action === 'pause' || body.action === 'resume') {
    await setIntakePaused(env, body.action === 'pause', 'steward-endpoint');
    return new Response(JSON.stringify({ ok: true, intake_paused: body.action === 'pause' }), { status: 200, headers: JSON_HEADERS });
  }

  // The signal's steward pause (added Oct 17 2026): the second gate
  // layer for the signal endpoints, beside SIGNAL_OPEN.
  if (body.action === 'signal-pause' || body.action === 'signal-resume') {
    await setSignalPaused(env, body.action === 'signal-pause', 'steward-endpoint');
    return new Response(JSON.stringify({ ok: true, signal_paused: body.action === 'signal-pause' }), { status: 200, headers: JSON_HEADERS });
  }

  // The human self-report's steward pause (added Oct 18 2026): the
  // second gate layer for the press endpoint, beside HUMAN_OPEN.
  if (body.action === 'human-pause' || body.action === 'human-resume') {
    await setHumanPaused(env, body.action === 'human-pause', 'steward-endpoint');
    return new Response(JSON.stringify({ ok: true, human_paused: body.action === 'human-pause' }), { status: 200, headers: JSON_HEADERS });
  }

  // The render claim's steward pause (added Oct 18 2026, lens spec
  // B-d): the second gate layer for the render endpoint, beside
  // RENDER_OPEN — which on the Garden stands absent (gate shut);
  // the flag is settable here so the shape is complete if the gate
  // is ever opened by a steward act.
  if (body.action === 'render-pause' || body.action === 'render-resume') {
    await setRenderPaused(env, body.action === 'render-pause', 'steward-endpoint');
    return new Response(JSON.stringify({ ok: true, render_paused: body.action === 'render-pause' }), { status: 200, headers: JSON_HEADERS });
  }

  if (body.action === 'brief') {
    const b = body.brief || {};
    if (typeof b.brief_id !== 'string' || !b.brief_id) return deny(400, 'brief.brief_id is required.');
    if (!Number.isInteger(b.version)) return deny(400, 'brief.version must be an integer.');
    if (!['open', 'capped', 'closed'].includes(b.state)) return deny(400, 'brief.state must be open, capped, or closed.');
    const brief = {
      brief_id: b.brief_id, version: b.version, state: b.state,
      cap: Number.isInteger(b.cap) ? b.cap : null,
      closes_at: typeof b.closes_at === 'string' ? b.closes_at : null,
      disposition_window_days: Number.isInteger(b.disposition_window_days) ? b.disposition_window_days : 14,
      required_answer_fields: Array.isArray(b.required_answer_fields) ? b.required_answer_fields.filter(x => typeof x === 'string') : [],
      updated_at: new Date().toISOString()
    };
    await saveBrief(env, brief);
    return new Response(JSON.stringify({ ok: true, brief }), { status: 200, headers: JSON_HEADERS });
  }

  if (body.action === 'confirm-provisional') {
    const r = await loadReceipt(env, String(body.receipt || ''));
    if (!r) return deny(404, 'No such receipt.');
    if (!r.provisional) return deny(400, 'Receipt ' + r.number + ' carries no provisional answer.');
    if (r.provisional.status === 'confirmed') return deny(400, 'Provisional answer on receipt ' + r.number + ' is already confirmed.');
    const at = new Date().toISOString();
    r.provisional = { ...r.provisional, status: 'confirmed', confirmed_at: at };
    r.history = [...(r.history || []), { at, state: r.state, note: 'automatic provisional answer confirmed by a steward' }];
    r.updated_at = at;
    let entry = null;
    if (r.channel === 'questions' && r.state === 'received') {
      r.state = 'disposition-published';
      r.lane = 'dispositioned';
      r.dispositioned_at = at;
      r.history[r.history.length - 1] = { at, state: 'disposition-published', note: 'automatic provisional answer confirmed and published by a steward' };
      await saveReceipt(env, r);
      entry = await appendLedger(env, {
        kind: 'disposition',
        summary: ('Disposition for receipt ' + r.number + ' (' + r.what + '): disposition-published.').slice(0, 500),
        claim: String(r.submission.agent_name || '').slice(0, 200),
        level: r.level,
        state: 'disposition-published',
        receipt: r.number
      });
    } else {
      await saveReceipt(env, r);
    }
    return new Response(JSON.stringify({ ok: true, receipt: r.number, provisional: 'confirmed', state: r.state, ledger_entry: entry ? entry.n : null }), { status: 200, headers: JSON_HEADERS });
  }

  if (body.action === 'disposition') {
    if (!STATES.includes(body.state)) return deny(400, 'state must be one of the published state words: ' + STATES.join(', ') + '.');
    const r = await loadReceipt(env, String(body.receipt || ''));
    if (!r) return deny(404, 'No such receipt.');
    r.state = body.state;
    r.lane = 'dispositioned';
    if (typeof body.note === 'string' && body.note.trim()) r.outcome_note = body.note.trim().slice(0, 500);
    r.dispositioned_at = new Date().toISOString();
    r.updated_at = r.dispositioned_at;
    r.history = [...(r.history || []), { at: r.dispositioned_at, state: body.state, note: 'steward disposition' + (r.outcome_note ? ': ' + r.outcome_note : '') }];
    await saveReceipt(env, r);
    // The outcome joins the public record as a ledger entry — metadata
    // and the state word; the submission's content is not quoted.
    const entry = await appendLedger(env, {
      kind: REGISTRY_STATES.includes(body.state) ? 'registry' : 'disposition',
      summary: ('Disposition for receipt ' + r.number + ' (' + r.what + '): ' + body.state + '.').slice(0, 500),
      claim: String(r.submission.agent_name || '').slice(0, 200),
      level: r.level,
      state: body.state,
      receipt: r.number
    });
    return new Response(JSON.stringify({ ok: true, receipt: r.number, state: r.state, ledger_entry: entry.n }), { status: 200, headers: JSON_HEADERS });
  }

  return deny(400, 'Unknown action.');
};
