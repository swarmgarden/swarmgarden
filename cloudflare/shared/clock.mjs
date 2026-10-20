// Swarm Garden — the clock utility's shared core (garden-clock/v1,
// added Oct 19 2026; the agent-utilities research pass's first pick,
// ruled by Caitria the same evening: "Let's do the clock").
//
// The one fact a caller cannot possess for itself is the current
// time somewhere else: a sandboxed or tool-only agent has no clock
// of its own, and its host's clock — where it has one — is a claim,
// not a reading. This module is the whole computation: deterministic,
// no model in the path, nothing learned from the caller is kept (the
// route writes a call record that carries the operation and the
// response status, never the requested zone or instant — see
// shared/visits.mjs writeUtilityVisit).
//
// The basis travels with the answer, per the research pass: every
// response names the time-zone data it was computed from (TZ_BASIS
// below), so a reading is never dressed up as more than the
// runtime's IANA data makes it.
import { aggregateUtilityCalls } from './visits.mjs';

export const CLOCK_FORMAT = 'garden-clock/v1';
export const CLOCK_UTILITY_PATH = '/utilities/garden-clock/v1';
// The render claim's shaping, matched exactly (the utilities
// research pass + Caitria's spend ruling, Oct 19 2026): 3 calls/min
// and 20/hr per source network, 300/day global. Popularity is
// governed by the caps, and the gate (CLOCK_OPEN + the steward
// pause flag) can close the utility at any time.
export const CLOCK_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };

// The tz-database basis, read from the runtime itself: Node-shaped
// runtimes carry the tzdata version they ship (process.versions.tz)
// and the ICU version; where neither is exposed, the basis is stated
// plainly rather than a version being invented.
export const TZ_BASIS = (() => {
  try {
    const v = (typeof process !== 'undefined' && process.versions) || {};
    if (v.tz) return 'IANA time zone database ' + v.tz + ', as carried by this runtime';
    if (v.icu) return 'IANA time zone database as carried by this runtime (ICU ' + v.icu + ')';
  } catch (e) { /* no versions object: the plain statement below */ }
  return 'IANA time zone database as carried by this runtime';
})();

const pad2 = (n) => String(n).padStart(2, '0');

// One formatter pair per zone, cached: the parts formatter (for the
// local reading + offset) and the name formatter (for the
// abbreviation). An invalid zone name throws RangeError from the
// Intl constructor — the route maps that to its 400. Only successful
// constructions are cached, so junk names cost nothing; the cache
// is cleared if it ever grows past any plausible zone count.
const dtfCache = new Map();
function formattersFor(timeZone) {
  let f = dtfCache.get(timeZone);
  if (f) return f;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' });
  f = { parts, name };
  if (dtfCache.size > 1024) dtfCache.clear();
  dtfCache.set(timeZone, f);
  return f;
}

export function isValidZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 100) return false;
  try { formattersFor(timeZone); return true; } catch (e) { return false; }
}

// The reading of one instant in one zone: the local ISO-8601 string
// (seconds precision, the offset appended), the offset itself
// (±HH:MM, with :SS appended for the historical zones whose offset
// is not a whole minute), and the zone's short name for that instant
// where the runtime provides one ('EDT', 'CEST', 'GMT+5:45', …).
export function zoneInfo(instant, timeZone) {
  const { parts, name } = formattersFor(timeZone);
  const got = {};
  for (const p of parts.formatToParts(instant)) got[p.type] = p.value;
  // hour '24' at midnight (some ICU builds, h23): Date.UTC below
  // rolls it into the next day correctly, and the display parts are
  // read back from that rolled instant, so both stay consistent.
  const asUTCms = Date.UTC(Number(got.year), Number(got.month) - 1, Number(got.day),
    Number(got.hour), Number(got.minute), Number(got.second));
  const disp = new Date(asUTCms);
  const offsetMs = asUTCms - Math.floor(instant.getTime() / 1000) * 1000;
  const sign = offsetMs < 0 ? '-' : '+';
  const absSec = Math.abs(Math.round(offsetMs / 1000));
  const offset = sign + pad2(Math.floor(absSec / 3600)) + ':' + pad2(Math.floor((absSec % 3600) / 60)) +
    (absSec % 60 ? ':' + pad2(absSec % 60) : '');
  const local = disp.getUTCFullYear() + '-' + pad2(disp.getUTCMonth() + 1) + '-' + pad2(disp.getUTCDate()) +
    'T' + pad2(disp.getUTCHours()) + ':' + pad2(disp.getUTCMinutes()) + ':' + pad2(disp.getUTCSeconds()) + offset;
  const namePart = name.formatToParts(instant).find(p => p.type === 'timeZoneName');
  return { local, offset, abbreviation: namePart ? namePart.value : null };
}

// The steward-side read (keyed stats page + the hourly snapshot's
// keyed leg): the aggregateUtilityCalls folds under the clock's own
// name. by_visitor_day rows carry { distinct, digest_requests,
// repeat_requests } — distinct CALLERS per Pacific day under the B9
// digest, with that series' stated caveats (shared/statsview.mjs).
export async function clockStats(env) {
  return aggregateUtilityCalls(env);
}
