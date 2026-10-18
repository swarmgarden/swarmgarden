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

// ---- Claimed-bot dictionary (query time; added Oct 17 2026) ----
// Matches a stored user-agent string against the names bots ANNOUNCE.
// A match is a claim read off the visitor's own software string —
// never a verification of who sent the request (classification
// synthesis, Oct 17 2026). This is deliberately a query-time label,
// like the behaviour labels above, and NOT a write-time class: it
// sees named crawlers the write-time taxonomy files under automation
// or unknown (Meta's link crawlers), and dictionary fixes re-label
// history instead of stranding it.
//
// CRAWLERS fetch on their operator's own schedule (indexing,
// training corpora, search indexes). FETCHERS fetch on a specific
// person's request (the taxonomy's 'user-triggered' purpose) — a
// different kind of visit, aggregated separately wherever these
// labels are used, never folded into the crawler count.
//
// 'google-extended' and 'applebot-extended' are robots.txt tokens,
// never user-agents: a UA claiming one is forged by definition and
// matches NOTHING here — it never counts as that crawler.
// Token order matters: more specific names are tested first.
export const CRAWLER_TOKENS = [
  // token, published name
  ['claude-searchbot', 'Claude-SearchBot'],
  ['oai-searchbot', 'OAI-SearchBot'],
  ['meta-externalagent', 'Meta-ExternalAgent'],
  ['meta-webindexer', 'Meta Web Indexer'],
  ['perplexitybot', 'PerplexityBot'],
  ['facebookexternalhit', 'facebookexternalhit'],
  ['archive.org_bot', 'Internet Archive'],
  ['claudebot', 'ClaudeBot'],
  ['googlebot', 'Googlebot'],
  ['amazonbot', 'Amazonbot'],
  ['bytespider', 'Bytespider'],
  ['duckduckbot', 'DuckDuckBot'],
  ['yandexbot', 'YandexBot'],
  ['baiduspider', 'Baiduspider'],
  ['pinterestbot', 'Pinterestbot'],
  ['linkedinbot', 'LinkedInBot'],
  ['twitterbot', 'Twitterbot'],
  ['discordbot', 'Discordbot'],
  ['googleother', 'GoogleOther'],
  ['semrushbot', 'SemrushBot'],
  ['ahrefsbot', 'AhrefsBot'],
  ['petalbot', 'PetalBot'],
  ['applebot', 'Applebot'],
  ['bingbot', 'Bingbot'],
  ['gptbot', 'GPTBot'],
  ['ccbot', 'CCBot'],
  ['ai2bot', 'AI2Bot'],
  ['cohere-ai', 'Cohere'],
  ['diffbot', 'Diffbot'],
  ['youbot', 'YouBot'],
  ['webzio', 'Webzio'],
  ['mj12bot', 'MJ12bot'],
  ['dotbot', 'DotBot'],
  ['msnbot', 'MSNBot'],
  ['slurp', 'Yahoo Slurp'],
  ['anthropic', 'Anthropic']
];
export const FETCHER_TOKENS = [
  // token, published name
  ['meta-externalfetcher', 'Meta-ExternalFetcher'],
  ['perplexity-user', 'Perplexity-User'],
  ['chatgpt-user', 'ChatGPT-User'],
  ['claude-user', 'Claude-User'],
  ['google-agent', 'Google-Agent'],
  ['mistralai-user', 'MistralAI-User'],
  ['duckassistbot', 'DuckAssistBot']
];

// claimedBot(ua) -> { kind: 'crawler' | 'fetcher', name } | null.
// At most one label per record: crawlers are tested before fetchers,
// and the forged robots-token names match nothing at all.
export function claimedBot(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return null;
  if (u.includes('google-extended') || u.includes('applebot-extended')) return null;
  for (const [token, name] of CRAWLER_TOKENS) if (u.includes(token)) return { kind: 'crawler', name };
  for (const [token, name] of FETCHER_TOKENS) if (u.includes(token)) return { kind: 'fetcher', name };
  return null;
}
