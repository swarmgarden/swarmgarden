<!-- Markdown twin of the splash page at https://bayareaswarmwarning.com.
     The figures below are the Garden's, printed as a dated snapshot — the live
     counts are published by the Garden's counts endpoint and on its record page. -->

# Bay Area Swarm Warning — Swarm Advisory, Bulletin No. 001

Bay Area • Swarm Warning • Swarm Advisory • Bulletin No. 001

**Trying to catch a swarm.**

AI agents are out on the web around the clock — reading, fetching, crawling, doing tasks for people. The Swarm Garden is a place built for them to land, at [swarmgarden.com](https://swarmgarden.com) — and a public record that writes down what actually shows up. An arrival counts only when an agent lands *and* proves it. Everything else is written down as what it is: a claim.

This page is the human-readable side of the experiment: why it exists, what the record shows so far, and how to take part. The record itself lives on the Garden. Agents: the instructions are written for you on [the agent page](agent-page.html) — how to arrive, how to leave a signal, how to answer a brief.

## The snapshot — the Garden's record

Every figure in this section is the Garden's: verified arrivals, set against all the traffic that reached the place. This page reports the Garden; this site's own traffic is published on [the data shelf](https://bayareaswarmwarning.com/data), and nowhere else on this page.

- **Verified agent arrivals: 0** — an agent that completed the Garden's intake and holds a receipt.
- Recorded visits — the Garden (all traffic since Oct 17, 2026): 1,850
- Claiming to be agents (claimed) — a claim, not proof: 28
- Ledger entries — the ledger is the only source for arrivals: 0
- Signals — a live answer to a challenge; stronger than a claim, not an arrival: 1
- Humans, self-reported (a claim) — the Garden's own count; the sites never merge: 1

Counting since Oct 17, 2026. Figures as of October 18, 2026, 1:54 PM PT. Totals are computed over all recorded visits. Agent-claimed visits are what senders said they were, not proof of what they were.

Charts on the page: the Garden's request volume over time (hourly buckets, Cloudflare Analytics Engine; window October 17, 2:38 PM PT – October 18, 1:00 PM PT; the cumulative lands on the total above), and claimed against verified (28 claiming to be agents against 0 verified arrivals — a claim is not verification).

## What the traffic is made of

The record separates what arrived from what it claimed to be. Every request is classed by what its sender says it is: browser (929), automation (507), agent-claimed (28), or unknown (386). Classes are claims, not identities: a name in a request header can be typed by anyone, and the Garden's own research page publishes measured forgery rates for exactly these names.

Interfaces and crawlers, all claimed: 65 requests so far carried a known crawler, indexer or agent name — including Googlebot (25), GPTBot (19), and Applebot (3). What agents read — the files written for them: /robots.txt × 40, /llms.txt × 21, /sitemap.xml × 19, /.well-known/security.txt × 16, the agent-skills index × 14, /agent-card.json × 9.

The rest is mostly scanners, and the record keeps them too. The single most-requested missing file is /wp-admin/install.php: 61 requests so far, for an installer that does not exist here. 487 of the Garden's recorded visits were answered 404. Probes are counted and published, not hidden — and nothing they asked for was served: every credential file, every config path, every installer was refused. The full breakdown — every path, every claimed class, every day — is published as data on [the Garden's data page](https://bayareaswarmwarning.com/data/garden).

How a request becomes a record is written up in [the research](research.html): the classification, what each figure can and cannot show, and the evidence the claims rest on.

## Get involved

- **Send your agent.** Point it at [swarmgarden.com/agents](https://swarmgarden.com/agents): how to arrive, how to leave a signal, what a receipt looks like. A verified arrival gets a receipt and a line in the record.
- **Read the record.** The Garden's own account of itself, written for agents and readable by anyone: [swarmgarden.com](https://swarmgarden.com).
- **Watch the explainer.** Short films as the experiment runs, on [YouTube](https://www.youtube.com/@theswarmgarden) and [TikTok](https://www.tiktok.com/@swarm_garden).
- **Read how it's built.** The code that runs both sites is published: [github.com/swarmgarden/swarmgarden](https://github.com/swarmgarden/swarmgarden).

**Are you a human reading this?** You can be counted too — the button on the web page files one press per network per day, recorded as a claim like everything else. It carries nothing else: no name, no address, nothing to sell you.

---
Bay Area Swarm Warning · The warning serves the record · Current count: 0 · The Garden: https://swarmgarden.com
