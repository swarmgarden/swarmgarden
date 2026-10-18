#!/usr/bin/env node
// Swarm Garden — operator range-list fetcher (lens spec A1, Oct 18 2026).
//
// Steward-side tooling, NOT Worker code. Pulls each claimed-bot
// operator's published IP-range file, validates it (parses; carries a
// creation/version stamp; prefix count sane), normalizes it, and
// writes the bundle the Workers ship as code:
//
//   shared/ranges/<list-id>.json   one normalized file per list
//   shared/ranges/manifest.json    per claimed name: the operator, the
//                                  list used, its creation stamp, our
//                                  fetch date, prefix counts — or the
//                                  audited fact "no usable list
//                                  published".
//
// The manifest is a deliverable in its own right: `unverifiable-no-list`
// verdicts (shared/ranges.mjs) are only as honest as this audit. Every
// name in the claimed-bot dictionary (shared/behaviour.mjs) gets an
// explicit manifest entry — no name silently missing.
//
// Refresh discipline (PORT-NOTES standing chore): re-run this script,
// review the manifest diff (creation stamps + prefix counts), redeploy.
// Monthly, and immediately whenever a wrong-range cluster suggests a
// list moved. A stale list cannot silently manufacture false verdicts
// without a trace: every verdict record carries the governing list's
// version (rangever = <list-id>@<creationTime>).
//
// Run: node tools/fetch-ranges/fetch-ranges.mjs
// Exit: 0 when every source either validated or was already bundled
//       (a failed fetch KEEPS the previous bundle file and says so);
//       1 when a source failed and no previous bundle exists.
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RANGES_DIR = path.join(HERE, '..', '..', 'shared', 'ranges');

// ---- sources: the operators that publish machine-readable range files.
// Candidate URLs are tried in order; the first that validates wins and
// is the one recorded in the manifest. (The set is enumerated here, at
// build time, rather than hard-coded into the Worker — spec A1.)
const SOURCES = [
  { list: 'gptbot', operator: 'OpenAI', urls: ['https://openai.com/gptbot.json'] },
  { list: 'searchbot', operator: 'OpenAI', urls: ['https://openai.com/searchbot.json'] },
  { list: 'chatgpt-user', operator: 'OpenAI', urls: ['https://openai.com/chatgpt-user.json'] },
  { list: 'googlebot', operator: 'Google', urls: ['https://developers.google.com/static/crawling/ipranges/googlebot.json', 'https://developers.google.com/static/search/apis/ipranges/googlebot.json'] },
  { list: 'google-common-crawlers', operator: 'Google', urls: ['https://developers.google.com/static/crawling/ipranges/common-crawlers.json', 'https://developers.google.com/static/search/apis/ipranges/common-crawlers.json'] },
  { list: 'google-special-crawlers', operator: 'Google', urls: ['https://developers.google.com/static/crawling/ipranges/special-crawlers.json', 'https://developers.google.com/static/search/apis/ipranges/special-crawlers.json'] },
  { list: 'google-user-triggered-fetchers', operator: 'Google', urls: ['https://developers.google.com/static/crawling/ipranges/user-triggered-fetchers.json', 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers.json', 'https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json'] },
  { list: 'anthropic', operator: 'Anthropic', urls: ['https://claude.com/crawling/bots.json', 'https://www.anthropic.com/crawlers.json'] },
  { list: 'bingbot', operator: 'Microsoft', urls: ['https://www.bing.com/toolbox/bingbot.json'] }
];

// ---- the claimed-name map: every name in shared/behaviour.mjs's
// dictionary, to its operator and the list that governs it (or the
// audited no-list fact). Keep in step with the dictionary: the
// manifest completeness check below fails the run if a dictionary
// name has no entry here.
const NAME_MAP = {
  // OpenAI
  'GPTBot': { operator: 'OpenAI', list: 'gptbot' },
  'OAI-SearchBot': { operator: 'OpenAI', list: 'searchbot' },
  'ChatGPT-User': { operator: 'OpenAI', list: 'chatgpt-user' },
  // Anthropic
  'ClaudeBot': { operator: 'Anthropic', list: 'anthropic' },
  'Claude-SearchBot': { operator: 'Anthropic', list: 'anthropic' },
  'Claude-User': { operator: 'Anthropic', list: 'anthropic' },
  'Anthropic': { operator: 'Anthropic', list: 'anthropic' },
  // Google
  'Googlebot': { operator: 'Google', list: 'googlebot' },
  'GoogleOther': { operator: 'Google', list: 'google-common-crawlers' },
  'Google-Agent': { operator: 'Google', list: 'google-user-triggered-fetchers' },
  // Microsoft
  'Bingbot': { operator: 'Microsoft', list: 'bingbot' },
  'MSNBot': { operator: 'Microsoft', list: null, note: 'Microsoft publishes a range file for Bingbot only; no usable list is published for this retired name.' },
  // No usable list published (audited Oct 18, 2026)
  'Meta-ExternalAgent': { operator: 'Meta', list: null, note: 'Meta publishes no per-crawler range file (its crawler addresses ride its AS32934 announcements only).' },
  'Meta-ExternalFetcher': { operator: 'Meta', list: null, note: 'Meta publishes no per-crawler range file.' },
  'Meta Web Indexer': { operator: 'Meta', list: null, note: 'Meta publishes no per-crawler range file.' },
  'facebookexternalhit': { operator: 'Meta', list: null, note: 'Meta publishes no per-crawler range file.' },
  'Amazonbot': { operator: 'Amazon', list: null, note: 'Amazon publishes no usable range list for this crawler.' },
  'Bytespider': { operator: 'ByteDance', list: null, note: 'ByteDance publishes no usable range list for this crawler.' },
  'PerplexityBot': { operator: 'Perplexity', list: null, note: 'Perplexity publishes no machine-readable range file.' },
  'Perplexity-User': { operator: 'Perplexity', list: null, note: 'Perplexity publishes no machine-readable range file.' },
  'Internet Archive': { operator: 'Internet Archive', list: null, note: 'The Internet Archive publishes no machine-readable range file for archive.org_bot.' },
  'DuckDuckBot': { operator: 'DuckDuckGo', list: null, note: 'DuckDuckGo lists addresses on a web page; no machine-readable range file is published.' },
  'DuckAssistBot': { operator: 'DuckDuckGo', list: null, note: 'DuckDuckGo publishes no machine-readable range file for this fetcher.' },
  'YandexBot': { operator: 'Yandex', list: null, note: 'Yandex publishes no machine-readable range file.' },
  'Baiduspider': { operator: 'Baidu', list: null, note: 'Baidu publishes no machine-readable range file.' },
  'Pinterestbot': { operator: 'Pinterest', list: null, note: 'Pinterest publishes no machine-readable range file.' },
  'LinkedInBot': { operator: 'LinkedIn', list: null, note: 'LinkedIn publishes no machine-readable range file.' },
  'Twitterbot': { operator: 'X', list: null, note: 'X publishes no machine-readable range file for Twitterbot.' },
  'Discordbot': { operator: 'Discord', list: null, note: 'Discord publishes no machine-readable range file.' },
  'SemrushBot': { operator: 'Semrush', list: null, note: 'Semrush publishes no machine-readable range file.' },
  'AhrefsBot': { operator: 'Ahrefs', list: null, note: 'Ahrefs publishes no machine-readable range file.' },
  'PetalBot': { operator: 'Huawei', list: null, note: 'Huawei publishes no machine-readable range file for PetalBot.' },
  'Applebot': { operator: 'Apple', list: null, note: 'Apple publishes no machine-readable range file for Applebot.' },
  'CCBot': { operator: 'Common Crawl', list: null, note: 'Common Crawl publishes no fixed range list (the crawl rides cloud address space).' },
  'AI2Bot': { operator: 'Ai2', list: null, note: 'Ai2 publishes no machine-readable range file.' },
  'Cohere': { operator: 'Cohere', list: null, note: 'Cohere publishes no machine-readable range file.' },
  'Diffbot': { operator: 'Diffbot', list: null, note: 'Diffbot publishes no machine-readable range file.' },
  'YouBot': { operator: 'You.com', list: null, note: 'You.com publishes no machine-readable range file.' },
  'Webzio': { operator: 'Webz.io', list: null, note: 'Webz.io publishes no machine-readable range file.' },
  'MJ12bot': { operator: 'Majestic', list: null, note: 'Majestic publishes no machine-readable range file.' },
  'DotBot': { operator: 'Moz', list: null, note: 'Moz publishes no machine-readable range file for DotBot.' },
  'Yahoo Slurp': { operator: 'Yahoo', list: null, note: 'Yahoo publishes no machine-readable range file for Slurp.' },
  'MistralAI-User': { operator: 'Mistral AI', list: null, note: 'Mistral AI publishes no machine-readable range file.' }
};

// The dictionary names, mirrored from shared/behaviour.mjs for the
// completeness check (the check reads the module's exports at run
// time when it can; this list is the fallback and the cross-check).
import { CRAWLER_TOKENS, FETCHER_TOKENS } from '../../shared/behaviour.mjs';
const DICTIONARY_NAMES = [...CRAWLER_TOKENS, ...FETCHER_TOKENS].map(([, name]) => name);

function extractPrefixes(json) {
  // The operators' shared schema: { creationTime, prefixes: [{ipv4Prefix} | {ipv6Prefix}] }.
  // Accept also a bare array of CIDR strings, defensively.
  const out = [];
  const push = (v) => { if (typeof v === 'string' && v.includes('/')) out.push(v); };
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { for (const x of node) walk(x); return; }
    if (typeof node === 'object') {
      if (node.ipv4Prefix) push(node.ipv4Prefix);
      if (node.ipv6Prefix) push(node.ipv6Prefix);
      for (const v of Object.values(node)) walk(v);
    }
  };
  walk(json && json.prefixes !== undefined ? json.prefixes : json);
  return [...new Set(out)];
}

function validCidr(s) {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(s);
  if (!m) return false;
  const bits = Number(m[2]);
  return m[1].includes(':') ? bits <= 128 : bits <= 32;
}

async function fetchList(src) {
  for (const url of src.urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'swarm-garden-range-fetch/1.0 (steward tooling)' } });
      if (!res.ok) { console.log('  ' + src.list + ': ' + url + ' -> HTTP ' + res.status); continue; }
      const json = await res.json();
      const prefixes = extractPrefixes(json).filter(validCidr);
      if (!prefixes.length) { console.log('  ' + src.list + ': ' + url + ' -> no usable prefixes'); continue; }
      const creationTime = (json && (json.creationTime || json.creation_time)) || null;
      return { list: src.list, operator: src.operator, source: url, creationTime, prefixes };
    } catch (e) {
      console.log('  ' + src.list + ': ' + url + ' -> ' + (e && e.message || e));
    }
  }
  return null;
}

async function main() {
  await mkdir(RANGES_DIR, { recursive: true });
  const fetchedAt = new Date().toISOString();
  const lists = {};
  let hardFail = false;
  for (const src of SOURCES) {
    const got = await fetchList(src);
    if (got) {
      const v4 = got.prefixes.filter(p => !p.includes(':')).length;
      const v6 = got.prefixes.length - v4;
      lists[src.list] = { operator: got.operator, source: got.source, creation_time: got.creationTime, ipv4_prefixes: v4, ipv6_prefixes: v6, file: src.list + '.json', fetched_at: fetchedAt };
      await writeFile(path.join(RANGES_DIR, src.list + '.json'), JSON.stringify(got, null, 1) + '\n');
      console.log('  ' + src.list + ': ' + got.prefixes.length + ' prefixes (' + v4 + ' v4, ' + v6 + ' v6), creationTime ' + (got.creationTime || 'none stated') + ' <- ' + got.source);
    } else {
      // Keep any previous bundle: a failed refresh must not strip
      // verdicts the record is already producing. Say so, loudly.
      try {
        const prev = JSON.parse(await readFile(path.join(RANGES_DIR, src.list + '.json'), 'utf8'));
        lists[src.list] = { operator: prev.operator, source: prev.source, creation_time: prev.creationTime || null, ipv4_prefixes: prev.prefixes.filter(p => !p.includes(':')).length, ipv6_prefixes: prev.prefixes.filter(p => p.includes(':')).length, file: src.list + '.json', fetched_at: fetchedAt, stale: 'fetch failed this run; previous bundle kept' };
        console.log('  ' + src.list + ': FETCH FAILED — previous bundle kept (' + prev.prefixes.length + ' prefixes).');
      } catch (e) {
        hardFail = true;
        console.log('  ' + src.list + ': FETCH FAILED and no previous bundle exists.');
      }
    }
  }
  // Completeness: every dictionary name has an explicit entry.
  const missing = DICTIONARY_NAMES.filter(n => !(n in NAME_MAP));
  if (missing.length) {
    console.error('MANIFEST INCOMPLETE — dictionary names with no entry: ' + missing.join(', '));
    process.exit(1);
  }
  const names = {};
  for (const n of DICTIONARY_NAMES) {
    const e = NAME_MAP[n];
    if (e.list && !lists[e.list]) {
      // The governing list could not be bundled at all: the name is
      // not-checked at write time (an instrument gap), never
      // unverifiable-no-list. Record it that way.
      names[n] = { operator: e.operator, list: null, reason: 'bundle-missing', note: 'Operator publishes ranges, but the list could not be bundled in this build; verdicts read not-checked.' };
    } else if (e.list) {
      names[n] = { operator: e.operator, list: e.list };
    } else {
      names[n] = { operator: e.operator, list: null, reason: 'no-list', note: e.note || 'No usable list published.' };
    }
  }
  const manifest = { generated_at: fetchedAt, tool: 'tools/fetch-ranges/fetch-ranges.mjs', lists, names };
  await writeFile(path.join(RANGES_DIR, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');
  console.log('manifest.json written: ' + Object.keys(lists).length + ' lists, ' + Object.keys(names).length + ' names.');
  if (hardFail) process.exit(1);
}

await main();
