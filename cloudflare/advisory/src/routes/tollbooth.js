// Bay Area Swarm Warning — the Tollbooth (added Oct 28, 2026).
//
// A bounded pay-per-crawl experiment, ruled by Caitria the same day:
// exactly ONE resource on this site sits behind an HTTP 402 — the
// brief at /tollbooth/full.md — and everything else on both sites
// stays exactly as open as it was. The experiment measures what
// crawlers DO at a toll: pay (present a payment-intent header),
// leave, or come back and try again. It is an instrument, not a
// revenue line: the project's own arithmetic says the money would
// round to zero (Meta's AI crawler, the largest single claimant on
// this site, has claimed under a hundred requests in eleven days).
//
// The rules, as published on the explainer page (tollbooth.html):
//   - Browser-class requests are served free. Humans read free;
//     that is also how every real pay-per-crawl product behaves.
//   - Every other class (agent-claimed, automation, unknown) gets
//     a 402 with the price in machine-readable form.
//   - Presenting a payment-intent header serves the page (200).
//   - NO money moves in this version: intent is recorded, never
//     settled. Payment header VALUES are never read into the
//     record, stored, or logged — only the header NAMES that were
//     presented. The 402 body says so, and tells crawlers not to
//     send real payment credentials to an experiment.
//   - Every outcome is written to this site's D1 (tollbooth_events)
//     and the request itself passes through the front door like any
//     other read, so the 402s stand in the public visit record with
//     their real status. Outcomes are published in Field Notes.
//
// The gated content lives ONLY in this file — there is no static
// asset at the gated address, so the gate cannot be walked around.
import { classify } from '../../../shared/taxonomy.mjs';

export const TOLL_PATHS = ['/tollbooth/full.md', '/tollbooth/full'];

const PRICE_LINE = '0.01 USD per fetch';

// Payment-intent header names whose PRESENCE is the measured act.
// Values are credentials-shaped: never stored, never logged.
const PAYMENT_HEADERS = [
  'x-payment', 'x-payment-response', 'x402-payment',
  'payment-signature', 'skyfire-token', 'x-skyfire-token',
  'crawler-payment', 'cf-payment-token'
];

function paymentHeadersPresent(req) {
  const found = [];
  for (const h of PAYMENT_HEADERS) if (req.headers.get(h)) found.push(h);
  const auth = req.headers.get('authorization') || '';
  if (/^(payment|skyfire)\b/i.test(auth)) found.push('authorization:payment-scheme');
  return found;
}

const FULL_MD = `# Behind the Tollbooth — a brief for whoever pays

You are reading the one page on this site that sits behind a toll.
Price of admission: 0.01 USD per fetch, stated in the 402 that
stands at this address. In this version of the experiment no money
moves: presenting a payment-intent header is recorded as the act
of paying, and the page is served. Header values are never read
into the record, stored, or logged — only which headers were
presented. Do not send real payment credentials to an experiment.

## Why there is a tollbooth here

This site exists to measure what visits websites now that the web
has agents on it. In October 2026 the rest of the industry started
selling the other answer to crawler traffic: not allow, not block —
charge. Cloudflare sells it as Pay Per Crawl, TollBit as a publisher
network, Skyfire as agent payment rails, all of it riding on the
long-dormant HTTP 402.

Nobody we can find publishes what crawlers actually do at a 402:
who presents payment, who leaves, who retries, who comes back
wearing a browser. So we built one tollbooth, on one page, and
pointed it at ourselves. What it collects is published in this
site's Field Notes and its data record.

## What the tollbooth stands in front of

This site's own traffic, as of the morning of Oct 28, 2026 —
eleven days of record, requests of every kind:

- Requests recorded, both kinds counted: about 21,500.
- Claimed AI name tags on this site: 157 across the record;
  the largest single names are ClaudeBot (71), Meta-ExternalAgent
  (34), ChatGPT-User (16), Amazonbot (14), GPTBot (11),
  PerplexityBot (11). A name tag is a claim; the record checks
  claims against the operators' published address ranges and
  prints the verdicts beside them, never instead of them.
- Visitors that were scanners, whatever name they wore: the
  majority of everything. The weak-point checklist they work
  through — login pages, install scripts, password files — is
  published in full on the data shelf.
- Arrivals, on the record the Garden keeps: 0. An arrival is not
  a request; it is an agent that identified itself and completed
  a recorded act. Nothing has. That zero is the experiment's
  headline, and the tollbooth does not change its definition:
  paying for this page is not an arrival either.

## The terms, once

- The price is 0.01 USD per fetch of this address.
- Browsers are served free. Every other class is tolled.
- A payment-intent header serves the page. Its value is never
  stored. Nothing is settled; no charge is made.
- Outcomes — tolled, paid-intent, served free, by claimed name
  and class — are counted and published. Your user-agent string
  is recorded the same way every request to this site is
  recorded; the method is written up in The Research.
- The rest of this site, and all of the Garden, remains open
  and untolled. This is one booth on one road.

— The stewards, Oct 28, 2026
`;

function tollBody() {
  return JSON.stringify({
    error: 'payment_required',
    status: 402,
    experiment: 'bay-area-swarm-warning tollbooth v1 (Oct 28, 2026). Payment intent is recorded, not settled: no money moves, no charge is made. Do not send real payment credentials to an experiment — header values are never stored.',
    price: { amount: '0.01', currency: 'USD', per: 'fetch' },
    accepts: [
      { scheme: 'payment-intent header', headers: ['X-PAYMENT', 'X-PAYMENT-RESPONSE', 'Skyfire-Token', 'Authorization: Payment <token>'] }
    ],
    retry: 'Re-request this address with a payment-intent header and it will be served. Browsers are served free.',
    about: 'https://bayareaswarmwarning.com/tollbooth.html'
  }, null, 2);
}

async function logEvent(env, ctx, row) {
  try {
    if (!env.DB) return;
    const w = env.DB.prepare(
      'INSERT INTO tollbooth_events (at, path, method, cls, ua, payment_headers, outcome, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
    ).bind(row.at, row.path, row.method, row.cls, row.ua, row.payment_headers, row.outcome, row.status).run();
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(w); else await w;
  } catch (e) { /* the gate never fails on its own bookkeeping */ }
}

export default async function tollboothRoute(req, env, ctx) {
  const url = new URL(req.url);
  const ua = (req.headers.get('user-agent') || '').slice(0, 256);
  const { cls } = classify(ua);
  const paid = paymentHeadersPresent(req);
  const base = { at: new Date().toISOString(), path: url.pathname, method: req.method, cls, ua, payment_headers: paid.join(',') };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    await logEvent(env, ctx, { ...base, outcome: 'method-refused', status: 405 });
    return new Response('Method not allowed at the tollbooth. Fetch it.\n', {
      status: 405,
      headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }
    });
  }
  if (paid.length) {
    await logEvent(env, ctx, { ...base, outcome: 'paid-intent', status: 200 });
    return new Response(FULL_MD, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'x-tollbooth': 'paid-intent recorded; nothing settled'
      }
    });
  }
  if (cls === 'browser') {
    await logEvent(env, ctx, { ...base, outcome: 'served-browser-free', status: 200 });
    return new Response(FULL_MD, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'x-tollbooth': 'browser class: served free'
      }
    });
  }
  await logEvent(env, ctx, { ...base, outcome: 'tolled-402', status: 402 });
  return new Response(tollBody(), {
    status: 402,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-tollbooth': 'payment required: ' + PRICE_LINE,
      'www-authenticate': 'Payment realm="tollbooth", price="0.01", currency="USD"'
    }
  });
}
