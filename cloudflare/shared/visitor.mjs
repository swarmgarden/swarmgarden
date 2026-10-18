// Swarm Garden — the rotating-salt visitor digest (lens spec B-e;
// burn-down B48; steward ruling Oct 18, 2026: BUILD).
//
//   visitor = first 16 hex chars (64 bits) of
//             HMAC-SHA-256(key = VISITOR_DIGEST_SECRET,
//                          message = "<UTC date>|<cf-connecting-ip>|<user-agent>")
//
// The secret is a per-site Worker secret, distinct per site — the
// two sites' digests are never comparable, so the key cannot merge
// what the datasets do not. Rotation is by the UTC date inside the
// message: automatic, daily, with nothing stored — there is no salt
// file to keep or leak. The key itself rotates only on steward
// action (e.g. suspected compromise); that rotation splits eras and
// is noted in PORT-NOTES when it happens.
//
// Semantics, exact: equal digests mean the same (UTC day, egress
// address, user-agent) triple. It does NOT mean the same person,
// the same device, or a human — a NAT household shares one digest;
// one person on two networks is two digests. The published name, on
// any surface, is "distinct visitor digests (one day; unlinked
// across days)" — never bare "visitors".
//
// The address is an input to a one-way function and is discarded —
// the identical posture to the intake and human-press rate-limit
// digests. It is read ONLY from cf-connecting-ip (never the
// client-spoofable x-forwarded-for fallback), used transiently in
// this call, and never stored, logged, or returned anywhere.

const enc = new TextEncoder();
// Imported keys are cached per secret for the isolate's lifetime;
// the cache holds key material only in memory, never on disk.
const keyCache = new Map();

function importKey(secret) {
  let p = keyCache.get(secret);
  if (!p) {
    p = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, p);
  }
  return p;
}

// The pure digest: first 16 hex chars of the HMAC over
// "<UTC date>|<address>|<user-agent>". Returns '' when it cannot be
// computed (no secret, or no address) — the record then honestly
// carries no digest.
export async function visitorDigest(secret, utcDate, ip, ua) {
  if (!secret || !ip) return '';
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(utcDate + '|' + ip + '|' + (ua || '')));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// The digest for one request, or '' when this Worker has no
// VISITOR_DIGEST_SECRET provisioned, or the request reached the
// edge without a cf-connecting-ip header. The user-agent is the
// record's own UA (the header, capped at 400 chars, as recorded).
export async function visitorForRequest(env, req) {
  const secret = (env && env.VISITOR_DIGEST_SECRET) || '';
  if (!secret) return '';
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip) return '';
  const ua = (req.headers.get('user-agent') || '').slice(0, 400);
  return visitorDigest(secret, new Date().toISOString().slice(0, 10), ip.trim(), ua);
}
