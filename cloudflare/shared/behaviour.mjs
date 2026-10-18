// Swarm Garden — behaviour labelling, shared by both Workers'
// dashboards. PRIVATE working labels (the stewards' read of the traffic),
// never published claims. Computed AT QUERY TIME over stored records —
// never frozen into the record at write time — so when the probe-path
// list improves, history re-labels itself (migration plan, Design B).
// This logic previously lived inside the Garden's stats.js only; the
// port ends the two-copy problem the same way taxonomy.js does.
export const INTEREST = ['llms.txt', 'robots.txt', 'agent-skills', 'agent-card', 'security.txt', 'sitemap'];

const PROBE_RE = /(\.env|\.git\/|xmlrpc|wp-admin|wp-login|\.php([?#]|$)|proc\/self|@fs|phpunit|\.aws|\.svn|boaform|hnap1|actuator|server-status|\.bak|\.sql|config\.php)/i;

export function behaviourLabel(r) {
  const p = (r && r.path) || '';
  if (PROBE_RE.test(p)) return 'probe-path';
  if (INTEREST.some(s => p.includes(s)) || p.includes('agent-card')) return 'discovery';
  if (/(participate|briefs|questions|reports|registry|record|receipts|utilities|changed)/.test(p)) return 'protocol-read';
  return 'read';
}
