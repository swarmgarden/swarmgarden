// Swarm Garden — visitor taxonomy: the SINGLE SOURCE for user-agent
// classification in the Garden's functions. visit.js imports classify()
// from here; no other copy of the token lists should exist in this tree.
// (The advisory site, bayareaswarmwarning.com, is a separate deploy with
// its own copy — flagged in the Oct 17 build report, not silently shared.)
//
// A user-agent is a CLAIM, not a proof of identity. The claim class says
// what the visitor announced; the purpose says what the announcing
// software is FOR, per its operator's own documentation:
//   training       — crawlers gathering corpora for model training
//   search         — crawlers/fetchers building or serving search/AI answers
//   user-triggered — fetchers acting on a specific user's request
//   other          — agent-shaped claims that fit none of the above
//
// 'google-extended' and 'applebot-extended' are deliberately ABSENT:
// they are robots.txt tokens, never user-agents. A log line claiming
// them as a UA is forged by definition (classification synthesis,
// Oct 17 2026) and falls through to the generic automation class.
export const AGENT_TOKENS = [
  // token, purpose
  ['gptbot', 'training'],
  ['claudebot', 'training'],
  ['anthropic', 'training'],
  ['ccbot', 'training'],
  ['bytespider', 'training'],
  ['meta-externalagent', 'training'],
  ['ai2bot', 'training'],
  ['cohere-ai', 'training'],
  ['oai-searchbot', 'search'],
  ['claude-searchbot', 'search'],
  ['perplexitybot', 'search'],
  ['chatgpt-user', 'user-triggered'],
  ['claude-user', 'user-triggered'],
  ['perplexity-user', 'user-triggered'],
  ['meta-externalfetcher', 'user-triggered'],
  ['google-agent', 'user-triggered'],
  ['mistralai-user', 'user-triggered'],
  ['duckassistbot', 'user-triggered'],
  ['googleother', 'other'],
  ['amazonbot', 'other'],
  ['diffbot', 'other'],
  ['youbot', 'other'],
  ['webzio', 'other']
];
export const AUTO_TOKENS = ['bot', 'crawl', 'spider', 'curl', 'wget', 'python', 'httpclient', 'headless', 'lighthouse', 'uptime', 'monitor', 'pingdom', 'statuscake', 'axios', 'node-fetch', 'go-http', 'java/', 'okhttp'];

// Returns { cls, purpose }: cls is the published claim class
// (agent-claimed / automation / browser / unknown); purpose is set only
// for agent-claimed records, null otherwise.
export function classify(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return { cls: 'unknown', purpose: null };
  for (const [token, purpose] of AGENT_TOKENS) if (u.includes(token)) return { cls: 'agent-claimed', purpose };
  for (const s of AUTO_TOKENS) if (u.includes(s)) return { cls: 'automation', purpose: null };
  if (u.includes('mozilla') && (u.includes('chrome') || u.includes('safari') || u.includes('firefox') || u.includes('edg'))) return { cls: 'browser', purpose: null };
  return { cls: 'unknown', purpose: null };
}
