// Swarm Garden — the sequencer: ONE Durable Object that owns every
// number that must be exact (migration plan, Design A):
//   - the next receipt number      (was: Blobs `_counter`, read-then-write)
//   - the next ledger entry number (was: count the entries, add one)
//   - the next visitors'-book note number (the book's own sequence,
//     added Oct 17 2026 — separate from receipt numbers by design)
//   - the next signal number (the signal's own sequence, added
//     Oct 17 2026 — separate from receipt and note numbers alike)
//   - the next human self-report number (the button's own sequence,
//     added Oct 18 2026 — separate from every sequence above)
//   - each brief's read-answer count against its cap, and each brief's
//     total-answer count (the arrival position)
//   - the protocol's rate-limit counters (was: Blobs read-modify-write)
// A Durable Object runs one request at a time, so "take the next
// number" cannot interleave: numbers are unique by construction, a
// brief's cap is a hard cap under a burst, and the published rate
// limits are the enforced rate limits.
//
// The counters are a cache of the record, not the record: D1 is
// authoritative, and on first use (or after a storage reset) the
// sequencer seeds itself from D1 (see ensureInit). Rate counters are
// ephemeral by nature and need no seeding.
//
// Internal protocol (POST JSON to the object's fetch):
//   /next-receipt            -> { n }
//   /next-ledger             -> { n }
//   /brief-begin   { brief_id, cap, force_over_cap } -> { over_cap, position }
//        The cap decision AND the reservation, atomically: position =
//        the brief's next total-answer number; when the answer is
//        inside the cap, one read slot is consumed too. (A peek/commit
//        split raced under a burst — parallel peeks all read the
//        pre-burst counts and a cap of 3 admitted 8 of 10 in the
//        ported harness's Phase 2 burst check. The decision has to be
//        made inside the serialized object, not from counts read
//        earlier.)
//   /brief-release { brief_id, was_over_cap } -> { ok }
//        Returns a begin reservation. Intake calls this only when the
//        required-fields format gate rejects AFTER begin — the one
//        rejection the Netlify code could make after computing the
//        count, which consumed nothing there and consumes nothing here.
//   /rate         { key, window_ms } -> { count }
//        The Netlify bumpCounter, serialized: fixed record per key,
//        reset when the window has passed, then incremented.
import { dbMaxReceiptNumber, dbMaxLedgerNumber, dbMaxNoteNumber, dbMaxSignalNumber, dbMaxHumanPressNumber, dbBriefCounters } from './db.js';

export class Sequencer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = null;
  }

  async ensureInit() {
    if (!this.ready) {
      this.ready = (async () => {
        const done = await this.state.storage.get('init-v1');
        if (done) return;
        const db = this.env.DB;
        const seed = {
          nextReceipt: (await dbMaxReceiptNumber(db)) + 1,
          nextLedger: (await dbMaxLedgerNumber(db)) + 1,
          nextNote: (await dbMaxNoteNumber(db)) + 1,
          briefs: {}
        };
        for (const row of await dbBriefCounters(db)) {
          seed.briefs[row.brief_id] = { total: Number(row.total) || 0, read: Number(row.read_n) || 0 };
        }
        await this.state.storage.put('counters', seed);
        await this.state.storage.put('init-v1', true);
      })();
    }
    return this.ready;
  }

  async counters() {
    await this.ensureInit();
    return (await this.state.storage.get('counters')) || { nextReceipt: 1, nextLedger: 1, briefs: {} };
  }

  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const out = (obj) => new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });

    if (url.pathname === '/rate') {
      // Rate counters live outside the seeded counters record: they are
      // high-churn and windowed; one storage key per counter key.
      const k = 'rate:' + String(body.key || '');
      const windowMs = Number(body.window_ms) || 60000;
      const now = Date.now();
      let rec = await this.state.storage.get(k);
      if (!rec || now - rec.start > windowMs) rec = { start: now, count: 0 };
      rec.count++;
      await this.state.storage.put(k, rec);
      return out({ count: rec.count });
    }

    const c = await this.counters();

    if (url.pathname === '/next-receipt') {
      const n = c.nextReceipt;
      c.nextReceipt = n + 1;
      await this.state.storage.put('counters', c);
      return out({ n });
    }
    if (url.pathname === '/next-ledger') {
      const n = c.nextLedger;
      c.nextLedger = n + 1;
      await this.state.storage.put('counters', c);
      return out({ n });
    }
    if (url.pathname === '/next-note') {
      // The visitors' book counter (added Oct 17 2026). Sequencers
      // initialised before the book existed hold counters with no
      // nextNote field — seed it lazily from D1 on first use rather
      // than re-running the one-time init.
      if (!Number.isInteger(c.nextNote)) {
        c.nextNote = (await dbMaxNoteNumber(this.env.DB)) + 1;
      }
      const n = c.nextNote;
      c.nextNote = n + 1;
      await this.state.storage.put('counters', c);
      return out({ n });
    }
    if (url.pathname === '/next-signal') {
      // The signal counter (added Oct 17 2026). Same lazy-seed shape
      // as /next-note: sequencers initialised before the signal
      // existed hold counters with no nextSignal field — seed it
      // from D1 on first use rather than re-running the one-time
      // init.
      if (!Number.isInteger(c.nextSignal)) {
        c.nextSignal = (await dbMaxSignalNumber(this.env.DB)) + 1;
      }
      const n = c.nextSignal;
      c.nextSignal = n + 1;
      await this.state.storage.put('counters', c);
      return out({ n });
    }
    if (url.pathname === '/next-human') {
      // The human self-report counter (added Oct 18 2026). Same
      // lazy-seed shape as /next-note and /next-signal: sequencers
      // initialised before the button existed hold counters with no
      // nextHuman field — seed it from D1 on first use rather than
      // re-running the one-time init.
      if (!Number.isInteger(c.nextHuman)) {
        c.nextHuman = (await dbMaxHumanPressNumber(this.env.DB)) + 1;
      }
      const n = c.nextHuman;
      c.nextHuman = n + 1;
      await this.state.storage.put('counters', c);
      return out({ n });
    }
    if (url.pathname === '/brief-begin') {
      const id = String(body.brief_id || '');
      const b = c.briefs[id] || (c.briefs[id] = { total: 0, read: 0 });
      const over = !!body.force_over_cap ||
        (Number.isInteger(body.cap) && b.read >= body.cap);
      b.total++;
      if (!over) b.read++;
      await this.state.storage.put('counters', c);
      // `read` (the brief's read-slot count AFTER this begin) rides
      // along so intake can state the brief's standing on the receipt
      // it is about to issue (B4, Oct 20 2026) without a second call.
      return out({ over_cap: over, position: b.total, read: b.read });
    }
    if (url.pathname === '/brief-release') {
      const id = String(body.brief_id || '');
      const b = c.briefs[id];
      if (b) {
        b.total = Math.max(0, b.total - 1);
        if (!body.was_over_cap) b.read = Math.max(0, b.read - 1);
        await this.state.storage.put('counters', c);
      }
      return out({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }
}

// ---- client side: one named object ("garden") for the whole Garden ----
export function sequencerStub(env) {
  const id = env.SEQUENCER.idFromName('garden');
  return env.SEQUENCER.get(id);
}
async function call(env, path, body) {
  const res = await sequencerStub(env).fetch('https://sequencer' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  return res.json();
}
export const seqNextReceipt = (env) => call(env, '/next-receipt').then(r => r.n);
export const seqNextLedger = (env) => call(env, '/next-ledger').then(r => r.n);
export const seqNextNote = (env) => call(env, '/next-note').then(r => r.n);
export const seqNextSignal = (env) => call(env, '/next-signal').then(r => r.n);
export const seqNextHuman = (env) => call(env, '/next-human').then(r => r.n);
export const seqBriefBegin = (env, briefId, cap, forceOverCap) =>
  call(env, '/brief-begin', { brief_id: briefId, cap: cap ?? null, force_over_cap: !!forceOverCap })
    .then(r => ({ over_cap: !!r.over_cap, position: r.position, read: r.read }));
export const seqBriefRelease = (env, briefId, wasOverCap) =>
  call(env, '/brief-release', { brief_id: briefId, was_over_cap: !!wasOverCap });
export const seqRate = (env, key, windowMs) =>
  call(env, '/rate', { key, window_ms: windowMs }).then(r => r.count);
