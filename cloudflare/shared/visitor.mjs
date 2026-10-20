// Swarm Garden — the rotating-salt visitor digests (lens spec B-e;
// burn-down B48; steward ruling Oct 18, 2026: BUILD; extended by D2
// of the measurement-accuracy build, Oct 19, 2026).
//
//   visitor      = first 16 hex chars (64 bits) of
//                  HMAC-SHA-256(key = VISITOR_DIGEST_SECRET,
//                    message = "<Pacific date>|<cf-connecting-ip>|<user-agent>")
//   visitorepoch = the same construction over "<Pacific month>"
//                  ("YYYY-MM") — an epoch digest that links a
//                  visitor's requests across a whole calendar
//                  month, so distinct-visitor counts can span a
//                  week or a month (Caitria's ruling, Oct 19 2026:
//                  cross-day-linking digests are acceptable; privacy
//                  means raw addresses are never stored, and they
//                  never are).
//
// The date inside the DAILY digest was the UTC date from Oct 18
// 2026 until this build; from Oct 19 2026 it is the PACIFIC calendar
// date (America/Los_Angeles) — the day boundary the site's own
// reporting folds by, so a digest can no longer straddle two
// Pacific days (the audit measured the straddle manufacturing up to
// ~2x the distinct count on busy days). Records from the first era
// carry UTC-date digests; the era split is labelled wherever the
// series is printed. The epoch digest exists only from this build
// forward — there is no earlier epoch era to confuse it with.
//
// The secret is a per-site Worker secret, distinct per site — the
// two sites' digests are never comparable, so the key cannot merge
// what the datasets do not. Rotation is by the date/month inside the
// message: automatic, with nothing stored — there is no salt file to
// keep or leak. The key itself rotates only on steward action (e.g.
// suspected compromise); that rotation splits eras and is noted in
// PORT-NOTES when it happens.
//
// Semantics, exact: equal digests mean the same (period, egress
// address, user-agent) triple. It does NOT mean the same person,
// the same device, or a human — a NAT household shares one digest;
// one person on two networks is two digests. The user-agent stays
// inside both digests (documented undercount: one visitor whose
// client string changes mid-period counts twice); removing it is a
// modelling choice for a later ruling. The published name, on any
// surface, is "distinct visitor digests" with its period stated —
// never bare "visitors".
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
// "<period>|<address>|<user-agent>", where the period is a calendar
// date ("YYYY-MM-DD") for the daily digest or a calendar month
// ("YYYY-MM") for the epoch digest. Returns '' when it cannot be
// computed (no secret, or no address) — the record then honestly
// carries no digest.
export async function visitorDigest(secret, period, ip, ua) {
  if (!secret || !ip) return '';
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(period + '|' + ip + '|' + (ua || '')));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// The request's Pacific calendar date ("YYYY-MM-DD") and month
// ("YYYY-MM") in America/Los_Angeles — the day boundary the site's
// own reporting uses.
const PT_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
export function pacificPeriods(now = new Date()) {
  const parts = PT_PARTS.formatToParts(now);
  const g = (t) => (parts.find(p => p.type === t) || {}).value || '';
  const month = g('year') + '-' + g('month');
  return { day: month + '-' + g('day'), month };
}

// The digests for one request: { visitor, visitorepoch }, both ''
// when this Worker has no VISITOR_DIGEST_SECRET provisioned, or the
// request reached the edge without a cf-connecting-ip header. The
// user-agent is the record's own UA (the header, capped at 400
// chars, as recorded).
// The source digest (Oct 19 2026, W10 — approved by Caitria's
// ruling the same evening): first 16 hex chars of the HMAC over
// "src|<Pacific date>|<address>" under the SAME per-site secret as
// the visitor digest, in a distinct message domain ("src|"), so
// the two digests can never be compared or joined to each other.
// Deliberately NO user-agent in the input: this digest identifies
// a source ADDRESS for one Pacific day, nothing about a client.
// It answers "how many distinct source addresses" and "how many
// distinct sources claimed each name" — aggregate questions the
// per-request record could not answer at all. The address is an
// input to a one-way function and is discarded; the digest itself
// is never published, only aggregates over it. Pacific-date
// rotation matches the visitor digest's daily re-keying: a digest
// links a source's requests within one Pacific day and nothing
// across days. Returns '' when it cannot be computed.
export async function sourceDigest(secret, pacificDay, ip) {
  if (!secret || !ip) return '';
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('src|' + pacificDay + '|' + ip));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function sourceDigestForRequest(env, req) {
  const secret = (env && env.VISITOR_DIGEST_SECRET) || '';
  if (!secret) return '';
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip) return '';
  const { day } = pacificPeriods();
  return sourceDigest(secret, day, ip.trim());
}

export async function visitorForRequest(env, req) {
  const secret = (env && env.VISITOR_DIGEST_SECRET) || '';
  if (!secret) return { visitor: '', visitorepoch: '' };
  const ip = req.headers.get('cf-connecting-ip');
  if (!ip) return { visitor: '', visitorepoch: '' };
  const ua = (req.headers.get('user-agent') || '').slice(0, 400);
  const { day, month } = pacificPeriods();
  const addr = ip.trim();
  return {
    visitor: await visitorDigest(secret, day, addr, ua),
    visitorepoch: await visitorDigest(secret, month, addr, ua)
  };
}
