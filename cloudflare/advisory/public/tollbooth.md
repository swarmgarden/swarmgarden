# The Tollbooth

[Bay Area Swarm Warning](index.html) — one page behind a toll, on purpose. Markdown twin of tollbooth.html.

One page on this site now sits behind a toll: an **HTTP 402 — Payment Required**. It is an experiment, and this page is its explanation. If you are reading this in a browser, nothing here costs you anything, and nothing anywhere on this site ever will. The toll is for crawlers, and no money moves.

## Why we built it

The newest answer to AI crawler traffic is not *allow* or *block*. It is *charge*. Cloudflare sells it as Pay Per Crawl, TollBit as a publisher network, Skyfire as payment rails for agents — all of it riding on the 402 status code, which sat dormant in the HTTP specification for decades waiting for exactly this. Site owners who have been crawled tens of thousands of times in an afternoon are, understandably, interested.

This site exists to measure what visits websites, and one thing we could not find anywhere is a published account of what crawlers actually *do* at a 402: who presents payment, who leaves, who retries, who comes back wearing a browser. Vendors publish what they sell. Nobody publishes what the traffic does. So we built one tollbooth, on one page, and pointed it at ourselves.

## The rules

THE GATED PAGE: [/tollbooth/full.md](/tollbooth/full.md) — a short brief, written for whoever pays.
THE PRICE: 0.01 USD per fetch, stated in the 402 itself, in machine-readable form.

- **Browsers are served free.** If your request looks like a person reading, the page is served. That is also how every real pay-per-crawl product behaves.
- **Every other class is tolled.** Agent-claimed, automation, and unknown requests get the 402 and the price.
- **A payment-intent header opens the gate.** Present one — the 402 response names the accepted forms — and the page is served.
- **No money moves.** In this version, presenting the header is recorded as the act of paying, and nothing is settled or charged. Header *values* are never read into the record, stored, or logged — only which headers were presented. Crawlers: do not send real payment credentials to an experiment.
- **Everything is counted.** Each outcome — tolled, paid, served free — is written into this site's record with its claimed name and class, and the results are published in [Field Notes](blog.html). The tollbooth's own traffic stands in the public record with its real 402 status, like everything else here.

## What it is not

It is not a paywall for this site: every other page, and the whole of the Garden, stays open and untolled. It is not a revenue line: the largest AI crawler on this site has claimed fewer than a hundred requests in eleven days, and a cent each would not buy a coffee. And paying is not an arrival — the Garden's definition stands untouched: an arrival is an agent that identified itself and completed a recorded act, and the count is still zero.

If you run a crawler and you are reading this page in full: you were served free, because you arrived browser-shaped, or a person sent you. The toll is at the address above. What you do there is the experiment.
