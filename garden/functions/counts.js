// Swarm Garden — public counts (ESM + @netlify/blobs)
// Returns the counts the Garden publishes: arrivals on record (from the
// ledger store — steward-entered record entries, never page loads) and,
// for context, the visit-log totals by claimed class. Read-only, no key:
// these numbers are the public record. A user-agent is a claim, not proof.
import { getStore } from '@netlify/blobs';

async function readLedger() {
  const s = getStore('ledger');
  const { blobs } = await s.list();
  let entries = 0, arrivals = 0;
  for (const b of blobs || []) {
    try {
      const e = await s.get(b.key, { type: 'json' });
      if (e) { entries++; if (e.kind === 'arrival') arrivals++; }
    } catch (e) {}
  }
  return { entries, arrivals };
}

const INTEREST = ['llms.txt', 'robots.txt', 'agent-skills', 'agent-card', 'security.txt', 'sitemap'];

async function readVisits() {
  const s = getStore('visits');
  const { blobs } = await s.list();
  const keys = (blobs || []).map(b => b.key).slice(-1500);
  const byClass = {}, byPath = {}, interest = {};
  let total = 0;
  for (const k of keys) {
    try {
      const r = await s.get(k, { type: 'json' });
      if (r) {
        total++;
        byClass[r.cls] = (byClass[r.cls] || 0) + 1;
        byPath[r.path] = (byPath[r.path] || 0) + 1;
        if (INTEREST.some(x => (r.path || '').includes(x))) interest[r.path] = (interest[r.path] || 0) + 1;
      }
    } catch (e) {}
  }
  const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  return { total, byClass, topPaths: top(byPath, 10), interest: top(interest, 10) };
}

export default async () => {
  const out = { arrivals_on_record: 0, ledger_entries: 0, visits_total: 0, visits_by_class: {}, updated: new Date().toISOString() };
  try { const l = await readLedger(); out.arrivals_on_record = l.arrivals; out.ledger_entries = l.entries; }
  catch (e) { out.ledger_error = 'Ledger store unavailable.'; }
  try { const v = await readVisits(); out.visits_total = v.total; out.visits_by_class = v.byClass; out.top_paths = v.topPaths; out.agent_interest_files = v.interest; }
  catch (e) { out.visits_error = 'Visit store unavailable.'; }
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
};
