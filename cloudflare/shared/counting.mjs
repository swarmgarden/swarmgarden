// Swarm Garden — the counting window: when the current record began
// (shared by both Workers).
//
// The current visit record is the Cloudflare-era dataset. Its first
// record was written at the Oct 17 2026 cutover; the Netlify-era
// record (Oct 15–17) is preserved separately and is NEVER merged into
// these totals. Because the Cloudflare counter therefore reads lower
// than the old Netlify-era total did, every published total travels
// with its window (Caitria, Oct 17 2026): the date counting began.
// The age wording that used to trail the date ("the first N hours of
// counting" / "this record is N days old") was removed by Caitria's
// ruling (Oct 18 2026) — the window is the date, nothing after it.
//
// The start is a constant on purpose: the dataset can never gain an
// earlier record, and deriving it per request would cost a second
// store query on every counts read for a fact that cannot change.
export const COUNTING_SINCE = '2026-10-17T21:38:49Z'; // first record in the Garden's Analytics Engine dataset

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function countingDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

// The window in parts — { date } — or null when the start is
// missing, unusable, or in the future (callers then print no window
// claim at all, never a wrong one).
export function countingParts(sinceIso, now) {
  const since = new Date(sinceIso);
  if (isNaN(since)) return null;
  const at = now ? new Date(now) : new Date();
  if (!(at - since >= 0)) return null;
  return { date: countingDate(sinceIso) };
}

// The full sentence, for surfaces whose label does not already say
// "Counting since": "Counting since Oct 17, 2026". Null when no
// honest sentence can be made.
export function countingSentence(sinceIso, now) {
  const p = countingParts(sinceIso, now);
  return p ? 'Counting since ' + p.date : null;
}
