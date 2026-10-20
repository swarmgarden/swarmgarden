// Swarm Garden — Web Bot Auth signature facts (Oct 19 2026, W6;
// the adopted write-time-signals research, §Web Bot Auth).
//
// Presence of Signature / Signature-Input headers has been counted
// since Oct 17 (the record's bot-auth census). This module adds,
// at write time, the two facts presence alone cannot carry — kept
// as THREE SEPARATE facts, never blended into one verdict:
//
//   presence — a Signature + Signature-Input pair was sent.
//   validity — our OWN RFC 9421 verification of that signature
//     against the key the signing host publishes in its key
//     directory (https://<host>/.well-known/http-message-
//     signatures-directory): valid / invalid / unverifiable (the
//     signature uses a shape this verifier does not cover) /
//     directory-unreachable (the key directory could not be
//     fetched — a failure of the directory or the network, recorded
//     as its own state, NEVER as invalid) / absent.
//   binding — whether the signing host is on our curated list of
//     known signers for the claimed name (bound / unbound /
//     absent). Today the signers are agents, not crawlers:
//     OpenAI's agent keys live at operator.openai.com, Google's
//     agent keys at agent.bot.goog. A validity verdict without a
//     binding says "someone holds this key", not "the claimed
//     agent sent this" — the two facts are published separately so
//     no reader has to guess which is meant.
//
// Platform note: request.cf on this account carries no
// botManagement object (Workers Paid tier; verified by probe,
// Oct 18 2026), so in-Worker verification is the only path — and
// wherever a validity figure is published it is labelled as our
// own computation, not a platform verdict.
//
// Keys are fetched per isolate and cached briefly in memory only.
// Nothing about a key or a signature is stored; only the three
// facts above land on the record.

// Curated signer hosts, by claimed name's signing host.
export const SIGNER_BINDINGS = {
  'operator.openai.com': ['ChatGPT-User'],
  'agent.bot.goog': ['Google-Agent']
};

// binding: 'bound' | 'unbound' — evaluated only when a signature
// is present; callers record 'absent' when it is not.
export function signerBinding(host, claimedName) {
  if (!host) return 'unbound';
  const names = SIGNER_BINDINGS[host];
  return names && names.includes(claimedName) ? 'bound' : 'unbound';
}

// ---- structured-field parsing (just enough for Signature-Input) ----
function splitTopLevel(header) {
  const parts = [];
  let depth = 0, inQ = false, cur = '';
  for (let i = 0; i < header.length; i++) {
    const c = header[i];
    if (inQ) {
      cur += c;
      if (c === '\\' && i + 1 < header.length) cur += header[++i];
      else if (c === '"') inQ = false;
      continue;
    }
    if (c === '"') { inQ = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

function parseParams(str) {
  const params = {};
  for (const piece of str.split(';')) {
    const p = piece.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq === -1) { params[p] = true; continue; }
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return params;
}

// Parse Signature-Input into { label: { raw (verbatim value for the
// signature base), covered: [{id, req}], params } }. Returns {} when
// the header is structurally unreadable.
export function parseSignatureInput(header) {
  const out = {};
  if (!header) return out;
  for (const entry of splitTopLevel(header)) {
    const eq = entry.indexOf('=(');
    if (eq === -1) continue;
    const label = entry.slice(0, eq).trim();
    // find the ')' closing the inner list (quotes may contain ')').
    let inQ = false, close = -1;
    for (let i = eq + 1; i < entry.length; i++) {
      const c = entry[i];
      if (inQ) { if (c === '\\') i++; else if (c === '"') inQ = false; continue; }
      if (c === '"') inQ = true;
      else if (c === ')') { close = i; break; }
    }
    if (close === -1) continue;
    const inner = entry.slice(eq + 2, close);
    const params = parseParams(entry.slice(close + 1));
    const covered = [];
    const re = /"([^"]+)"((?:;[^"])*?)(?=\s+"|\s*$)/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
      covered.push({ id: m[1], req: /;req\b/.test(m[2] || '') });
    }
    out[label] = { raw: entry.slice(eq + 1), covered, params };
  }
  return out;
}

export function parseSignatureHeader(header) {
  const out = {};
  if (!header) return out;
  for (const entry of splitTopLevel(header)) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    let v = entry.slice(eq + 1).trim().replace(/^"|"$/g, '');
    // RFC 9421 byte sequences are colon-wrapped (:base64:).
    if (v.startsWith(':') && v.endsWith(':') && v.length > 1) v = v.slice(1, -1);
    out[entry.slice(0, eq).trim()] = v;
  }
  return out;
}

// ---- key directory (per-isolate cache, memory only) ----
const dirCache = new Map(); // host -> { at, keys|null }
const DIR_TTL_MS = 10 * 60 * 1000;
const DIR_FAIL_TTL_MS = 60 * 1000;

async function fetchDirectoryKeys(host, fetchFn) {
  const hit = dirCache.get(host);
  const now = Date.now();
  if (hit && now - hit.at < (hit.keys ? DIR_TTL_MS : DIR_FAIL_TTL_MS)) return hit.keys;
  let keys = null;
  try {
    const res = await fetchFn('https://' + host + '/.well-known/http-message-signatures-directory',
      { headers: { 'accept': 'application/json' } });
    if (res && res.ok) {
      const json = await res.json();
      const arr = Array.isArray(json) ? json : (json && Array.isArray(json.keys) ? json.keys : null);
      if (arr) keys = arr.filter(k => k && k.kty === 'OKP' && k.crv === 'Ed25519' && k.x);
    }
  } catch (e) { keys = null; }
  dirCache.set(host, { at: now, keys });
  return keys;
}

function b64ToBytes(b64) {
  const s = String(b64).replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// verifyWebBotAuth({ getHeader, method, url, sigAgentHost,
// claimedName, fetchFn, nowSec }) ->
//   { presence, validity, binding } per the header comment.
// Never throws: every failure mode lands in a named state.
export async function verifyWebBotAuth(opts) {
  const absent = { presence: 'absent', validity: 'absent', binding: 'absent' };
  try {
    const sigHeader = opts.getHeader('signature');
    const inputHeader = opts.getHeader('signature-input');
    if (!sigHeader || !inputHeader) return absent;
    const binding = signerBinding(opts.sigAgentHost, opts.claimedName);
    const present = v => ({ presence: 'present', validity: v, binding });
    const inputs = parseSignatureInput(inputHeader);
    const sigs = parseSignatureHeader(sigHeader);
    const labels = Object.keys(inputs).filter(l => sigs[l]);
    if (!labels.length) return present('unverifiable');
    const label = labels.find(l => inputs[l].params.tag === 'web-bot-auth') || labels[0];
    const entry = inputs[label];
    if (entry.params.alg !== 'ed25519') return present('unverifiable');
    if (entry.covered.some(c => c.req)) return present('unverifiable');
    if (!opts.sigAgentHost) return present('unverifiable');
    const keys = await fetchDirectoryKeys(opts.sigAgentHost, opts.fetchFn || fetch);
    if (!keys) return present('directory-unreachable');
    const kid = entry.params.keyid;
    const jwk = (kid && keys.find(k => k.kid === kid)) || (keys.length === 1 ? keys[0] : null);
    if (!jwk) return present('unverifiable');
    const nowSec = opts.nowSec || Math.floor(Date.now() / 1000);
    const expires = Number(entry.params.expires || 0);
    if (expires && expires < nowSec) return present('invalid'); // an expired signature does not verify
    // Build the signature base.
    const u = new URL(opts.url);
    const lines = [];
    for (const c of entry.covered) {
      let value = null;
      if (c.id === '@method') value = String(opts.method || 'GET').toUpperCase();
      else if (c.id === '@authority') value = u.host;
      else if (c.id === '@path') value = u.pathname;
      else if (c.id === '@query') value = u.search || '?';
      else if (c.id === '@scheme') value = u.protocol.replace(':', '');
      else if (c.id === '@request-target') value = u.pathname + u.search;
      else if (c.id.startsWith('@')) return present('unverifiable');
      else {
        const hv = opts.getHeader(c.id);
        if (hv === null || hv === undefined) return present('unverifiable');
        value = String(hv).trim().replace(/\s+/g, ' ');
      }
      lines.push('"' + c.id + '": ' + value);
    }
    lines.push('"@signature-params": ' + entry.raw);
    const base = new TextEncoder().encode(lines.join('\n'));
    let sigBytes;
    try { sigBytes = b64ToBytes(sigs[label]); } catch (e) { return present('invalid'); }
    const key = await crypto.subtle.importKey('jwk',
      { kty: 'OKP', crv: 'Ed25519', x: jwk.x, ext: true },
      { name: 'Ed25519' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sigBytes, base);
    return present(ok ? 'valid' : 'invalid');
  } catch (e) {
    return { presence: 'present', validity: 'unverifiable', binding: 'unbound' };
  }
}
