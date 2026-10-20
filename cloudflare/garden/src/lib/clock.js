// Swarm Garden — the clock utility's Garden-side gate and rate
// shaping (garden-clock/v1, added Oct 19 2026). The computation and
// the steward-side read live in shared/clock.mjs; this file is the
// channel machinery, shaped exactly like the other gated channels
// (the human press's lib is the closest sibling):
//
//   - the gate, two layers: CLOCK_OPEN = 'true' in wrangler.toml
//     (set there under Caitria's Oct 19 2026 ruling — "Let's do the
//     clock" — so the value travels with the build, like
//     INTAKE_OPEN / SIGNAL_OPEN / HUMAN_OPEN) AND the steward pause
//     flag unset (garden_state key 'clock'; the steward route's
//     clock-pause / clock-resume actions set it — the no-redeploy
//     kill switch);
//   - the rate shape, matched to the render claim's published
//     precedent: 3 calls/min + 20/hr per source network and a
//     300/day global cap, counted by the sequencer under clk-*
//     keys. The address is used transiently, in memory; only a
//     truncated salted digest keys the counters.
import { dbGetState, dbSetState } from './db.js';
import { sha256hex } from './garden.js';
import { seqRate } from './sequencer.js';
import { CLOCK_RATE } from '../../../shared/clock.mjs';

export { CLOCK_RATE };

// ---- the gate (the intake pattern, two layers) ----
export async function clockGate(env) {
  if (!env || env.CLOCK_OPEN !== 'true') return { open: false, why: 'clock-not-open' };
  try {
    const st = await dbGetState(env.DB, 'clock');
    if (st && st.paused) return { open: false, why: 'clock-paused' };
  } catch (e) { /* state store unreadable: env gate alone decides */ }
  return { open: true };
}
export async function setClockPaused(env, paused, by) {
  await dbSetState(env.DB, 'clock', { paused: !!paused, by: by || 'steward', at: new Date().toISOString() });
}

// ---- rate limiting (per source network + the global daily cap) ----
const clockIpDigest = (ip) => sha256hex('garden-clock-rate:' + String(ip || 'unknown')).slice(0, 32);
export async function clockRateOK(env, ip) {
  const k = clockIpDigest(ip);
  const perMin = await seqRate(env, 'clk-m:' + k + ':' + Math.floor(Date.now() / 60000), 60000);
  if (perMin > CLOCK_RATE.perMinute) return false;
  const perHour = await seqRate(env, 'clk-h:' + k + ':' + Math.floor(Date.now() / 3600000), 3600000);
  return perHour <= CLOCK_RATE.perHour;
}
// The global daily cap (Caitria's spend ruling: popularity is
// governed by caps, and the utility can be turned off): every call
// that passes the gate and the per-network shape consumes one slot
// of the day's 300, whatever its outcome — a flood of malformed
// calls spends the day exactly as a flood of good ones would.
export async function clockGlobalOK(env) {
  const perDay = await seqRate(env, 'clk-day:' + new Date().toISOString().slice(0, 10), 172800000);
  return perDay <= CLOCK_RATE.perDayGlobal;
}
