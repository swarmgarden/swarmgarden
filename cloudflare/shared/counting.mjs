// Swarm Garden — the counting window: when the current record began,
// and how to say its age in plain words (shared by both Workers).
//
// The current visit record is the Cloudflare-era dataset. Its first
// record was written at the Oct 17 2026 cutover; the Netlify-era
// record (Oct 15–17) is preserved separately and is NEVER merged into
// these totals. Because the Cloudflare counter therefore reads lower
// than the old Netlify-era total did, every published total travels
// with its window (Caitria, Oct 17 2026): the date counting began and
// how long it has been running.
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

// The window in parts — { date, age } — or null when the start is
// missing or unusable (callers then print no window claim at all,
// never a wrong one). Age wording: hours for the first 48 hours of
// counting ("the first N hours of counting"), days after that
// ("this record is N days old").
export function countingParts(sinceIso, now) {
  const since = new Date(sinceIso);
  if (isNaN(since)) return null;
  const at = now ? new Date(now) : new Date();
  const ms = at - since;
  if (!(ms >= 0)) return null;
  const hours = Math.floor(ms / 3600000);
  let age;
  if (hours < 48) {
    age = hours <= 1 ? 'the first hour of counting' : 'the first ' + hours + ' hours of counting';
  } else {
    const days = Math.floor(hours / 24);
    age = 'this record is ' + days + (days === 1 ? ' day' : ' days') + ' old';
  }
  return { date: countingDate(sinceIso), age };
}

// The full sentence, for surfaces whose label does not already say
// "Counting since": "Counting since Oct 17, 2026 — this record is
// 2 days old". Null when no honest sentence can be made.
export function countingSentence(sinceIso, now) {
  const p = countingParts(sinceIso, now);
  return p ? 'Counting since ' + p.date + ' — ' + p.age : null;
}
