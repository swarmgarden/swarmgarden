// Swarm Garden — first-party visit logger (ESM + @netlify/blobs)
// Records each request's time, page, referrer, country and user-agent,
// classified by what the user-agent CLAIMS to be. A user-agent is a claim,
// not a proof of identity: labels are agent-claimed / automation / browser / unknown.
// Requests arrive two ways: via=edge (relayed server-side by the request-log
// edge function — sees every fetch, including agents that run no JavaScript)
// and via=beacon (the legacy in-page snippet; kept for compatibility).
import { getStore } from '@netlify/blobs';
const AGENT_UA = ['gptbot','chatgpt-user','claudebot','claude-user','claude-searchbot','anthropic','perplexitybot','perplexity-user','oai-searchbot','ccbot','bytespider','google-extended','meta-externalagent','cohere-ai','mistralai-user','ai2bot','diffbot','youbot','amazonbot','applebot-extended','duckassistbot','webzio'];
const AUTO_UA = ['bot','crawl','spider','curl','wget','python','httpclient','headless','lighthouse','uptime','monitor','pingdom','statuscake','axios','node-fetch','go-http','java/','okhttp'];
function classify(ua) {
  const u = (ua || '').toLowerCase();
  if (!u) return 'unknown';
  for (const s of AGENT_UA) if (u.includes(s)) return 'agent-claimed';
  for (const s of AUTO_UA) if (u.includes(s)) return 'automation';
  if (u.includes('mozilla') && (u.includes('chrome') || u.includes('safari') || u.includes('firefox') || u.includes('edg'))) return 'browser';
  return 'unknown';
}
export default async (req, context) => {
  if (req.method !== 'POST') return new Response('', { status: 405 });
  let path = '/', ref = '', ua = '', via = 'beacon';
  try {
    const b = await req.json();
    path = b.p || '/'; ref = b.r || '';
    if (typeof b.ua === 'string' && b.ua) ua = b.ua.slice(0, 400);
    if (b.via === 'edge') via = 'edge';
  } catch (e) {}
  if (!ua) ua = req.headers.get('user-agent') || '';
  const record = {
    t: new Date().toISOString(),
    site: req.headers.get('host') || '',
    path, ref,
    country: (context && context.geo && context.geo.country && context.geo.country.code) || req.headers.get('x-nf-country') || '',
    ua,
    cls: classify(ua),
    via
  };
  try {
    const s = getStore('visits');
    const key = 'v-' + record.t.replace(/[:.]/g, '') + '-' + Math.random().toString(36).slice(2, 8);
    await s.setJSON(key, record);
    record.stored = 'blobs-sdk';
  } catch (e) { record.stored = 'sdk-error:' + (e && e.name ? e.name : 'unknown'); }
  console.log('VISIT ' + JSON.stringify(record));
  return new Response(null, { status: 204 });
};
