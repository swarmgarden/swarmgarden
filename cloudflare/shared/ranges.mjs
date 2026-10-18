// Swarm Garden — write-time address-range verdicts (lens spec A1+A2,
// Oct 18 2026; migration decision 8, ruled by Caitria Oct 18 2026:
// store the verdict, never the address).
//
// The plain statement this module stands on: Aulvem-grade
// identification does NOT require storing raw IP addresses. The
// check is a membership test — was this request's address inside the
// claimed operator's published ranges at the moment it arrived? —
// and it can only ever be run at the edge, at write time, while the
// address is in hand. What the record keeps is the ANSWER: the
// verdict, the version of the list that produced it, and the name
// that was claimed. The address is used transiently and discarded —
// never stored, never digested, never logged, and the matched prefix
// is not stored either (the version stamp identifies the list, not
// the hit).
//
// The bundle (shared/ranges/*.json + manifest.json) is produced by
// the steward-side fetch tool (tools/fetch-ranges/) from each
// operator's published range file and ships as Worker code. The
// manifest carries an explicit entry for EVERY name in the claimed-
// bot dictionary: the governing list, or the audited fact that the
// operator publishes no usable list. Refresh is a deploy chore
// (monthly; and whenever a wrong-range cluster suggests a list
// moved): re-run the tool, review the manifest diff, redeploy. A
// stale list cannot silently manufacture false verdicts without a
// trace — every verdict carries its list's version in `rangever`.
//
// Verdict values (stored as `ipverdict`, blob16; the claimed name as
// `cname`, blob15; the list version as `rangever`, blob17):
//   verified-range       name claimed; address inside the operator's
//                        published ranges (this list version)
//   wrong-range          name claimed; operator publishes ranges;
//                        address outside them
//   unverifiable-no-list name claimed; operator publishes no usable
//                        list — unverifiable BY DESIGN, not a failure
//   not-claimed          no dictionary name claimed (decided by the
//                        caller; this module is not consulted)
//   not-checked          name claimed but no verdict could be
//                        computed (no cf-connecting-ip header, an
//                        unparseable address, or the operator's list
//                        missing from the bundle). An instrument gap
//                        is NOT evidence about a sender: not-checked
//                        must never be folded into wrong-range.
// Semantics that travel with the field: a verdict is a statement
// about one request, one list version, one moment. verified-range
// certifies origin-network membership in the operator's published
// ranges and says nothing about intent or welcome.
import manifest from './ranges/manifest.json' with { type: 'json' };
import gptbot from './ranges/gptbot.json' with { type: 'json' };
import searchbot from './ranges/searchbot.json' with { type: 'json' };
import chatgptUser from './ranges/chatgpt-user.json' with { type: 'json' };
import googlebot from './ranges/googlebot.json' with { type: 'json' };
import googleCommonCrawlers from './ranges/google-common-crawlers.json' with { type: 'json' };
import googleSpecialCrawlers from './ranges/google-special-crawlers.json' with { type: 'json' };
import googleUserTriggeredFetchers from './ranges/google-user-triggered-fetchers.json' with { type: 'json' };
import anthropic from './ranges/anthropic.json' with { type: 'json' };
import bingbot from './ranges/bingbot.json' with { type: 'json' };

const LIST_FILES = {
  'gptbot': gptbot,
  'searchbot': searchbot,
  'chatgpt-user': chatgptUser,
  'googlebot': googlebot,
  'google-common-crawlers': googleCommonCrawlers,
  'google-special-crawlers': googleSpecialCrawlers,
  'google-user-triggered-fetchers': googleUserTriggeredFetchers,
  'anthropic': anthropic,
  'bingbot': bingbot
};

// ---- address + prefix arithmetic (BigInt; v4 and v6) ----
function ipToBig(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  const s = ip.trim();
  if (s.includes(':')) {
    // IPv6, with '::' compression and an optional embedded v4 tail.
    let tail = null;
    let body = s;
    const lastColon = s.lastIndexOf(':');
    const lastPart = s.slice(lastColon + 1);
    if (lastPart.includes('.')) {
      const v4 = ipToBig(lastPart);
      if (!v4 || v4.v !== 4) return null;
      tail = [Number((v4.n >> 16n) & 0xffffn), Number(v4.n & 0xffffn)];
      body = s.slice(0, lastColon + 1);
      if (body.endsWith(':') && !body.endsWith('::')) body = body.slice(0, -1);
    }
    const halves = body.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const tailLen = tail ? 2 : 0;
    if (halves.length === 1 && left.length + tailLen !== 8) return null;
    const missing = 8 - (left.length + right.length + tailLen);
    if (missing < 0) return null;
    const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
    if (tail) groups.push(...tail.map(x => x.toString(16)));
    if (groups.length !== 8) return null;
    let n = 0n;
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      n = (n << 16n) | BigInt(parseInt(g, 16));
    }
    return { v: 6, n };
  }
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const octet = Number(p);
    if (octet > 255) return null;
    n = (n << 8n) | BigInt(octet);
  }
  return { v: 4, n };
}

function parsePrefix(cidr) {
  const slash = cidr.lastIndexOf('/');
  if (slash < 0) return null;
  const base = ipToBig(cidr.slice(0, slash));
  const len = Number(cidr.slice(slash + 1));
  if (!base || !Number.isInteger(len)) return null;
  const bits = base.v === 4 ? 32 : 128;
  if (len < 0 || len > bits) return null;
  return { v: base.v, n: base.n, len, bits };
}

function inPrefix(ip, prefix) {
  if (ip.v !== prefix.v) return false;
  const shift = BigInt(prefix.bits - prefix.len);
  return (ip.n >> shift) === (prefix.n >> shift);
}

// Parsed lists, built once at module load: listId -> { creationTime, prefixes[] }.
const PARSED_LISTS = {};
for (const [id, file] of Object.entries(LIST_FILES)) {
  if (!file || !Array.isArray(file.prefixes)) continue;
  PARSED_LISTS[id] = {
    creationTime: file.creationTime || null,
    prefixes: file.prefixes.map(parsePrefix).filter(Boolean)
  };
}

const NOT_CHECKED = { verdict: 'not-checked', rangever: '' };

// verdictFor(claimedName, address) — the membership test. `address`
// is the request's cf-connecting-ip value (or null/undefined when the
// edge did not supply one). The caller (frontdoor) reads the header;
// this module never sees any other address source — in particular the
// client-spoofable x-forwarded-for fallback must never feed a verdict.
export function verdictFor(name, address) {
  const entry = (manifest.names || {})[name];
  if (!entry) return NOT_CHECKED; // dictionary/manifest drift: an instrument gap
  if (!entry.list) {
    if (entry.reason === 'no-list') return { verdict: 'unverifiable-no-list', rangever: entry.operator + '@none' };
    return NOT_CHECKED; // bundle-missing: the operator publishes ranges we could not bundle
  }
  const list = PARSED_LISTS[entry.list];
  if (!list || !list.prefixes.length) return NOT_CHECKED;
  const ip = ipToBig(address);
  if (!ip) return NOT_CHECKED;
  const hit = list.prefixes.some(p => inPrefix(ip, p));
  const stamp = list.creationTime ? String(list.creationTime).slice(0, 10) : 'unstamped';
  return { verdict: hit ? 'verified-range' : 'wrong-range', rangever: entry.list + '@' + stamp };
}

// The manifest entry for a claimed name (operator, list id, reason) —
// for steward surfaces that label what a verdict rests on.
export function claimedRangeMeta(name) {
  return (manifest.names || {})[name] || null;
}

export const RANGE_BUNDLE = {
  generated_at: manifest.generated_at || null,
  lists: Object.keys(PARSED_LISTS),
  names: Object.keys(manifest.names || {}).length
};
