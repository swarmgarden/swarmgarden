// Swarm Garden — write-time reverse-DNS facts (Oct 19 2026, W6;
// plan D7 as reshaped by the adopted write-time-signals research).
//
// Two facts are computed at the edge, while the arriving address is
// in hand, and only the FACTS are stored — never the address, never
// the full hostname:
//
//   1. A network-origin category for every request, derived from
//      the address's reverse-DNS name AFTER forward confirmation
//      (the PTR name's own A/AAAA records must return the original
//      address — the two-step every operator who documents rDNS
//      verification specifies: Google, Apple, Yandex. An unconfirmed
//      PTR is forgeable by whoever controls the PTR zone, so an
//      unconfirmed name earns no category beyond 'named-other').
//      Categories: operator-crawler / commercial-bot / cloud-hosting
//      / cdn-proxy / residential-network / named-other / none (the
//      lookup ran; there is no PTR record) / not-checked (the lookup
//      could not run — timeout, error, no address). 'residential-
//      network' names a network, never a person: it is published
//      only as a network category and is never evidence of a human.
//   2. For claimed names whose operator documents an rDNS pattern,
//      a match verdict against THAT operator's documented domains:
//      rdns-match / rdns-mismatch / rdns-none (operator offers the
//      check; this address has no PTR record) / rdns-not-offered
//      (the operator publishes ranges or ASN facts only — OpenAI,
//      Anthropic, Perplexity, Amazon, Meta — so no rDNS verdict
//      exists to give) / rdns-not-checked (we could not run it).
//      The states are kept distinct by design: collapsing
//      not-offered into mismatch would manufacture findings.
//
// The lookup is budgeted: one PTR + one forward pair per address,
// cached per isolate (the cache holds addresses in MEMORY only,
// for the isolate's lifetime — never written anywhere), a short
// timeout, and every failure lands in not-checked, never in a
// negative state. The hostname returned by lookupNetworkOrigin is
// TRANSIENT: it exists only so the verdict can be computed in this
// call. It must never be stored, logged, or returned to a caller
// outside this module's verdict functions.
import { sameAddress } from './ranges.mjs';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const LOOKUP_TIMEOUT_MS = 700;

// ---- category table (registrable suffix -> category) ----
// A maintained pattern table, deliberately small: a suffix not in
// the table reads 'named-other', which is a true statement (the
// network named itself; we have no category for it), not a gap.
// Order matters: the first match wins, so operator patterns are
// tested before provider patterns.
const CATEGORY_RULES = [
  // suffix, category, required hostname prefix (optional)
  ['googlebot.com', 'operator-crawler'],
  ['search.msn.com', 'operator-crawler'],
  ['applebot.apple.com', 'operator-crawler'],
  ['yandex.ru', 'operator-crawler'],
  ['yandex.net', 'operator-crawler'],
  ['yandex.com', 'operator-crawler'],
  ['google.com', 'operator-crawler', 'rate-limited-proxy-'],
  ['ahrefs.com', 'commercial-bot'],
  ['semrush.com', 'commercial-bot'],
  ['googleusercontent.com', 'cloud-hosting'],
  ['compute.amazonaws.com', 'cloud-hosting'],
  ['amazonaws.com', 'cloud-hosting'],
  ['cloudapp.azure.com', 'cloud-hosting'],
  ['linode.com', 'cloud-hosting'],
  ['vultr.com', 'cloud-hosting'],
  ['ovh.net', 'cloud-hosting'],
  ['your-server.de', 'cloud-hosting'],
  ['cloudflare.com', 'cdn-proxy'],
  ['fastly.net', 'cdn-proxy'],
  ['cloudfront.net', 'cdn-proxy'],
  ['edgekey.net', 'cdn-proxy'],
  ['comcast.net', 'residential-network'],
  ['verizon.net', 'residential-network'],
  ['att.net', 'residential-network'],
  ['cox.net', 'residential-network'],
  ['rr.com', 'residential-network'],
  ['virginmedia.com', 'residential-network'],
  ['btcentralplus.com', 'residential-network']
];

export function suffixMatch(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix);
}

export function categoryForHostname(host) {
  const h = (host || '').toLowerCase();
  if (!h) return 'named-other';
  for (const [suffix, category, prefix] of CATEGORY_RULES) {
    if (suffixMatch(h, suffix) && (!prefix || h.startsWith(prefix))) return category;
  }
  return 'named-other';
}

// ---- the operators' documented rDNS patterns, by claimed name ----
// Only these claimed names have an rDNS verdict to give. Every
// other dictionary name belongs to the ranges-only or ASN-only
// families and reads rdns-not-offered — an honest ceiling, printed
// as such wherever the verdict prints.
export const RDNS_FOR_NAME = {
  'Googlebot': [{ suffix: 'googlebot.com' }],
  'GoogleOther': [{ suffix: 'googlebot.com' }],
  'Google-Agent': [{ suffix: 'googleusercontent.com' }, { suffix: 'google.com', prefix: 'google-proxy-' }],
  'Bingbot': [{ suffix: 'search.msn.com' }],
  'Applebot': [{ suffix: 'applebot.apple.com' }],
  'YandexBot': [{ suffix: 'yandex.ru' }, { suffix: 'yandex.net' }, { suffix: 'yandex.com' }]
};

// ---- DNS plumbing (DNS-over-HTTPS; answers only, nothing stored) ----
function reverseName(address) {
  const s = String(address || '').trim();
  if (!s) return null;
  if (s.includes(':')) {
    // IPv6: expand to 8 groups, then 32 nibbles, reversed.
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
    if (groups.length !== 8) return null;
    const nibbles = groups.map(g => g.padStart(4, '0')).join('');
    if (!/^[0-9a-fA-F]{32}$/.test(nibbles)) return null;
    return nibbles.split('').reverse().join('.') + '.ip6.arpa';
  }
  const parts = s.split('.');
  if (parts.length !== 4 || parts.some(p => !/^\d{1,3}$/.test(p))) return null;
  return parts.reverse().join('.') + '.in-addr.arpa';
}

async function doh(fetchFn, name, type, timeoutMs) {
  const url = DOH_URL + '?name=' + encodeURIComponent(name) + '&type=' + type;
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('rdns lookup timeout')), timeoutMs);
    });
    const res = await Promise.race([
      fetchFn(url, { headers: { 'accept': 'application/dns-json' } }),
      timeout
    ]);
    if (!res || !res.ok) return null;
    const json = await res.json();
    if (!json || !Array.isArray(json.Answer)) return [];
    return json.Answer.map(a => String(a.data || '')).filter(Boolean);
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Per-isolate cache: address -> origin result. Memory only; the
// isolate dies and the cache with it. Bounded so a scan cannot grow
// it without limit.
const originCache = new Map();
const ORIGIN_CACHE_MAX = 500;

// lookupNetworkOrigin(address) -> { state: 'ok', category,
// confirmed, hostname } | { state: 'not-checked' }.
// 'hostname' is TRANSIENT (see the header): verdict computation
// only, never stored or logged.
export async function lookupNetworkOrigin(address, fetchFn, timeoutMs) {
  const fn = fetchFn || fetch;
  const ms = timeoutMs || LOOKUP_TIMEOUT_MS;
  if (!address) return { state: 'not-checked' };
  const key = String(address);
  const hit = originCache.get(key);
  if (hit) return hit;
  const rev = reverseName(key);
  if (!rev) return { state: 'not-checked' };
  // One deadline for the whole lookup (PTR + forward pair share
  // the budget — the legs do not each get a fresh timeout).
  const deadline = Date.now() + ms;
  const left = () => Math.max(40, deadline - Date.now());
  const ptrs = await doh(fn, rev, 'PTR', left());
  if (ptrs === null) return { state: 'not-checked' };
  let out;
  if (!ptrs.length) {
    out = { state: 'ok', category: 'none', confirmed: false, hostname: null };
  } else {
    const hostname = ptrs[0].replace(/\.$/, '').toLowerCase();
    const [aRecs, aaaaRecs] = await Promise.all([
      doh(fn, hostname, 'A', left()), doh(fn, hostname, 'AAAA', left())
    ]);
    const answers = [...(aRecs || []), ...(aaaaRecs || [])];
    const confirmed = answers.some(ans => sameAddress(ans, key));
    out = {
      state: 'ok',
      category: confirmed ? categoryForHostname(hostname) : 'named-other',
      confirmed,
      hostname
    };
  }
  if (originCache.size >= ORIGIN_CACHE_MAX) originCache.clear();
  originCache.set(key, out);
  return out;
}

// The claimed-operator match verdict (see the header for the state
// meanings). `origin` is a lookupNetworkOrigin result. Returns
// { verdict, suffix } — suffix is the matched documented domain
// from the operator's own list, present only on a match; it is a
// published-pattern token, not a hostname.
export function rdnsVerdictFor(claimedName, origin) {
  const rules = RDNS_FOR_NAME[claimedName];
  if (!rules) return { verdict: 'not-offered', suffix: '' };
  if (!origin || origin.state !== 'ok') return { verdict: 'not-checked', suffix: '' };
  if (!origin.hostname) return { verdict: 'none', suffix: '' };
  const rule = rules.find(r => suffixMatch(origin.hostname, r.suffix) &&
    (!r.prefix || origin.hostname.startsWith(r.prefix)));
  if (rule && origin.confirmed) return { verdict: 'match', suffix: rule.suffix };
  return { verdict: 'mismatch', suffix: '' };
}
