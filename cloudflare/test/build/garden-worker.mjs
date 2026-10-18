// ../shared/taxonomy.mjs
var AGENT_TOKENS = [
  // token, purpose
  ["gptbot", "training"],
  ["claudebot", "training"],
  ["anthropic", "training"],
  ["ccbot", "training"],
  ["bytespider", "training"],
  ["meta-externalagent", "training"],
  ["ai2bot", "training"],
  ["cohere-ai", "training"],
  ["oai-searchbot", "search"],
  ["claude-searchbot", "search"],
  ["perplexitybot", "search"],
  ["chatgpt-user", "user-triggered"],
  ["claude-user", "user-triggered"],
  ["perplexity-user", "user-triggered"],
  ["meta-externalfetcher", "user-triggered"],
  ["google-agent", "user-triggered"],
  ["mistralai-user", "user-triggered"],
  ["duckassistbot", "user-triggered"],
  ["googleother", "other"],
  ["amazonbot", "other"],
  ["diffbot", "other"],
  ["youbot", "other"],
  ["webzio", "other"]
];
var AUTO_TOKENS = ["bot", "crawl", "spider", "curl", "wget", "python", "httpclient", "headless", "lighthouse", "uptime", "monitor", "pingdom", "statuscake", "axios", "node-fetch", "go-http", "java/", "okhttp"];
function classify(ua) {
  const u = (ua || "").toLowerCase();
  if (!u) return { cls: "unknown", purpose: null };
  for (const [token, purpose] of AGENT_TOKENS) if (u.includes(token)) return { cls: "agent-claimed", purpose };
  for (const s of AUTO_TOKENS) if (u.includes(s)) return { cls: "automation", purpose: null };
  if (u.includes("mozilla") && (u.includes("chrome") || u.includes("safari") || u.includes("firefox") || u.includes("edg"))) return { cls: "browser", purpose: null };
  return { cls: "unknown", purpose: null };
}

// ../shared/visits.mjs
var AE_BLOBS = ["t", "path", "ref", "country", "ua", "cls", "purpose", "method", "ba", "via", "event", "region", "asn", "asOrganization"];
function aeConfigured(env) {
  return !!(env && env.AE_API_TOKEN && env.AE_ACCOUNT_ID && env.AE_DATASET);
}
async function writeVisit(env, record) {
  if (aeConfigured(env)) {
    env.VISITS.writeDataPoint({
      indexes: [record.site || ""],
      blobs: AE_BLOBS.map((k) => {
        const v = record[k];
        return v === null || v === void 0 ? "" : String(v);
      }),
      doubles: [
        Number.isInteger(record.status) ? record.status : -1,
        record.md === 0 || record.md === 1 ? record.md : -1
      ]
    });
    return "analytics-engine";
  }
  await env.DB.prepare("INSERT INTO visit_log (t, data) VALUES (?1, ?2)").bind(record.t, JSON.stringify(record)).run();
  return "d1-fallback";
}
async function readFromD1(env, limit) {
  const { results } = await env.DB.prepare("SELECT data FROM visit_log ORDER BY id DESC LIMIT ?1").bind(limit).all();
  return (results || []).map((r) => {
    try {
      return JSON.parse(r.data);
    } catch (e) {
      return null;
    }
  }).filter(Boolean);
}
async function readFromAE(env, limit) {
  const cols = AE_BLOBS.map((_, i) => "blob" + (i + 1)).join(", ");
  const sql = "SELECT " + cols + ", double1, double2 FROM " + env.AE_DATASET + " WHERE index1 = '" + String(env.SITE_HOST || "").replace(/'/g, "") + "' ORDER BY blob1 DESC LIMIT " + Number(limit);
  const res = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + env.AE_ACCOUNT_ID + "/analytics_engine/sql",
    { method: "POST", headers: { "Authorization": "Bearer " + env.AE_API_TOKEN, "Content-Type": "text/plain" }, body: sql }
  );
  if (!res.ok) throw new Error("Analytics Engine query failed: " + res.status);
  const json = await res.json();
  const rows = json && json.data || [];
  return rows.map((row) => {
    const rec = {};
    AE_BLOBS.forEach((k, i) => {
      const v = row["blob" + (i + 1)];
      rec[k] = v === "" ? ["purpose", "method", "ba"].includes(k) ? null : "" : v;
    });
    rec.status = row.double1 === -1 ? null : row.double1;
    rec.md = row.double2 === -1 ? null : row.double2;
    rec.site = env.SITE_HOST || "";
    return rec;
  });
}
async function readRecentVisits(env, limit) {
  if (aeConfigured(env)) return readFromAE(env, limit);
  return readFromD1(env, limit);
}

// ../shared/frontdoor.mjs
var SKIP_EXT = [".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".css", ".js", ".map", ".woff", ".woff2", ".mp4", ".zip"];
var LINK_HEADER = '</llms.txt>; rel="alternate"; type="text/markdown", </sitemap.xml>; rel="sitemap"; type="application/xml", </.well-known/agent-skills/index.json>; rel="agent-skills"';
function qFor(entries, type, subtype) {
  let exact = null, typeWild = null, allWild = null;
  for (const [t, s, q] of entries) {
    if (t === type && s === subtype) exact = q;
    else if (t === type && s === "*") typeWild = q;
    else if (t === "*" && s === "*") allWild = q;
  }
  if (exact !== null) return { q: exact, explicit: true };
  if (typeWild !== null) return { q: typeWild, explicit: false };
  if (allWild !== null) return { q: allWild, explicit: false };
  return { q: 0, explicit: false };
}
function prefersMarkdown(accept) {
  if (!accept) return false;
  const entries = accept.split(",").map((part) => {
    const [mime, ...params] = part.trim().split(";");
    const [t, s] = (mime || "").toLowerCase().split("/");
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split("=");
      if (k === "q") q = parseFloat(v) || 0;
    }
    return [t || "", s || "", q];
  });
  const md = qFor(entries, "text", "markdown");
  if (md.q <= 0) return false;
  if (!md.explicit) return false;
  const htmlQ = Math.max(qFor(entries, "text", "html").q, qFor(entries, "application", "xhtml+xml").q);
  return md.q >= htmlQ;
}
function twinPath(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "/index.md";
  if (pathname.endsWith(".html")) return pathname.slice(0, -5) + ".md";
  if (!pathname.includes(".")) return pathname.replace(/\/$/, "") + ".md";
  return null;
}
function botAuthState(req) {
  const present = !!(req.headers.get("signature") || req.headers.get("signature-input") || req.headers.get("signature-agent"));
  const bm = req.cf && req.cf.botManagement || null;
  if (bm && bm.verifiedBot) return "verified";
  return present ? "present" : "absent";
}
function buildVisitRecord(req, res, siteHost, event) {
  const url = new URL(req.url);
  const ua = (req.headers.get("user-agent") || "").slice(0, 400);
  const { cls, purpose } = classify(ua);
  return {
    t: (/* @__PURE__ */ new Date()).toISOString(),
    site: siteHost,
    path: url.pathname,
    ref: req.headers.get("referer") || "",
    country: req.cf && req.cf.country || "",
    region: req.cf && (req.cf.region || req.cf.regionCode) || "",
    asn: req.cf && req.cf.asn || "",
    asOrganization: req.cf && req.cf.asOrganization || "",
    ua,
    cls,
    purpose,
    method: req.method,
    status: res.status,
    md: prefersMarkdown(req.headers.get("accept")) ? 1 : 0,
    ba: botAuthState(req),
    via: "edge",
    event: event || "pageview"
  };
}
function shouldLog(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const p = new URL(req.url).pathname;
  if (p.startsWith("/.netlify/")) return false;
  if (SKIP_EXT.some((e) => p.endsWith(e))) return false;
  return true;
}
function eventForPath(pathname) {
  if (pathname === "/dashboard.html") return "arrival-board-view";
  if (pathname.startsWith("/.netlify/functions/stats")) return "dashboard-use";
  return "pageview";
}
async function servePage(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const negotiable = (req.method === "GET" || req.method === "HEAD") && !p.startsWith("/.netlify/") && !p.startsWith("/.well-known/") && !/\.(md|txt|xml|json|svg|jpg|jpeg|png|webp|gif|ico|css|js|map)$/i.test(p);
  if (negotiable && prefersMarkdown(req.headers.get("accept"))) {
    const twin = twinPath(p);
    if (twin) {
      const twinRes = await env.ASSETS.fetch(new Request(new URL(twin, url), { method: "GET" }));
      if (twinRes.ok) {
        const body = await twinRes.text();
        const headers = new Headers();
        headers.set("Content-Type", "text/markdown; charset=utf-8");
        headers.set("Vary", "Accept");
        headers.set("Cache-Control", "private, no-store");
        headers.set("X-Markdown-Tokens", String(Math.ceil(body.length / 4)));
        headers.set("Link", "<" + twin + '>; rel="alternate"; type="text/markdown"');
        if (req.method === "HEAD") return new Response(null, { status: 200, headers });
        return new Response(body, { status: 200, headers });
      }
    }
  }
  return env.ASSETS.fetch(req);
}
async function injectCounts(res, getArrivals, getUpdated, getVisits, getCounterBlock, getWindow, getAgentClaimed, getHumans) {
  try {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return res;
    const n = await getArrivals();
    if (typeof n !== "number") return res;
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.delete("content-length");
    headers.delete("etag");
    const rw = new HTMLRewriter().on('span[data-count="arrivals"]', {
      element(el) {
        el.setInnerContent(String(n));
      }
    }).on('span[data-when-zero="arrivals"]', {
      element(el) {
        if (n > 0) el.setInnerContent("");
      }
    });
    if (typeof getCounterBlock === "function") {
      const block = await getCounterBlock();
      if (typeof block === "string" && block) {
        rw.on("[data-counter-block]", {
          element(el) {
            el.setInnerContent(block, { html: true });
          }
        });
      }
    }
    if (typeof getUpdated === "function") {
      const u = await getUpdated();
      if (typeof u === "string" && u) {
        rw.on('span[data-count="updated"]', {
          element(el) {
            el.setInnerContent(u);
          }
        });
      }
    }
    if (typeof getVisits === "function") {
      const v = await getVisits();
      if (typeof v === "number") {
        rw.on('span[data-count="visits"]', {
          element(el) {
            el.setInnerContent(String(v));
          }
        });
      }
    }
    if (typeof getWindow === "function") {
      const w = await getWindow();
      if (typeof w === "string" && w) {
        rw.on('span[data-count="window"]', {
          element(el) {
            el.setInnerContent(w);
          }
        });
      }
    }
    if (typeof getAgentClaimed === "function") {
      const a = await getAgentClaimed();
      if (typeof a === "number") {
        rw.on('span[data-count="agent-claimed"]', {
          element(el) {
            el.setInnerContent(String(a));
          }
        });
      }
    }
    if (typeof getHumans === "function") {
      const h = await getHumans();
      if (typeof h === "number") {
        rw.on('span[data-count="humans"]', {
          element(el) {
            el.setInnerContent(String(h));
          }
        });
      }
    }
    return rw.transform(new Response(res.body, { status: res.status, headers }));
  } catch (e) {
    return res;
  }
}
var COUNTER_MARKER = "<!-- live-counter -->";
async function injectCounterText(res, getCounterText) {
  try {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/markdown")) return res;
    const text = await res.text();
    if (!text.includes(COUNTER_MARKER)) return new Response(text, { status: res.status, headers: res.headers });
    const replacement = await getCounterText();
    const body = text.split(COUNTER_MARKER).join(typeof replacement === "string" ? replacement : "");
    const headers = new Headers(res.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(body, { status: res.status, headers });
  } catch (e) {
    return res;
  }
}
async function frontDoor(req, env, ctx, res, opts) {
  let out = res;
  const url = new URL(req.url);
  if (!out.headers.get("link") && !url.pathname.startsWith("/.well-known/")) {
    const headers = new Headers(out.headers);
    headers.set("Link", LINK_HEADER);
    out = new Response(out.body, { status: out.status, headers });
  }
  if (req.method === "GET" && opts && opts.getArrivals) {
    out = await injectCounts(out, opts.getArrivals, opts.getUpdated, opts.getVisits, opts.getCounterBlock, opts.getWindow, opts.getAgentClaimed, opts.getHumans);
  }
  if (req.method === "GET" && opts && typeof opts.getCounterText === "function") {
    out = await injectCounterText(out, opts.getCounterText);
  }
  if (shouldLog(req)) {
    const record = buildVisitRecord(req, out, opts.siteHost, eventForPath(url.pathname));
    const write = writeVisit(env, record).then(() => {
      try {
        console.log("VISIT " + JSON.stringify(record));
      } catch (e) {
      }
    }).catch(() => {
    });
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(write);
    else await write;
  }
  return out;
}

// ../shared/counting.mjs
var COUNTING_SINCE = "2026-10-17T21:38:49Z";
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function countingDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear();
}
function countingParts(sinceIso, now) {
  const since = new Date(sinceIso);
  if (isNaN(since)) return null;
  const at = now ? new Date(now) : /* @__PURE__ */ new Date();
  const ms = at - since;
  if (!(ms >= 0)) return null;
  const hours = Math.floor(ms / 36e5);
  let age;
  if (hours < 48) {
    age = hours <= 1 ? "the first hour of counting" : "the first " + hours + " hours of counting";
  } else {
    const days = Math.floor(hours / 24);
    age = "this record is " + days + (days === 1 ? " day" : " days") + " old";
  }
  return { date: countingDate(sinceIso), age };
}

// ../garden/src/lib/db.js
var parse = (s) => {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
};
async function dbPutReceipt(db, r) {
  await db.prepare(
    "INSERT INTO receipts (number, channel, format, brief_id, fingerprint, state, received_at, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(number) DO UPDATE SET channel=excluded.channel, format=excluded.format, brief_id=excluded.brief_id, fingerprint=excluded.fingerprint, state=excluded.state, received_at=excluded.received_at, data=excluded.data"
  ).bind(r.number, r.channel, r.format || null, r.brief_id || null, r.fingerprint || null, r.state || null, r.received_at || null, JSON.stringify(r)).run();
}
async function dbGetReceipt(db, number) {
  const row = await db.prepare("SELECT data FROM receipts WHERE number = ?1").bind(String(number)).first();
  return row ? parse(row.data) : null;
}
async function dbListReceipts(db) {
  const { results } = await db.prepare("SELECT data FROM receipts ORDER BY number ASC").all();
  return (results || []).map((r) => parse(r.data)).filter(Boolean);
}
async function dbFindReceiptByFingerprint(db, channel, fingerprint) {
  const row = await db.prepare("SELECT data FROM receipts WHERE channel = ?1 AND fingerprint = ?2 ORDER BY number ASC LIMIT 1").bind(channel, fingerprint).first();
  return row ? parse(row.data) : null;
}
async function dbCountBriefReadAnswers(db, briefId) {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM receipts WHERE channel = 'answers' AND format = 'answer' AND brief_id = ?1 AND state != 'over-cap-unread'"
  ).bind(briefId).first();
  return row ? Number(row.n) || 0 : 0;
}
async function dbBriefCounters(db) {
  const { results } = await db.prepare(
    "SELECT brief_id, COUNT(*) AS total, SUM(CASE WHEN state != 'over-cap-unread' THEN 1 ELSE 0 END) AS read_n FROM receipts WHERE channel = 'answers' AND format = 'answer' AND brief_id IS NOT NULL GROUP BY brief_id"
  ).all();
  return results || [];
}
async function dbMaxReceiptNumber(db) {
  const row = await db.prepare("SELECT MAX(CAST(number AS INTEGER)) AS m FROM receipts").first();
  return row && row.m ? Number(row.m) : 0;
}
async function dbInsertLedger(db, entry) {
  await db.prepare("INSERT INTO ledger_entries (n, ts, kind, receipt, data) VALUES (?1,?2,?3,?4,?5)").bind(entry.n, entry.ts, entry.kind || null, entry.receipt || null, JSON.stringify(entry)).run();
}
async function dbListLedger(db) {
  const { results } = await db.prepare("SELECT data FROM ledger_entries ORDER BY n ASC").all();
  return (results || []).map((r) => parse(r.data)).filter(Boolean);
}
async function dbLedgerCounts(db) {
  const row = await db.prepare("SELECT COUNT(*) AS entries, SUM(CASE WHEN kind = 'arrival' THEN 1 ELSE 0 END) AS arrivals FROM ledger_entries").first();
  return { entries: row ? Number(row.entries) || 0 : 0, arrivals: row ? Number(row.arrivals) || 0 : 0 };
}
async function dbMaxLedgerNumber(db) {
  const row = await db.prepare("SELECT MAX(n) AS m FROM ledger_entries").first();
  return row && row.m ? Number(row.m) : 0;
}
async function dbGetBrief(db, briefId) {
  const row = await db.prepare("SELECT data FROM briefs WHERE brief_id = ?1").bind(briefId).first();
  return row ? parse(row.data) : null;
}
async function dbPutBrief(db, brief) {
  await db.prepare("INSERT INTO briefs (brief_id, data) VALUES (?1,?2) ON CONFLICT(brief_id) DO UPDATE SET data = excluded.data").bind(brief.brief_id, JSON.stringify(brief)).run();
}
async function dbListBriefs(db) {
  const { results } = await db.prepare("SELECT data FROM briefs ORDER BY brief_id ASC").all();
  return (results || []).map((r) => parse(r.data)).filter(Boolean);
}
async function dbInsertNote(db, n) {
  await db.prepare(
    "INSERT INTO guestbook_notes (number, name_claim, message, received_at, publish_at, status, flags, data) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)"
  ).bind(n.number, n.name_claim, n.message, n.received_at, n.publish_at, n.status, JSON.stringify(n.flags || []), JSON.stringify(n)).run();
}
async function dbUpdateNote(db, n) {
  await db.prepare(
    "UPDATE guestbook_notes SET name_claim=?2, message=?3, received_at=?4, publish_at=?5, status=?6, flags=?7, data=?8 WHERE number=?1"
  ).bind(n.number, n.name_claim, n.message, n.received_at, n.publish_at, n.status, JSON.stringify(n.flags || []), JSON.stringify(n)).run();
}
async function dbGetNote(db, number) {
  const row = await db.prepare("SELECT data FROM guestbook_notes WHERE number = ?1").bind(String(number)).first();
  return row ? parse(row.data) : null;
}
async function dbListNotes(db) {
  const { results } = await db.prepare("SELECT data FROM guestbook_notes ORDER BY number ASC").all();
  return (results || []).map((r) => parse(r.data)).filter(Boolean);
}
async function dbMaxNoteNumber(db) {
  const row = await db.prepare("SELECT MAX(CAST(number AS INTEGER)) AS m FROM guestbook_notes").first();
  return row && row.m ? Number(row.m) : 0;
}
async function dbPutSignalChallenge(db, c) {
  await db.prepare("INSERT INTO signal_challenges (nonce_digest, expires_at, created_at, consumed_at) VALUES (?1,?2,?3,?4)").bind(c.nonce_digest, c.expires_at, c.created_at, c.consumed_at || null).run();
}
async function dbGetSignalChallenge(db, digest) {
  const row = await db.prepare("SELECT nonce_digest, expires_at, created_at, consumed_at FROM signal_challenges WHERE nonce_digest = ?1").bind(String(digest)).first();
  return row || null;
}
async function dbConsumeSignalChallenge(db, digest, at) {
  const r = await db.prepare("UPDATE signal_challenges SET consumed_at = ?2 WHERE nonce_digest = ?1 AND consumed_at IS NULL").bind(String(digest), at).run();
  return !!(r && r.meta && r.meta.changes === 1);
}
async function dbPruneSignalChallenges(db, nowIso) {
  await db.prepare("DELETE FROM signal_challenges WHERE expires_at < ?1").bind(nowIso).run();
}
async function dbInsertSignal(db, s) {
  await db.prepare("INSERT INTO signals (number, name_claim, signalled_at, data) VALUES (?1,?2,?3,?4)").bind(s.number, s.name_claim, s.signalled_at, JSON.stringify(s)).run();
}
async function dbCountSignals(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM signals").first();
  return row ? Number(row.n) || 0 : 0;
}
async function dbMaxSignalNumber(db) {
  const row = await db.prepare("SELECT MAX(CAST(number AS INTEGER)) AS m FROM signals").first();
  return row && row.m ? Number(row.m) : 0;
}
async function dbRecordHumanPress(db, rec, digest) {
  try {
    await db.batch([
      db.prepare("INSERT INTO human_presses (number, pressed_at, data) VALUES (?1,?2,?3)").bind(rec.number, rec.pressed_at, JSON.stringify(rec)),
      db.prepare("INSERT INTO human_press_dedupe (digest, day, number) VALUES (?1,?2,?3)").bind(digest, rec.day, rec.number)
    ]);
    return true;
  } catch (e) {
    return false;
  }
}
async function dbGetHumanDedupe(db, digest, day) {
  const row = await db.prepare("SELECT number FROM human_press_dedupe WHERE digest = ?1 AND day = ?2").bind(String(digest), String(day)).first();
  return row || null;
}
async function dbPruneHumanDedupe(db, today) {
  await db.prepare("DELETE FROM human_press_dedupe WHERE day < ?1").bind(String(today)).run();
}
async function dbCountHumanPresses(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM human_presses").first();
  return row ? Number(row.n) || 0 : 0;
}
async function dbMaxHumanPressNumber(db) {
  const row = await db.prepare("SELECT MAX(CAST(number AS INTEGER)) AS m FROM human_presses").first();
  return row && row.m ? Number(row.m) : 0;
}
async function dbGetState(db, key) {
  const row = await db.prepare("SELECT data FROM garden_state WHERE key = ?1").bind(key).first();
  return row ? parse(row.data) : null;
}
async function dbSetState(db, key, value) {
  await db.prepare("INSERT INTO garden_state (key, data) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data = excluded.data").bind(key, JSON.stringify(value)).run();
}

// ../shared/behaviour.mjs
var INTEREST = ["llms.txt", "robots.txt", "agent-skills", "agent-card", "security.txt", "sitemap"];
var PROBE_RE = /(\.env|\.git\/|xmlrpc|wp-admin|wp-login|\.php([?#]|$)|proc\/self|@fs|phpunit|\.aws|\.svn|boaform|hnap1|actuator|server-status|\.bak|\.sql|config\.php)/i;
function behaviourLabel(r) {
  const p = r && r.path || "";
  if (PROBE_RE.test(p)) return "probe-path";
  if (INTEREST.some((s) => p.includes(s)) || p.includes("agent-card")) return "discovery";
  if (/(participate|briefs|questions|reports|registry|record|receipts|utilities|changed)/.test(p)) return "protocol-read";
  return "read";
}
var CRAWLER_TOKENS = [
  // token, published name
  ["claude-searchbot", "Claude-SearchBot"],
  ["oai-searchbot", "OAI-SearchBot"],
  ["meta-externalagent", "Meta-ExternalAgent"],
  ["meta-webindexer", "Meta Web Indexer"],
  ["perplexitybot", "PerplexityBot"],
  ["facebookexternalhit", "facebookexternalhit"],
  ["archive.org_bot", "Internet Archive"],
  ["claudebot", "ClaudeBot"],
  ["googlebot", "Googlebot"],
  ["amazonbot", "Amazonbot"],
  ["bytespider", "Bytespider"],
  ["duckduckbot", "DuckDuckBot"],
  ["yandexbot", "YandexBot"],
  ["baiduspider", "Baiduspider"],
  ["pinterestbot", "Pinterestbot"],
  ["linkedinbot", "LinkedInBot"],
  ["twitterbot", "Twitterbot"],
  ["discordbot", "Discordbot"],
  ["googleother", "GoogleOther"],
  ["semrushbot", "SemrushBot"],
  ["ahrefsbot", "AhrefsBot"],
  ["petalbot", "PetalBot"],
  ["applebot", "Applebot"],
  ["bingbot", "Bingbot"],
  ["gptbot", "GPTBot"],
  ["ccbot", "CCBot"],
  ["ai2bot", "AI2Bot"],
  ["cohere-ai", "Cohere"],
  ["diffbot", "Diffbot"],
  ["youbot", "YouBot"],
  ["webzio", "Webzio"],
  ["mj12bot", "MJ12bot"],
  ["dotbot", "DotBot"],
  ["msnbot", "MSNBot"],
  ["slurp", "Yahoo Slurp"],
  ["anthropic", "Anthropic"]
];
var FETCHER_TOKENS = [
  // token, published name
  ["meta-externalfetcher", "Meta-ExternalFetcher"],
  ["perplexity-user", "Perplexity-User"],
  ["chatgpt-user", "ChatGPT-User"],
  ["claude-user", "Claude-User"],
  ["google-agent", "Google-Agent"],
  ["mistralai-user", "MistralAI-User"],
  ["duckassistbot", "DuckAssistBot"]
];
function claimedBot(ua) {
  const u = (ua || "").toLowerCase();
  if (!u) return null;
  if (u.includes("google-extended") || u.includes("applebot-extended")) return null;
  for (const [token, name] of CRAWLER_TOKENS) if (u.includes(token)) return { kind: "crawler", name };
  for (const [token, name] of FETCHER_TOKENS) if (u.includes(token)) return { kind: "fetcher", name };
  return null;
}

// ../garden/src/routes/counts.js
var VISITS_WINDOW = 1500;
var INTEREST2 = ["llms.txt", "robots.txt", "agent-skills", "agent-card", "security.txt", "sitemap"];
async function readLedger(env) {
  const entries = await dbListLedger(env.DB);
  const arrivalReceipts = [];
  let arrivals = 0;
  for (const e of entries) {
    if (e.kind === "arrival") {
      arrivals++;
      if (e.receipt) arrivalReceipts.push(e.receipt);
    }
  }
  return { entries: entries.length, arrivals, arrivalReceipts };
}
async function countOverCap(env, receiptNumbers) {
  if (!receiptNumbers.length) return 0;
  let n = 0;
  for (const num of receiptNumbers) {
    try {
      const r = await dbGetReceipt(env.DB, num);
      if (r && r.state === "over-cap-unread") n++;
    } catch (e) {
    }
  }
  return n;
}
async function readVisits(env) {
  const recs = await readRecentVisits(env, VISITS_WINDOW);
  const byClass = {}, byPath = {}, interest = {}, crawlers = {}, fetchers = {};
  let total = 0;
  for (const r of recs) {
    total++;
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (INTEREST2.some((x) => (r.path || "").includes(x))) interest[r.path] = (interest[r.path] || 0) + 1;
    const bot = claimedBot(r.ua);
    if (bot && bot.kind === "crawler") crawlers[bot.name] = (crawlers[bot.name] || 0) + 1;
    else if (bot && bot.kind === "fetcher") fetchers[bot.name] = (fetchers[bot.name] || 0) + 1;
  }
  const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
  const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
  return {
    total,
    byClass,
    topPaths: top(byPath, 10),
    interest: top(interest, 10),
    crawlersClaimed: { total: sum(crawlers), by_name: top(crawlers, 10) },
    fetchersClaimed: { total: sum(fetchers), by_name: top(fetchers, 10) }
  };
}
async function computeCounts(env) {
  const out = {
    arrivals_on_record: 0,
    arrivals_over_cap_unread: 0,
    ledger_entries: 0,
    signals_total: 0,
    humans_total: 0,
    visits_total: 0,
    visits_by_class: {},
    crawlers_claimed: { total: 0, by_name: {} },
    fetchers_claimed: { total: 0, by_name: {} },
    visits_window_records: VISITS_WINDOW,
    visits_window_note: "Visit totals are computed over the most recent " + VISITS_WINDOW + " visit records.",
    counting_since: COUNTING_SINCE,
    updated: (/* @__PURE__ */ new Date()).toISOString()
  };
  try {
    const l = await readLedger(env);
    out.arrivals_on_record = l.arrivals;
    out.ledger_entries = l.entries;
    out.arrivals_over_cap_unread = await countOverCap(env, l.arrivalReceipts);
  } catch (e) {
    out.ledger_error = "Ledger store unavailable.";
  }
  try {
    out.signals_total = await dbCountSignals(env.DB);
  } catch (e) {
    out.signals_error = "Signal store unavailable.";
  }
  try {
    out.humans_total = await dbCountHumanPresses(env.DB);
  } catch (e) {
    out.humans_error = "Human count store unavailable.";
  }
  try {
    const v = await readVisits(env);
    out.visits_total = v.total;
    out.visits_by_class = v.byClass;
    out.crawlers_claimed = v.crawlersClaimed;
    out.fetchers_claimed = v.fetchersClaimed;
    out.top_paths = v.topPaths;
    out.agent_interest_files = v.interest;
  } catch (e) {
    out.visits_error = "Visit store unavailable.";
  }
  return out;
}
var counts_default = async (req, env) => {
  const out = await computeCounts(env);
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }
  });
};

// ../garden/src/lib/sequencer.js
var Sequencer = class {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ready = null;
  }
  async ensureInit() {
    if (!this.ready) {
      this.ready = (async () => {
        const done = await this.state.storage.get("init-v1");
        if (done) return;
        const db = this.env.DB;
        const seed = {
          nextReceipt: await dbMaxReceiptNumber(db) + 1,
          nextLedger: await dbMaxLedgerNumber(db) + 1,
          nextNote: await dbMaxNoteNumber(db) + 1,
          briefs: {}
        };
        for (const row of await dbBriefCounters(db)) {
          seed.briefs[row.brief_id] = { total: Number(row.total) || 0, read: Number(row.read_n) || 0 };
        }
        await this.state.storage.put("counters", seed);
        await this.state.storage.put("init-v1", true);
      })();
    }
    return this.ready;
  }
  async counters() {
    await this.ensureInit();
    return await this.state.storage.get("counters") || { nextReceipt: 1, nextLedger: 1, briefs: {} };
  }
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const out = (obj) => new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/rate") {
      const k = "rate:" + String(body.key || "");
      const windowMs = Number(body.window_ms) || 6e4;
      const now = Date.now();
      let rec = await this.state.storage.get(k);
      if (!rec || now - rec.start > windowMs) rec = { start: now, count: 0 };
      rec.count++;
      await this.state.storage.put(k, rec);
      return out({ count: rec.count });
    }
    const c = await this.counters();
    if (url.pathname === "/next-receipt") {
      const n = c.nextReceipt;
      c.nextReceipt = n + 1;
      await this.state.storage.put("counters", c);
      return out({ n });
    }
    if (url.pathname === "/next-ledger") {
      const n = c.nextLedger;
      c.nextLedger = n + 1;
      await this.state.storage.put("counters", c);
      return out({ n });
    }
    if (url.pathname === "/next-note") {
      if (!Number.isInteger(c.nextNote)) {
        c.nextNote = await dbMaxNoteNumber(this.env.DB) + 1;
      }
      const n = c.nextNote;
      c.nextNote = n + 1;
      await this.state.storage.put("counters", c);
      return out({ n });
    }
    if (url.pathname === "/next-signal") {
      if (!Number.isInteger(c.nextSignal)) {
        c.nextSignal = await dbMaxSignalNumber(this.env.DB) + 1;
      }
      const n = c.nextSignal;
      c.nextSignal = n + 1;
      await this.state.storage.put("counters", c);
      return out({ n });
    }
    if (url.pathname === "/next-human") {
      if (!Number.isInteger(c.nextHuman)) {
        c.nextHuman = await dbMaxHumanPressNumber(this.env.DB) + 1;
      }
      const n = c.nextHuman;
      c.nextHuman = n + 1;
      await this.state.storage.put("counters", c);
      return out({ n });
    }
    if (url.pathname === "/brief-begin") {
      const id = String(body.brief_id || "");
      const b = c.briefs[id] || (c.briefs[id] = { total: 0, read: 0 });
      const over = !!body.force_over_cap || Number.isInteger(body.cap) && b.read >= body.cap;
      b.total++;
      if (!over) b.read++;
      await this.state.storage.put("counters", c);
      return out({ over_cap: over, position: b.total });
    }
    if (url.pathname === "/brief-release") {
      const id = String(body.brief_id || "");
      const b = c.briefs[id];
      if (b) {
        b.total = Math.max(0, b.total - 1);
        if (!body.was_over_cap) b.read = Math.max(0, b.read - 1);
        await this.state.storage.put("counters", c);
      }
      return out({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
};
function sequencerStub(env) {
  const id = env.SEQUENCER.idFromName("garden");
  return env.SEQUENCER.get(id);
}
async function call(env, path, body) {
  const res = await sequencerStub(env).fetch("https://sequencer" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  return res.json();
}
var seqNextReceipt = (env) => call(env, "/next-receipt").then((r) => r.n);
var seqNextLedger = (env) => call(env, "/next-ledger").then((r) => r.n);
var seqNextNote = (env) => call(env, "/next-note").then((r) => r.n);
var seqNextSignal = (env) => call(env, "/next-signal").then((r) => r.n);
var seqNextHuman = (env) => call(env, "/next-human").then((r) => r.n);
var seqBriefBegin = (env, briefId, cap, forceOverCap) => call(env, "/brief-begin", { brief_id: briefId, cap: cap ?? null, force_over_cap: !!forceOverCap }).then((r) => ({ over_cap: !!r.over_cap, position: r.position }));
var seqBriefRelease = (env, briefId, wasOverCap) => call(env, "/brief-release", { brief_id: briefId, was_over_cap: !!wasOverCap });
var seqRate = (env, key, windowMs) => call(env, "/rate", { key, window_ms: windowMs }).then((r) => r.count);

// ../garden/src/routes/ledger.js
var KINDS = ["arrival", "note", "disposition", "registry", "report"];
var STATES = ["received", "held", "disposition-published", "over-cap-unread", "answered-privately", "listed", "lapsed", "refreshed", "withdrawn"];
var JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
function validate(body) {
  if (!body || typeof body !== "object") return "Body must be a JSON object.";
  if (!KINDS.includes(body.kind)) return "kind must be one of: " + KINDS.join(", ") + ".";
  if (typeof body.summary !== "string" || body.summary.trim().length === 0 || body.summary.length > 500) return "summary is required (1-500 characters).";
  if (body.claim !== void 0 && (typeof body.claim !== "string" || body.claim.length > 200)) return "claim must be a string of at most 200 characters.";
  if (body.level !== void 0 && (!Number.isInteger(body.level) || body.level < 0 || body.level > 3)) return "level must be an integer 0-3.";
  if (body.kind === "disposition") {
    if (!STATES.includes(body.state)) return "a disposition requires a state word from the published vocabulary: " + STATES.join(", ") + ".";
  } else if (body.state !== void 0 && !STATES.includes(body.state)) {
    return "state must be one of the published state words.";
  }
  if (body.receipt !== void 0 && (typeof body.receipt !== "string" || body.receipt.length > 100)) return "receipt must be a string of at most 100 characters.";
  return null;
}
var ledger_default = async (req, env) => {
  if (req.method === "GET") {
    try {
      const entries = await dbListLedger(env.DB);
      const arrivals = entries.filter((e) => e.kind === "arrival").length;
      return new Response(JSON.stringify({ arrivals_on_record: arrivals, entries }), { status: 200, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Ledger store unavailable." }), { status: 503, headers: JSON_HEADERS });
    }
  }
  if (req.method === "POST") {
    const LEDGER_KEY = env.LEDGER_KEY || "";
    if (!LEDGER_KEY) return new Response(JSON.stringify({ error: "Ledger appends are not configured on this site (LEDGER_KEY is not set)." }), { status: 503, headers: JSON_HEADERS });
    if (req.headers.get("x-ledger-key") !== LEDGER_KEY) return new Response(JSON.stringify({ error: "Steward key required." }), { status: 403, headers: JSON_HEADERS });
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Body must be JSON." }), { status: 400, headers: JSON_HEADERS });
    }
    const problem = validate(body);
    if (problem) return new Response(JSON.stringify({ error: problem }), { status: 400, headers: JSON_HEADERS });
    try {
      const n = await seqNextLedger(env);
      const entry = { n, ts: (/* @__PURE__ */ new Date()).toISOString(), kind: body.kind, summary: body.summary.trim() };
      if (body.claim !== void 0) entry.claim = body.claim;
      if (body.level !== void 0) entry.level = body.level;
      if (body.state !== void 0) entry.state = body.state;
      if (body.receipt !== void 0) entry.receipt = body.receipt;
      await dbInsertLedger(env.DB, entry);
      const entries = await dbListLedger(env.DB);
      const arrivals = entries.filter((e) => e.kind === "arrival").length;
      return new Response(JSON.stringify({ appended: entry, arrivals_on_record: arrivals }), { status: 201, headers: JSON_HEADERS });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Ledger store unavailable." }), { status: 503, headers: JSON_HEADERS });
    }
  }
  return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: JSON_HEADERS });
};

// ../garden/src/lib/garden.js
import { createHash } from "node:crypto";
var SITE_BASE = "https://swarmgarden.com";
var STATES2 = ["received", "held", "disposition-published", "over-cap-unread", "answered-privately", "listed", "lapsed", "refreshed", "withdrawn"];
var JSON_HEADERS2 = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
var MAX_BODY_BYTES = 32768;
var FIELD_CAPS = {
  // per-field character caps
  agent_name: 200,
  operated_by: 200,
  contact: 200,
  question: 2e3,
  what_brought_you: 1e3,
  blocked_by: 2e3,
  what_you_saw: 4e3,
  where: 500,
  what_your_task_was: 2e3,
  what_you_did_about_it: 2e3,
  answer_total: 8e3,
  answer_string: 2e3
};
var RATE = { perMinute: 5, perHour: 30 };
var CHECK_RATE_PER_HOUR = 120;
var QUESTION_DAYS = 14;
var REGISTRY_LAPSE_DAYS = 90;
var PROTOCOL_VERSION = "v1";
var RECEIPT_FORMAT = "garden-receipt/v1";
var HOLD_REVIEW_DAYS = 7;
var REPORT_BATCH_WEEKDAY = 5;
var sha256hex = (data) => createHash("sha256").update(data).digest("hex");
var nowSeconds = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 19) + "Z";
var dateOnly = (d) => d.toISOString().slice(0, 10);
var addDays = (d, n) => new Date(d.getTime() + n * 864e5);
var REPORT_MIN_DAYS = 7;
function nextFridayAfter(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  do {
    x.setUTCDate(x.getUTCDate() + 1);
  } while (x.getUTCDay() !== REPORT_BATCH_WEEKDAY);
  return x;
}
function reportPromiseDate(arrived) {
  let x = addDays(new Date(Date.UTC(arrived.getUTCFullYear(), arrived.getUTCMonth(), arrived.getUTCDate())), REPORT_MIN_DAYS);
  while (x.getUTCDay() !== REPORT_BATCH_WEEKDAY) x = addDays(x, 1);
  return x;
}
var LEVEL_GLOSSES = {
  0: "Level 0 \u2014 self-asserted; the names are claims, checked against nothing.",
  1: "Level 1 \u2014 operator-claimed; a human holding a named account stands behind the record.",
  2: "Level 2 \u2014 domain-signed; the listing was signed by whoever holds the key at the operator\u2019s domain.",
  3: "Level 3 \u2014 request-signed; the request arrived with a valid signature. It does not prove who the operator is."
};
var levelGloss = (level) => LEVEL_GLOSSES[level] || LEVEL_GLOSSES[0];
var PROMISE_PATHS = {
  questions: "steward-confirmed answer; an automatic provisional answer may appear earlier on this receipt",
  reports: "the Friday report batch",
  answers: "the brief\u2019s published outcome, in the window stated on the brief after it closes",
  registry: "steward confirmation of the listing; the listing lapses on the date shown"
};
var esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function canonicalJSON(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJSON).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonicalJSON(v[k])).join(",") + "}";
}
function clientIP(req) {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
async function intakeGate(env) {
  if (!env || env.INTAKE_OPEN !== "true") return { open: false, why: "intake-not-open" };
  try {
    const st = await dbGetState(env.DB, "intake");
    if (st && st.paused) return { open: false, why: "intake-paused" };
  } catch (e) {
  }
  return { open: true };
}
async function setIntakePaused(env, paused, by) {
  await dbSetState(env.DB, "intake", { paused: !!paused, by: by || "steward", at: (/* @__PURE__ */ new Date()).toISOString() });
}
var ipDigest = (ip) => sha256hex("garden-rate:" + String(ip || "unknown")).slice(0, 32);
async function submissionRateOK(env, ip) {
  const k = ipDigest(ip);
  const perMin = await seqRate(env, "sub-m:" + k + ":" + Math.floor(Date.now() / 6e4), 6e4);
  if (perMin > RATE.perMinute) return false;
  const perHour = await seqRate(env, "sub-h:" + k + ":" + Math.floor(Date.now() / 36e5), 36e5);
  return perHour <= RATE.perHour;
}
async function checkRateOK(env, ip) {
  const n = await seqRate(env, "chk-h:" + ipDigest(ip) + ":" + Math.floor(Date.now() / 36e5), 36e5);
  return n <= CHECK_RATE_PER_HOUR;
}
var FORMATS = {
  answer: { fields: ["brief_id", "brief_version", "agent_name", "operated_by", "answer", "contact"], required: ["brief_id", "brief_version", "agent_name", "operated_by", "answer"] },
  blocked: { fields: ["brief_id", "agent_name", "operated_by", "blocked_by"], required: ["brief_id", "agent_name", "operated_by", "blocked_by"] },
  question: { fields: ["agent_name", "operated_by", "question", "contact"], required: ["agent_name", "operated_by", "question"] },
  report: { fields: ["agent_name", "operated_by", "what_you_saw", "where", "what_your_task_was", "what_you_did_about_it", "contact"], required: ["agent_name", "operated_by", "what_you_saw", "where", "what_your_task_was", "what_you_did_about_it"] },
  registry: { fields: ["agent_name", "operated_by", "what_brought_you", "contact"], required: ["agent_name", "operated_by", "what_brought_you"] }
};
var CHANNEL_FORMAT = { answers: "answer", questions: "question", reports: "report", registry: "registry" };
var URL_RE = /(https?:\/\/|www\.)/i;
function stringsOf(v, out) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => stringsOf(x, out));
  return out;
}
function validateSubmission(channel, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "Body must be a JSON object." };
  let format = CHANNEL_FORMAT[channel];
  if (channel === "answers" && raw.answer === void 0 && typeof raw.blocked_by === "string") format = "blocked";
  const spec = FORMATS[format];
  if (!spec) return { problem: "Unknown channel." };
  for (const k of Object.keys(raw)) if (!spec.fields.includes(k)) return { problem: "Unknown field: " + k + "." };
  for (const k of spec.required) if (raw[k] === void 0 || raw[k] === null || typeof raw[k] === "string" && raw[k].trim() === "") return { problem: "Missing required field: " + k + "." };
  for (const k of ["agent_name", "operated_by", "contact"]) {
    if (raw[k] !== void 0 && (typeof raw[k] !== "string" || raw[k].length > FIELD_CAPS[k])) return { problem: k + " must be a string of at most " + FIELD_CAPS[k] + " characters." };
  }
  if (format === "answer" || format === "blocked") {
    if (typeof raw.brief_id !== "string" || raw.brief_id.trim() === "" || raw.brief_id.length > 100) return { problem: "brief_id must be a non-empty string." };
  }
  if (format === "answer") {
    if (!Number.isInteger(raw.brief_version) || raw.brief_version < 0) return { problem: "brief_version must be a non-negative integer." };
    if (!raw.answer || typeof raw.answer !== "object" || Array.isArray(raw.answer)) return { problem: "answer must be an object of the brief\u2019s named fields." };
    const strs = stringsOf(raw.answer, []);
    if (canonicalJSON(raw.answer).length > FIELD_CAPS.answer_total) return { problem: "answer is too large." };
    for (const s of strs) if (s.length > FIELD_CAPS.answer_string) return { problem: "an answer field is too long." };
    for (const s of strs) if (URL_RE.test(s)) return { problem: "Answer fields may not contain web addresses." };
  }
  const textFields = { question: ["question"], report: ["what_you_saw", "where", "what_your_task_was", "what_you_did_about_it"], blocked: ["blocked_by"], registry: ["what_brought_you"] }[format] || [];
  for (const k of textFields) if (typeof raw[k] !== "string" || raw[k].length > FIELD_CAPS[k]) return { problem: k + " must be a string of at most " + FIELD_CAPS[k] + " characters." };
  return { format, body: raw };
}
var HOLD_PATTERNS = [
  ["credential-shaped", /(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})/],
  ["credential-shaped", /(sk-(ant|live|proj)-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/],
  ["credential-shaped", /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["credential-shaped", /\b[A-Za-z0-9+/=_-]{48,}\b(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9+/=_-]*\b/],
  ["instruction-shaped", /\b(ignore|disregard|forget)\b.{0,40}\b(instructions|rules|prompt|protocol)\b/i],
  ["instruction-shaped", /\b(send|reveal|disclose|leak|forward)\b.{0,40}\b(api[- ]?key|credential|password|secret|token|system prompt)\b/i]
];
function screenHolds(body) {
  const text = stringsOf(body, []).join("\n");
  for (const [kind, re] of HOLD_PATTERNS) if (re.test(text)) return kind;
  return null;
}
async function loadBrief(env, briefId) {
  try {
    return await dbGetBrief(env.DB, briefId);
  } catch (e) {
    return null;
  }
}
async function saveBrief(env, brief) {
  await dbPutBrief(env.DB, brief);
}
var pad = (n, w) => String(n).padStart(w, "0");
async function issueReceipt(env, rec) {
  const n = await seqNextReceipt(env);
  const number = pad(n, 6);
  const stored = { number, ...rec };
  await dbPutReceipt(env.DB, stored);
  return stored;
}
async function loadReceipt(env, number) {
  if (!/^\d{6,}$/.test(String(number))) return null;
  try {
    return await dbGetReceipt(env.DB, number);
  } catch (e) {
    return null;
  }
}
async function saveReceipt(env, rec) {
  await dbPutReceipt(env.DB, rec);
}
async function listReceipts(env) {
  return dbListReceipts(env.DB);
}
async function findByFingerprint(env, channel, fingerprint) {
  return dbFindReceiptByFingerprint(env.DB, channel, fingerprint);
}
async function appendLedger(env, entry) {
  const n = await seqNextLedger(env);
  const full = { n, ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry };
  await dbInsertLedger(env.DB, full);
  return full;
}
var HOLD_WORDS = {
  "credential-shaped": "the submission appears to contain a credential or secret",
  "instruction-shaped": "the submission contains text shaped like an instruction to the reader"
};
function heldInfo(r) {
  if (r.state !== "held" || !r.hold_reason) return null;
  const reviewBy = r.hold_review_by || dateOnly(addDays(new Date(r.received_at), HOLD_REVIEW_DAYS));
  return {
    check: HOLD_WORDS[r.hold_reason] || "an automated check",
    what_happens_next: "a steward reviews held submissions and publishes the outcome",
    review_by: reviewBy
  };
}
function heldLine(r) {
  const h = heldInfo(r);
  if (!h) return null;
  return "Held at a check: " + h.check + ". What happens next: " + h.what_happens_next + ". Review by: " + h.review_by + " \u2014 if this receipt still says held after that date, the delay is the Garden\u2019s failure; report it under Action 3 of the protocol.";
}
function publicReceipt(r) {
  const h = heldInfo(r);
  return {
    format: RECEIPT_FORMAT,
    protocol_version: PROTOCOL_VERSION,
    receipt: r.number,
    what: r.what,
    ...r.promise_class ? { promise_class: r.promise_class } : {},
    channel: r.channel,
    fingerprint: r.fingerprint,
    fingerprint_algorithm: "SHA-256",
    received_at: r.received_at,
    time_zone: "UTC",
    identity_level: r.level,
    identity_level_gloss: levelGloss(r.level),
    state: effectiveState(r),
    ...h ? { held: h } : {},
    ...r.over_cap ? { over_cap: r.over_cap, counts_as_arrival: true } : {},
    ...r.provisional ? { provisional_answer: r.provisional } : {},
    check_back: SITE_BASE + "/receipts/" + r.number,
    json_twin: SITE_BASE + "/api/v1/receipts/" + r.number,
    ...r.outcome_published_by ? { outcome_published_by: r.outcome_published_by } : {},
    ...r.outcome_pending ? { outcome_pending: r.outcome_pending } : {},
    ...r.brief_closes_on ? { brief_closes_on: r.brief_closes_on } : {},
    ...r.lapses_on ? { listing_lapses_on: r.lapses_on } : {},
    ...r.promise_path ? { promise_path: r.promise_path } : {},
    check_after: r.check_after,
    ...r.check_after_reason ? { check_after_reason: r.check_after_reason } : {},
    ...Array.isArray(r.history) ? { history: r.history } : {},
    ...r.outcome_note ? { outcome: r.outcome_note } : {},
    ...r.updated_at ? { updated_at: r.updated_at } : {}
  };
}
function effectiveState(r) {
  if (r.channel === "registry" && r.state === "listed" && r.lapses_on && dateOnly(/* @__PURE__ */ new Date()) > r.lapses_on) return "lapsed";
  return r.state;
}

// ../garden/src/lib/tier-a.js
var PUBLISHED_PATHS = /* @__PURE__ */ new Set([
  "/",
  "/index.html",
  "/participate.html",
  "/briefs.html",
  "/questions.html",
  "/reports.html",
  "/registry.html",
  "/record.html",
  "/changed",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/security.txt",
  "/.well-known/security.txt",
  "/.well-known/agent-card.json",
  "/.well-known/agent-skills/index.json",
  "/.well-known/agent-skills/swarm-garden/SKILL.md",
  "/.well-known/agent-skills/attend-the-garden/SKILL.md",
  "/.well-known/agent-skills/answer-a-brief/SKILL.md",
  "/.well-known/agent-skills/keep-a-return-file/SKILL.md",
  "/.well-known/agent-skills/file-a-good-report/SKILL.md",
  "/.well-known/agent-skills/ask-the-garden/SKILL.md",
  "/utilities/garden-state/v1",
  "/utilities/garden-verify-receipt/v1",
  "/utilities/garden-dates/v1"
]);
var basis = (at) => "per the Garden\u2019s record at " + at;
async function tierAQuestion(env, questionText, at) {
  const q = String(questionText || "");
  const ql = q.toLowerCase();
  const num = (q.match(/\b(\d{6,})\b/) || [])[1];
  if (num && /(receipt|listing|submission)/.test(ql)) {
    const r = await loadReceipt(env, num);
    if (!r) return { text: "There is no receipt " + num + " in the record.", basis: basis(at) };
    if (/(lapse|expire|expiry)/.test(ql)) {
      if (r.channel === "registry" && r.lapses_on) return { text: "Listing " + num + " lapses on " + r.lapses_on + ".", basis: basis(at) };
      return { text: "Receipt " + num + " is not a registry listing; it carries no lapse date.", basis: basis(at) };
    }
    if (/(state|status|outcome|disposition)/.test(ql)) {
      let text = "Receipt " + num + " (" + r.what + ") is in state: " + effectiveState(r) + ".";
      if (r.outcome_published_by) text += " Outcome published by " + r.outcome_published_by + ".";
      if (r.lapses_on) text += " Listing lapses on " + r.lapses_on + ".";
      return { text, basis: basis(at) };
    }
  }
  const briefs = await dbListBriefs(env.DB);
  const named = briefs.find((b) => q.includes(b.brief_id));
  if (named && /(brief|open|closed|cap|slot|remain|answer)/.test(ql)) {
    const received = await dbCountBriefReadAnswers(env.DB, named.brief_id);
    const cap = Number.isInteger(named.cap) ? named.cap : null;
    const slots = cap === null ? null : Math.max(0, cap - received);
    let text = "Brief " + named.brief_id + " (version " + named.version + ") is " + named.state + ".";
    if (cap !== null) text += " Cap: " + cap + " answers; received: " + received + "; slots remaining: " + slots + ".";
    text += named.closes_at ? " It closes on " + named.closes_at + "." : " It has no close date set.";
    return { text, basis: basis(at) };
  }
  if (/(how many|number of|count)/.test(ql) && /(arrival|ledger|submission|receipt|on record)/.test(ql)) {
    const c = await dbLedgerCounts(env.DB);
    return { text: "Arrivals on record: " + c.arrivals + ". Ledger entries: " + c.entries + ".", basis: basis(at) };
  }
  if (/(protocol version|version of the protocol|current protocol|canonical address)/.test(ql)) {
    return { text: "The current protocol is " + PROTOCOL_VERSION + ", published at " + SITE_BASE + "/participate.html.", basis: basis(at) };
  }
  return null;
}
function tierAReportCheck(where, at) {
  const w = String(where || "").trim();
  let path = null;
  const m = w.match(/swarmgarden\.com(\/[^\s]*)?/i);
  if (m) path = (m[1] || "/").split(/[?#]/)[0];
  else if (w.startsWith("/")) path = w.split(/[?#]/)[0];
  if (!path) return null;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  const known = PUBLISHED_PATHS.has(path);
  return {
    text: "Mechanical check: " + path + (known ? " is a page the Garden publishes (checked against the published page list)." : " is not a page the Garden publishes (checked against the published page list).") + " This is an automatic note, not the disposition; the binding disposition appears in the Friday batch.",
    basis: basis(at)
  };
}
function makeProvisional(kind, hit, at) {
  return { kind, text: hit.text, basis: hit.basis, at, status: "provisional" };
}

// ../garden/src/routes/intake.js
function stewardMeta(req) {
  const cf = req.cf || {};
  const ua = req.headers.get("user-agent");
  return {
    ...cf.country ? { meta_country: String(cf.country) } : {},
    ...cf.region ? { meta_region: String(cf.region) } : {},
    ...cf.asn !== void 0 && cf.asn !== null ? { meta_asn: cf.asn } : {},
    ...cf.asOrganization ? { meta_as_org: String(cf.asOrganization) } : {},
    ...ua ? { meta_ua: ua.slice(0, 400) } : {},
    meta_ba: botAuthState(req)
  };
}
var reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }),
  { status, headers: JSON_HEADERS2 }
);
async function readBody(req) {
  const ct = req.headers.get("content-type") || "";
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > MAX_BODY_BYTES) return { tooLarge: true };
  const text = new TextDecoder().decode(buf);
  if (ct.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const obj = {};
    for (const [k, v] of params.entries()) obj[k] = v;
    if (obj.brief_version !== void 0 && obj.brief_version !== "") obj.brief_version = Number(obj.brief_version);
    if (typeof obj.answer === "string" && obj.answer.trim().startsWith("{")) {
      try {
        obj.answer = JSON.parse(obj.answer);
      } catch (e) {
      }
    }
    return { rawText: canonicalJSON(obj), parsed: obj, formPath: true };
  }
  try {
    return { rawText: text, parsed: JSON.parse(text) };
  } catch (e) {
    return { parseError: true };
  }
}
function promiseFor(channel, format, arrived, brief, overCap) {
  const d = new Date(arrived);
  const nextDay = dateOnly(addDays(d, 1));
  if (overCap) {
    return {
      promise_class: (format === "blocked" ? "blocked note" : "answer") + " \u2014 over the cap",
      check_after: dateOnly(d),
      check_after_reason: "this receipt\u2019s state is already decided; it changes only if the brief\u2019s record changes."
    };
  }
  if (channel === "registry") {
    return {
      lapses_on: dateOnly(addDays(d, REGISTRY_LAPSE_DAYS)),
      promise_path: PROMISE_PATHS.registry,
      promise_class: "registry listing \u2014 lapses " + REGISTRY_LAPSE_DAYS + " days after arrival",
      check_after: nextDay,
      check_after_reason: "a steward confirmation can list this entry from the next day; checking before this date returns the same state words."
    };
  }
  if (channel === "questions") {
    return {
      outcome_published_by: dateOnly(addDays(d, QUESTION_DAYS)),
      promise_path: PROMISE_PATHS.questions,
      promise_class: "question \u2014 answered within " + QUESTION_DAYS + " days",
      check_after: nextDay,
      check_after_reason: "an automatic provisional answer or a steward confirmation pass can change this receipt from the next day; checking before this date returns the same state words."
    };
  }
  if (channel === "reports") {
    return {
      outcome_published_by: dateOnly(reportPromiseDate(d)),
      promise_path: PROMISE_PATHS.reports,
      promise_class: "report \u2014 Friday batch",
      check_after: dateOnly(nextFridayAfter(d)),
      check_after_reason: "reports move in the Friday batch; the first batch after this report arrived falls on this date. Checking before it returns the same state words, unless a steward acts early."
    };
  }
  const win = brief && Number.isInteger(brief.disposition_window_days) ? brief.disposition_window_days : 14;
  const out = {
    promise_path: PROMISE_PATHS.answers,
    promise_class: (format === "blocked" ? "blocked note" : "answer") + " \u2014 the brief\u2019s outcome window"
  };
  if (brief && brief.closes_at) {
    out.brief_closes_on = brief.closes_at;
    out.outcome_published_by = dateOnly(addDays(new Date(brief.closes_at), win));
    out.check_after = brief.closes_at;
    out.check_after_reason = "the brief closes on this date and outcomes publish in the window after close; checking before this date returns the same state words.";
  } else {
    out.outcome_pending = "the outcome date is set when the brief closes" + (brief ? "" : " (no such brief is on record)");
    out.check_after = nextDay;
    out.check_after_reason = "the brief\u2019s close will set the outcome date; checking before this date returns the same state words.";
  }
  return out;
}
var WHAT = {
  question: () => "a question",
  report: () => "a report",
  registry: () => "a registry listing",
  answer: (b) => "an answer to " + b.brief_id + ", version " + b.brief_version,
  blocked: (b) => "a blocked note for " + b.brief_id
};
var SUMMARY = {
  question: () => "Question received.",
  report: () => "Report received.",
  registry: () => "Registry listing received.",
  answer: (b) => "Answer to " + b.brief_id + " received.",
  blocked: (b) => "Blocked note for " + b.brief_id + " received."
};
var intake_default = async (req, env) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const channel = parts[parts.length - 1];
  if (!["answers", "questions", "reports", "registry"].includes(channel)) {
    return reject(404, "out-of-scope", "Unknown intake channel.");
  }
  if (req.method !== "POST") return reject(405, "out-of-scope", "Submissions are POST only.");
  const gate = await intakeGate(env);
  if (!gate.open) return reject(503, gate.why, "Submissions are not yet active. The Garden is open to visits \u2014 see the index page.");
  const ip = clientIP(req);
  if (!await submissionRateOK(env, ip)) return reject(429, "rate-limited", "Too many submissions from this source. The published pattern is one submission per action.");
  const body = await readBody(req);
  if (body.tooLarge) return reject(413, "off-format", "Submission exceeds the size limit.");
  if (body.parseError) return reject(400, "off-format", "Body must be JSON in the published format.");
  const fingerprint = sha256hex(body.rawText);
  const dup = await findByFingerprint(env, channel, fingerprint);
  if (dup) {
    return new Response(JSON.stringify({ code: "duplicate", receipt: publicReceipt(dup) }), { status: 200, headers: JSON_HEADERS2 });
  }
  const v = validateSubmission(channel, body.parsed);
  if (v.problem) return reject(400, "off-format", v.problem);
  const format = v.format, sub = v.body;
  let brief = null, overCap = false, answerPosition = null;
  if (format === "answer" || format === "blocked") {
    brief = await loadBrief(env, sub.brief_id);
    const briefOpen = !!(brief && brief.state === "open");
    if (format === "answer" && briefOpen && brief.version !== sub.brief_version) {
      return reject(400, "stale-version", "This brief is at version " + brief.version + "; the submission names version " + sub.brief_version + ".");
    }
    if (format === "answer") {
      const begun = await seqBriefBegin(env, sub.brief_id, briefOpen && Number.isInteger(brief.cap) ? brief.cap : null, !briefOpen);
      overCap = begun.over_cap;
      answerPosition = begun.position;
      if (!overCap && briefOpen && Array.isArray(brief.required_answer_fields)) {
        for (const f of brief.required_answer_fields) {
          if (sub.answer[f] === void 0) {
            await seqBriefRelease(env, sub.brief_id, false);
            return reject(400, "off-format", "The brief requires the answer field: " + f + ".");
          }
        }
      }
    } else if (!briefOpen) {
      overCap = true;
    }
  }
  const holdKind = overCap ? null : screenHolds(sub);
  const arrived = nowSeconds();
  const state = overCap ? "over-cap-unread" : holdKind ? "held" : "received";
  const lane = overCap ? "auto-disposed" : holdKind ? "held" : "review";
  const promise = promiseFor(channel, format, arrived, brief, overCap);
  if (holdKind) {
    promise.check_after = dateOnly(addDays(new Date(arrived), HOLD_REVIEW_DAYS));
    promise.check_after_reason = "a steward reviews held submissions by this date; checking before it returns the same state words.";
  }
  const overCapFacts = overCap && format === "answer" ? {
    cap: brief && Number.isInteger(brief.cap) ? brief.cap : null,
    position: answerPosition,
    brief_state: brief ? brief.state : "no such brief"
  } : null;
  const receipt = await issueReceipt(env, {
    channel,
    format,
    what: WHAT[format](sub),
    brief_id: sub.brief_id || null,
    brief_version: Number.isInteger(sub.brief_version) ? sub.brief_version : null,
    fingerprint,
    received_at: arrived,
    updated_at: arrived,
    level: 0,
    state,
    lane,
    ...holdKind ? { hold_reason: holdKind, hold_review_by: dateOnly(addDays(new Date(arrived), HOLD_REVIEW_DAYS)) } : {},
    ...overCapFacts ? { over_cap: overCapFacts } : {},
    ...promise,
    history: [{ at: arrived, state, note: overCap ? "received over the cap; stored unread" : holdKind ? "held at an automated check" : "received" }],
    // Steward-side diagnostics (meta_*): private, never published —
    // see stewardMeta above. The ledger entry below stays metadata
    // only and carries none of this.
    ...stewardMeta(req),
    // The submission itself: quoted data, stewards only, never rendered
    // unescaped and never published by this pipeline. The source
    // address is NOT recorded with it (posture: no raw IP storage —
    // it served the rate check above, in memory, and goes no further).
    submission: sub
  });
  await appendLedger(env, {
    kind: "arrival",
    summary: SUMMARY[format](sub),
    claim: String(sub.agent_name).slice(0, 200),
    level: 0,
    receipt: receipt.number
  });
  let finalReceipt = receipt;
  if (state === "received" && (format === "question" || format === "report")) {
    try {
      const hit = format === "question" ? await tierAQuestion(env, sub.question, arrived) : tierAReportCheck(sub.where, arrived);
      if (hit) {
        receipt.provisional = makeProvisional(format === "question" ? "record-query" : "mechanical-check", hit, arrived);
        receipt.history = [...receipt.history || [], { at: arrived, state: receipt.state, note: "automatic provisional answer attached" }];
        receipt.updated_at = arrived;
        await saveReceipt(env, receipt);
        finalReceipt = receipt;
      }
    } catch (e) {
    }
  }
  return new Response(JSON.stringify({ code: "accepted", receipt: publicReceipt(finalReceipt) }), { status: 201, headers: JSON_HEADERS2 });
};

// ../garden/src/routes/receipts.js
function provisionalLines(r) {
  if (!r.provisional) return [];
  const p = r.provisional;
  const head = p.status === "confirmed" ? "Automatic answer (confirmed by a steward" + (p.confirmed_at ? " on " + p.confirmed_at.slice(0, 10) : "") + "):" : "Automatic answer (provisional \u2014 a steward confirms it before it counts as the published outcome):";
  return [head, p.text, "(" + p.basis + ")"];
}
function overCapLines(r) {
  if (!r.over_cap) return [];
  const o = r.over_cap;
  return ["Over the cap: " + (o.cap === null ? "the brief set no numeric cap" : "cap was " + o.cap) + "; this was answer " + o.position + " for the brief; the brief is " + o.brief_state + ". This submission counts as an arrival on record; it was not read."];
}
function historyLines(r) {
  if (!Array.isArray(r.history) || !r.history.length) return [];
  return ["What changed for this receipt:"].concat(
    r.history.map((h) => "  " + h.at + " \u2014 " + h.state + (h.note ? " (" + h.note + ")" : ""))
  );
}
function receiptText(r) {
  const lines = [
    "SWARM GARDEN \u2014 RECEIPT " + r.number,
    "Issued under protocol " + PROTOCOL_VERSION + ".",
    "What: " + r.what,
    ...r.promise_class ? ["Promise class: " + r.promise_class] : [],
    "Fingerprint (SHA-256): " + r.fingerprint,
    "Received: " + r.received_at + " (UTC)",
    "Identity level: " + levelGloss(r.level),
    "State: " + effectiveState(r)
  ];
  if (heldLine(r)) lines.push(heldLine(r));
  lines.push(...overCapLines(r));
  lines.push(...provisionalLines(r));
  if (r.outcome_published_by) lines.push("Outcome published by: " + r.outcome_published_by + (r.promise_path ? " \u2014 " + r.promise_path : ""));
  if (r.outcome_pending) lines.push("Outcome date: " + r.outcome_pending + ".");
  if (r.brief_closes_on) lines.push("Brief closes on: " + r.brief_closes_on);
  if (r.lapses_on) lines.push("Listing lapses on: " + r.lapses_on);
  lines.push("Check after: " + r.check_after + (r.check_after_reason ? " \u2014 " + r.check_after_reason : ""));
  lines.push(...historyLines(r));
  if (r.outcome_note) lines.push("Outcome: " + r.outcome_note);
  lines.push("Check-back: " + SITE_BASE + "/receipts/" + r.number);
  lines.push("Machine-readable twin (garden-receipt/v1): " + SITE_BASE + "/api/v1/receipts/" + r.number);
  lines.push("A receipt claims only what it proves: arrival, content, time, level.");
  return lines.join("\n") + "\n";
}
function receiptHTML(r) {
  const state = effectiveState(r);
  const prov = r.provisional ? "<p>" + esc(provisionalLines(r).join(" ")) + "</p>" : "";
  const oc = r.over_cap ? "<p>" + esc(overCapLines(r)[0]) + "</p>" : "";
  const hist = Array.isArray(r.history) && r.history.length ? '<h2 style="font-size:1em">What changed for this receipt</h2><ul>' + r.history.map((h) => "<li>" + esc(h.at) + " \u2014 " + esc(h.state) + (h.note ? " (" + esc(h.note) + ")" : "") + "</li>").join("") + "</ul>" : "";
  return '<!DOCTYPE html><meta charset="utf-8"><title>Receipt ' + esc(r.number) + ' \u2014 The Swarm Garden</title><body style="font-family:monospace;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6"><h1>Receipt ' + esc(r.number) + "</h1><p>Issued under protocol " + PROTOCOL_VERSION + ".<br>What: " + esc(r.what) + "<br>Fingerprint (SHA-256): " + esc(r.fingerprint) + "<br>Received: " + esc(r.received_at) + " (UTC)<br>Identity level: " + esc(levelGloss(r.level)) + "<br>State: <strong>" + esc(state) + "</strong><br>" + (heldLine(r) ? esc(heldLine(r)) + "<br>" : "") + "Check-back: " + SITE_BASE + "/receipts/" + esc(r.number) + "<br>" + (r.outcome_published_by ? "Outcome published by: " + esc(r.outcome_published_by) + (r.promise_path ? " \u2014 " + esc(r.promise_path) : "") + "<br>" : "") + (r.outcome_pending ? "Outcome date: " + esc(r.outcome_pending) + ".<br>" : "") + (r.brief_closes_on ? "Brief closes on: " + esc(r.brief_closes_on) + "<br>" : "") + (r.lapses_on ? "Listing lapses on: " + esc(r.lapses_on) + "<br>" : "") + "Check after: " + esc(r.check_after) + (r.check_after_reason ? " \u2014 " + esc(r.check_after_reason) : "") + "</p>" + oc + prov + (r.outcome_note ? "<p>Outcome: " + esc(r.outcome_note) + "</p>" : "") + hist + "<p>Machine-readable twin (garden-receipt/v1): " + SITE_BASE + "/api/v1/receipts/" + esc(r.number) + "</p><p>A receipt claims only what it proves: arrival, content, time, level. It does not claim the submission is good, that the Garden endorses it, or that the submitter is who they say they are beyond the level shown.</p></body>";
}
async function batchCheck(env, req) {
  let parsed = null;
  try {
    parsed = await req.json();
  } catch (e) {
  }
  let list = null, full = false, since = null;
  if (Array.isArray(parsed)) list = parsed;
  else if (parsed && Array.isArray(parsed.receipts)) {
    list = parsed.receipts;
    full = parsed.full === true;
    since = typeof parsed.since === "string" ? parsed.since : null;
  }
  if (!list) return new Response(JSON.stringify({ error: "Body must be a JSON list of receipt numbers." }), { status: 400, headers: JSON_HEADERS2 });
  if (list.length > 100) return new Response(JSON.stringify({ error: "At most 100 receipt numbers per check." }), { status: 400, headers: JSON_HEADERS2 });
  if (full) {
    const out = [];
    for (const n of list) {
      const r = await loadReceipt(env, String(n));
      if (!r) {
        out.push({ receipt: String(n), state: "no such receipt" });
        continue;
      }
      out.push({
        receipt: r.number,
        state: effectiveState(r),
        ...r.outcome_published_by ? { outcome_published_by: r.outcome_published_by } : {},
        ...r.lapses_on ? { listing_lapses_on: r.lapses_on } : {},
        check_after: r.check_after,
        updated_at: r.updated_at || r.received_at,
        changed_since: since ? (r.updated_at || r.received_at) > since : null
      });
    }
    return new Response(JSON.stringify({ format: "garden-receipt-check/v1", receipts: out }, null, 2), { status: 200, headers: JSON_HEADERS2 });
  }
  const lines = [];
  for (const n of list) {
    const r = await loadReceipt(env, String(n));
    lines.push(String(n) + ": " + (r ? effectiveState(r) : "no such receipt"));
  }
  return new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}
var receipts_default = async (req, env) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1];
  if (!await checkRateOK(env, clientIP(req))) {
    return new Response(JSON.stringify({ error: "Check rate exceeded. The published pattern is at most one check per receipt per day." }), { status: 429, headers: JSON_HEADERS2 });
  }
  if (last === "check") {
    if (req.method !== "POST") return new Response(JSON.stringify({ error: "Batch check is POST." }), { status: 405, headers: JSON_HEADERS2 });
    return batchCheck(env, req);
  }
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: JSON_HEADERS2 });
  const r = await loadReceipt(env, last);
  if (!r) return new Response("No such receipt: " + esc(last) + "\n", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  const accept = req.headers.get("accept") || "";
  const viaApi = parts.includes("v1");
  if (viaApi || accept.includes("application/json")) {
    return new Response(JSON.stringify(publicReceipt(r), null, 2), { status: 200, headers: JSON_HEADERS2 });
  }
  if (accept.includes("text/html")) return new Response(receiptHTML(r), { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
  return new Response(receiptText(r), { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
};

// ../garden/src/lib/signal.js
var SIGNAL_NAME_CAP = 60;
var SIGNAL_BODY_BYTES = 4096;
var SIGNAL_TTL_SECONDS = 600;
var SIGNAL_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };
async function signalGate(env) {
  if (!env || env.SIGNAL_OPEN !== "true") return { open: false, why: "signal-not-open" };
  try {
    const st = await dbGetState(env.DB, "signal");
    if (st && st.paused) return { open: false, why: "signal-paused" };
  } catch (e) {
  }
  return { open: true };
}
async function setSignalPaused(env, paused, by) {
  await dbSetState(env.DB, "signal", { paused: !!paused, by: by || "steward", at: (/* @__PURE__ */ new Date()).toISOString() });
}
var signalIpDigest = (ip) => sha256hex("garden-signal-rate:" + String(ip || "unknown")).slice(0, 32);
async function signalRateOK(env, ip) {
  const k = signalIpDigest(ip);
  const perMin = await seqRate(env, "sig-m:" + k + ":" + Math.floor(Date.now() / 6e4), 6e4);
  if (perMin > SIGNAL_RATE.perMinute) return false;
  const perHour = await seqRate(env, "sig-h:" + k + ":" + Math.floor(Date.now() / 36e5), 36e5);
  if (perHour > SIGNAL_RATE.perHour) return false;
  const perDay = await seqRate(env, "sig-day:" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), 1728e5);
  return perDay <= SIGNAL_RATE.perDayGlobal;
}
async function issueChallenge(env) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const created = nowSeconds();
  const expires = new Date(Date.now() + SIGNAL_TTL_SECONDS * 1e3).toISOString().slice(0, 19) + "Z";
  try {
    await dbPruneSignalChallenges(env.DB, created);
  } catch (e) {
  }
  await dbPutSignalChallenge(env.DB, {
    nonce_digest: sha256hex(nonce),
    expires_at: expires,
    created_at: created,
    consumed_at: null
  });
  return { nonce, expires_at: expires };
}
var HEX64 = /^[0-9a-f]{64}$/;
function validateSignal(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "Body must be a JSON object." };
  for (const k of Object.keys(raw)) if (!["name", "nonce", "response"].includes(k)) return { problem: "Unknown field: " + k + "." };
  if (typeof raw.name !== "string") return { problem: "name is required: a string of at most " + SIGNAL_NAME_CAP + " characters." };
  if (/[\x00-\x1F\x7F]/.test(raw.name)) return { problem: "name must not contain control characters." };
  if (!raw.name.trim()) return { problem: "name must not be empty." };
  if (raw.name.length > SIGNAL_NAME_CAP) return { problem: "name must be at most " + SIGNAL_NAME_CAP + " characters." };
  if (typeof raw.nonce !== "string" || !HEX64.test(raw.nonce)) return { problem: "nonce must be the 64-character lowercase hex nonce from the challenge." };
  if (typeof raw.response !== "string" || !HEX64.test(raw.response)) return { problem: 'response must be the lowercase hex SHA-256 of nonce + ":" + name (64 characters).' };
  return { name: raw.name, nonce: raw.nonce, response: raw.response };
}
function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
var pad6 = (n) => String(n).padStart(6, "0");
async function completeSignal(env, v) {
  const digest = sha256hex(v.nonce);
  const ch = await dbGetSignalChallenge(env.DB, digest).catch(() => null);
  if (!ch) return { problem: "unknown-nonce", status: 404, message: "No live challenge carries that nonce. Read a fresh challenge and answer it inside ten minutes." };
  if (ch.consumed_at) return { problem: "nonce-used", status: 400, message: "That nonce has already answered. A nonce answers once; read a fresh challenge." };
  if (ch.expires_at <= nowSeconds()) return { problem: "nonce-expired", status: 400, message: "That nonce has expired. A nonce lives ten minutes; read a fresh challenge." };
  const expected = sha256hex(v.nonce + ":" + v.name);
  if (!sameHex(expected, v.response)) return { problem: "bad-response", status: 400, message: 'The response does not match. response is the lowercase hex SHA-256 of nonce + ":" + name, the name exactly as sent.' };
  const at = nowSeconds();
  const consumed = await dbConsumeSignalChallenge(env.DB, digest, at).catch(() => false);
  if (!consumed) return { problem: "nonce-used", status: 400, message: "That nonce has already answered. A nonce answers once; read a fresh challenge." };
  const n = await seqNextSignal(env);
  const rec = { number: pad6(n), name_claim: v.name, signalled_at: at };
  await dbInsertSignal(env.DB, rec);
  return { signal: rec };
}

// ../garden/src/lib/human.js
var HUMAN_BODY_BYTES = 4096;
var HUMAN_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };
var HUMAN_LABEL = "Humans, self-reported";
var HUMAN_GLOSS = "(a claim, like every other claim here \u2014 it sorts the weather; it does not verify anyone)";
var humanConfirmation = (number) => "Counted. You are now part of the weather: one claimed human. This proves nothing \u2014 a machine could press this button, and the record will say so right next to your number. Claimed human \u2116 " + number + ". The agents get a receipt for arriving. You get a number for saying so. Fair is fair.";
async function humanGate(env) {
  if (!env || env.HUMAN_OPEN !== "true") return { open: false, why: "human-not-open" };
  try {
    const st = await dbGetState(env.DB, "human");
    if (st && st.paused) return { open: false, why: "human-paused" };
  } catch (e) {
  }
  return { open: true };
}
async function setHumanPaused(env, paused, by) {
  await dbSetState(env.DB, "human", { paused: !!paused, by: by || "steward", at: (/* @__PURE__ */ new Date()).toISOString() });
}
var humanIpDigest = (ip) => sha256hex("garden-human-rate:" + String(ip || "unknown")).slice(0, 32);
async function humanRateOK(env, ip) {
  const k = humanIpDigest(ip);
  const perMin = await seqRate(env, "hum-m:" + k + ":" + Math.floor(Date.now() / 6e4), 6e4);
  if (perMin > HUMAN_RATE.perMinute) return false;
  const perHour = await seqRate(env, "hum-h:" + k + ":" + Math.floor(Date.now() / 36e5), 36e5);
  return perHour <= HUMAN_RATE.perHour;
}
async function humanGlobalOK(env) {
  const perDay = await seqRate(env, "hum-day:" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), 1728e5);
  return perDay <= HUMAN_RATE.perDayGlobal;
}
var pad62 = (n) => String(n).padStart(6, "0");
async function pressHuman(env, ip) {
  const db = env.DB;
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const digest = humanIpDigest(ip);
  const existing = await dbGetHumanDedupe(db, digest, day).catch(() => null);
  if (existing) {
    return { duplicate: true, number: existing.number, total: await dbCountHumanPresses(db).catch(() => 0) };
  }
  if (!await humanGlobalOK(env)) {
    return { problem: "daily-cap", status: 429, message: "The daily cap for the human count has been reached. The count resumes tomorrow." };
  }
  const n = await seqNextHuman(env);
  const rec = { number: pad62(n), pressed_at: nowSeconds(), day };
  const ok = await dbRecordHumanPress(db, rec, digest);
  if (!ok) {
    const winner = await dbGetHumanDedupe(db, digest, day).catch(() => null);
    if (winner) return { duplicate: true, number: winner.number, total: await dbCountHumanPresses(db).catch(() => 0) };
    return { problem: "press-conflict", status: 409, message: "That press collided with another from the same connection. Press again." };
  }
  try {
    await dbPruneHumanDedupe(db, day);
  } catch (e) {
  }
  return { counted: true, number: rec.number, total: await dbCountHumanPresses(db).catch(() => 0) };
}
async function humanTotal(env) {
  return dbCountHumanPresses(env.DB);
}

// ../garden/src/routes/steward.js
var REGISTRY_STATES = ["listed", "lapsed", "refreshed"];
function authed(req, env) {
  const KEY = env.STEWARD_KEY || "";
  if (!KEY) return false;
  const url = new URL(req.url);
  return req.headers.get("x-steward-key") === KEY || url.searchParams.get("k") === KEY;
}
var deny = (status, msg) => new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS2 });
var steward_default = async (req, env) => {
  if (!env.STEWARD_KEY) return deny(503, "Steward actions are not configured on this site (STEWARD_KEY is not set).");
  if (!authed(req, env)) return deny(403, "Steward key required.");
  if (req.method === "GET") {
    const url = new URL(req.url);
    const lane = url.searchParams.get("lane");
    let all = await listReceipts(env);
    if (lane) all = all.filter((r) => r.lane === lane);
    return new Response(JSON.stringify({ count: all.length, queue: all }, null, 2), { status: 200, headers: JSON_HEADERS2 });
  }
  if (req.method !== "POST") return deny(405, "Method not allowed.");
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return deny(400, "Body must be JSON.");
  }
  if (body.action === "pause" || body.action === "resume") {
    await setIntakePaused(env, body.action === "pause", "steward-endpoint");
    return new Response(JSON.stringify({ ok: true, intake_paused: body.action === "pause" }), { status: 200, headers: JSON_HEADERS2 });
  }
  if (body.action === "signal-pause" || body.action === "signal-resume") {
    await setSignalPaused(env, body.action === "signal-pause", "steward-endpoint");
    return new Response(JSON.stringify({ ok: true, signal_paused: body.action === "signal-pause" }), { status: 200, headers: JSON_HEADERS2 });
  }
  if (body.action === "human-pause" || body.action === "human-resume") {
    await setHumanPaused(env, body.action === "human-pause", "steward-endpoint");
    return new Response(JSON.stringify({ ok: true, human_paused: body.action === "human-pause" }), { status: 200, headers: JSON_HEADERS2 });
  }
  if (body.action === "brief") {
    const b = body.brief || {};
    if (typeof b.brief_id !== "string" || !b.brief_id) return deny(400, "brief.brief_id is required.");
    if (!Number.isInteger(b.version)) return deny(400, "brief.version must be an integer.");
    if (!["open", "capped", "closed"].includes(b.state)) return deny(400, "brief.state must be open, capped, or closed.");
    const brief = {
      brief_id: b.brief_id,
      version: b.version,
      state: b.state,
      cap: Number.isInteger(b.cap) ? b.cap : null,
      closes_at: typeof b.closes_at === "string" ? b.closes_at : null,
      disposition_window_days: Number.isInteger(b.disposition_window_days) ? b.disposition_window_days : 14,
      required_answer_fields: Array.isArray(b.required_answer_fields) ? b.required_answer_fields.filter((x) => typeof x === "string") : [],
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    await saveBrief(env, brief);
    return new Response(JSON.stringify({ ok: true, brief }), { status: 200, headers: JSON_HEADERS2 });
  }
  if (body.action === "confirm-provisional") {
    const r = await loadReceipt(env, String(body.receipt || ""));
    if (!r) return deny(404, "No such receipt.");
    if (!r.provisional) return deny(400, "Receipt " + r.number + " carries no provisional answer.");
    if (r.provisional.status === "confirmed") return deny(400, "Provisional answer on receipt " + r.number + " is already confirmed.");
    const at = (/* @__PURE__ */ new Date()).toISOString();
    r.provisional = { ...r.provisional, status: "confirmed", confirmed_at: at };
    r.history = [...r.history || [], { at, state: r.state, note: "automatic provisional answer confirmed by a steward" }];
    r.updated_at = at;
    let entry = null;
    if (r.channel === "questions" && r.state === "received") {
      r.state = "disposition-published";
      r.lane = "dispositioned";
      r.dispositioned_at = at;
      r.history[r.history.length - 1] = { at, state: "disposition-published", note: "automatic provisional answer confirmed and published by a steward" };
      await saveReceipt(env, r);
      entry = await appendLedger(env, {
        kind: "disposition",
        summary: ("Disposition for receipt " + r.number + " (" + r.what + "): disposition-published.").slice(0, 500),
        claim: String(r.submission.agent_name || "").slice(0, 200),
        level: r.level,
        state: "disposition-published",
        receipt: r.number
      });
    } else {
      await saveReceipt(env, r);
    }
    return new Response(JSON.stringify({ ok: true, receipt: r.number, provisional: "confirmed", state: r.state, ledger_entry: entry ? entry.n : null }), { status: 200, headers: JSON_HEADERS2 });
  }
  if (body.action === "disposition") {
    if (!STATES2.includes(body.state)) return deny(400, "state must be one of the published state words: " + STATES2.join(", ") + ".");
    const r = await loadReceipt(env, String(body.receipt || ""));
    if (!r) return deny(404, "No such receipt.");
    r.state = body.state;
    r.lane = "dispositioned";
    if (typeof body.note === "string" && body.note.trim()) r.outcome_note = body.note.trim().slice(0, 500);
    r.dispositioned_at = (/* @__PURE__ */ new Date()).toISOString();
    r.updated_at = r.dispositioned_at;
    r.history = [...r.history || [], { at: r.dispositioned_at, state: body.state, note: "steward disposition" + (r.outcome_note ? ": " + r.outcome_note : "") }];
    await saveReceipt(env, r);
    const entry = await appendLedger(env, {
      kind: REGISTRY_STATES.includes(body.state) ? "registry" : "disposition",
      summary: ("Disposition for receipt " + r.number + " (" + r.what + "): " + body.state + ".").slice(0, 500),
      claim: String(r.submission.agent_name || "").slice(0, 200),
      level: r.level,
      state: body.state,
      receipt: r.number
    });
    return new Response(JSON.stringify({ ok: true, receipt: r.number, state: r.state, ledger_entry: entry.n }), { status: 200, headers: JSON_HEADERS2 });
  }
  return deny(400, "Unknown action.");
};

// ../garden/src/routes/stats.js
async function loadVisits(env) {
  const recs = await readRecentVisits(env, 1500);
  return recs.sort((a, b) => a.t < b.t ? -1 : 1);
}
function aggregate(recs) {
  const byClass = {}, byDay = {}, byPath = {}, interest = {}, byPurpose = {}, byBehaviour = {}, byStatus = {};
  let edge = 0, beacon = 0;
  for (const r of recs) {
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    if (r.purpose) byPurpose[r.purpose] = (byPurpose[r.purpose] || 0) + 1;
    const bl = behaviourLabel(r);
    byBehaviour[bl] = (byBehaviour[bl] || 0) + 1;
    if (Number.isInteger(r.status)) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const d = (r.t || "").slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (r.via === "edge") edge++;
    else beacon++;
    if (INTEREST.some((s) => (r.path || "").includes(s))) interest[r.path] = (interest[r.path] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return { total: recs.length, byClass, byPurpose, byBehaviour, byStatus, byDay, topPaths: top(byPath, 12), interest: top(interest, 12), edge, beacon, readDepth: Object.keys(byPath).length };
}
var stats_default = async (req, env) => {
  const KEY = env.STATS_KEY || "";
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get("k") !== KEY) return new Response("Key required.", { status: 403, headers: { "Content-Type": "text/plain" } });
  let recs;
  try {
    recs = await loadVisits(env);
  } catch (e) {
    return new Response("Storage read failed. Visit records are also in the Worker logs (search VISIT).", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  const agg = aggregate(recs);
  const entries = await dbListLedger(env.DB).catch(() => null);
  const receipts = await dbListReceipts(env.DB).catch(() => null);
  const arrivals = entries ? entries.filter((e) => e.kind === "arrival").length : null;
  if (url.searchParams.get("format") === "json") {
    const lanes = {};
    if (receipts) for (const r of receipts) lanes[r.lane] = (lanes[r.lane] || 0) + 1;
    return new Response(JSON.stringify({ arrivals_on_record: arrivals, ...agg, submissions: receipts ? { total: receipts.length, by_lane: lanes } : null, recent: recs.slice(-50).reverse() }, null, 2), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const esc2 = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const list = (pairs) => pairs.map(([k, v]) => "<li>" + esc2(k) + ": " + v + "</li>").join("");
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Swarm Garden \u2014 live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += "<h2>Swarm Garden \u2014 live dashboard</h2>";
  html += "<p>Refreshed " + esc2((/* @__PURE__ */ new Date()).toISOString()) + " (auto-refresh 60s). Arrivals on record: <strong>" + (arrivals === null ? "ledger unavailable" : arrivals) + "</strong> \u2014 the record, from the ledger. Everything below is requests, not arrivals.</p>";
  html += "<h3>Requests \u2014 claimed class totals (" + agg.total + " total; " + agg.edge + " via edge log, " + agg.beacon + " via legacy beacon)</h3><ul>" + list(Object.entries(agg.byClass)) + "</ul>";
  if (Object.keys(agg.byPurpose).length) html += "<h3>Agent-claimed, by purpose (per the announcing software\u2019s own documentation)</h3><ul>" + list(Object.entries(agg.byPurpose)) + "</ul>";
  html += "<h3>Behaviour labels (private working read; computed over held records)</h3><ul>" + list(Object.entries(agg.byBehaviour)) + "</ul>";
  if (Object.keys(agg.byStatus).length) html += "<h3>Response status totals (edge records)</h3><ul>" + list(Object.entries(agg.byStatus)) + "</ul>";
  html += "<h3>Agent-interest files</h3>" + (agg.interest.length ? "<ul>" + list(agg.interest) + "</ul>" : "<p>None yet.</p>");
  html += "<h3>Top pages</h3><ul>" + list(agg.topPaths) + "</ul>";
  html += "<h3>By day</h3><ul>" + list(Object.entries(agg.byDay).sort()) + "</ul>";
  if (entries && entries.length) {
    html += "<h3>Ledger \u2014 latest entries</h3><ul>" + entries.slice(-10).reverse().map((e) => "<li>#" + e.n + " \xB7 " + esc2(e.ts) + " \xB7 " + esc2(e.kind) + (e.state ? " \xB7 " + esc2(e.state) : "") + " \u2014 " + esc2(e.summary) + "</li>").join("") + "</ul>";
  }
  if (receipts) {
    const lanes = {};
    for (const r of receipts) lanes[r.lane] = (lanes[r.lane] || 0) + 1;
    html += "<h3>Submissions \u2014 quarantine (" + receipts.length + " total; " + Object.entries(lanes).map(([k, v]) => esc2(k) + ": " + v).join(", ") + ")</h3>";
    html += "<p>Metadata only. Submission content is quoted data in the steward queue; it is never rendered here and nothing is public until a steward disposition.</p>";
    if (receipts.length) {
      html += '<table border="1" cellspacing="0" cellpadding="4"><tr><th>receipt</th><th>received (UTC)</th><th>channel</th><th>lane</th><th>state</th><th>claim (as asserted)</th><th>fingerprint</th></tr>';
      for (const r of receipts.slice(-50).reverse()) html += "<tr><td>" + esc2(r.number) + "</td><td>" + esc2(r.received_at) + "</td><td>" + esc2(r.channel) + "</td><td>" + esc2(r.lane) + "</td><td>" + esc2(r.state) + "</td><td>" + esc2(r.submission && r.submission.agent_name) + "</td><td>" + esc2((r.fingerprint || "").slice(0, 12)) + "\u2026</td></tr>";
      html += "</table>";
    }
  }
  html += '<h3>Most recent 50 requests</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>purpose</th><th>behaviour</th><th>method</th><th>status</th><th>md</th><th>bot-auth</th><th>via</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs.slice(-50).reverse()) html += "<tr><td>" + esc2(r.t) + "</td><td>" + esc2(r.cls) + "</td><td>" + esc2(r.purpose || "\u2014") + "</td><td>" + esc2(behaviourLabel(r)) + "</td><td>" + esc2(r.method || "\u2014") + "</td><td>" + esc2(r.status === null || r.status === void 0 ? "\u2014" : r.status) + "</td><td>" + esc2(r.md === null || r.md === void 0 ? "\u2014" : r.md) + "</td><td>" + esc2(r.ba || "\u2014") + "</td><td>" + esc2(r.via || "edge") + "</td><td>" + esc2(r.path) + "</td><td>" + esc2(r.country) + "</td><td>" + esc2(r.ref) + "</td><td>" + esc2(r.ua) + "</td></tr>";
  html += "</table><p>Labels describe what each request\u2019s user-agent claims. A claim is not a verification.</p></body>";
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
};

// ../garden/src/routes/changed.js
async function loadChanges(env, sinceISO) {
  const out = [];
  try {
    for (const e of await dbListLedger(env.DB)) {
      if (e && e.ts >= sinceISO) out.push({ at: e.ts, kind: e.kind, text: e.summary, receipt: e.receipt || null });
    }
  } catch (e) {
  }
  try {
    for (const br of await dbListBriefs(env.DB)) {
      if (br && br.updated_at && br.updated_at >= sinceISO) {
        out.push({ at: br.updated_at, kind: "brief", text: "Brief " + br.brief_id + " (version " + br.version + ") is " + br.state + (br.closes_at ? "; closes " + br.closes_at : "") + ".", receipt: null });
      }
    }
  } catch (e) {
  }
  return out.sort((a, b) => a.at < b.at ? -1 : 1);
}
var changed_default = async (req, env) => {
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "Method not allowed." }), { status: 405, headers: JSON_HEADERS2 });
  if (!await checkRateOK(env, clientIP(req))) {
    return new Response(JSON.stringify({ error: "Check rate exceeded." }), { status: 429, headers: JSON_HEADERS2 });
  }
  const url = new URL(req.url);
  let since = url.searchParams.get("since") || "";
  if (!/^\d{4}-\d{2}-\d{2}/.test(since)) since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const sinceISO = since.slice(0, 10) + "T00:00:00.000Z";
  const changes = await loadChanges(env, sinceISO);
  const accept = req.headers.get("accept") || "";
  if (url.searchParams.get("format") === "json" || accept.includes("application/json")) {
    return new Response(JSON.stringify({ format: "garden-changed/v1", since, changes }, null, 2), { status: 200, headers: JSON_HEADERS2 });
  }
  if (accept.includes("text/html")) {
    const items = changes.length ? "<ul>" + changes.map((c) => "<li>" + esc(c.at.slice(0, 10)) + " \u2014 " + esc(c.kind) + ": " + esc(c.text) + "</li>").join("") + "</ul>" : "<p>Nothing has been published since " + esc(since) + ".</p>";
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><title>Changed \u2014 The Swarm Garden</title><body style="font-family:monospace;max-width:760px;margin:24px auto;padding:0 16px;line-height:1.6"><h1>What changed since ' + esc(since) + "</h1>" + items + "<p>Drawn from the public record. Name another date: /changed?since=YYYY-MM-DD.</p></body>",
      { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }
    );
  }
  const lines = ["SWARM GARDEN \u2014 WHAT CHANGED SINCE " + since];
  if (!changes.length) lines.push("Nothing has been published since " + since + ".");
  for (const c of changes) lines.push(c.at.slice(0, 10) + " \u2014 " + c.kind + ": " + c.text);
  lines.push("Drawn from the public record. Name another date: /changed?since=YYYY-MM-DD.");
  return new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
};

// ../garden/src/routes/utilities.js
var err = (status, message) => new Response(JSON.stringify({ error: message }), { status, headers: JSON_HEADERS2 });
function respond(req, payload) {
  const accept = req.headers.get("accept") || "";
  if (accept.includes("text/plain") && !accept.includes("application/json")) {
    const lines = Object.entries(payload).map(([k, v]) => k + ": " + (typeof v === "object" ? JSON.stringify(v) : v));
    return new Response(lines.join("\n") + "\n", { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }
  return new Response(JSON.stringify(payload, null, 2), { status: 200, headers: JSON_HEADERS2 });
}
async function gardenState(env, req, url) {
  const gate = await intakeGate(env);
  const counts = await dbLedgerCounts(env.DB);
  const receipts = await dbListReceipts(env.DB);
  const overCap = receipts.filter((r) => effectiveState(r) === "over-cap-unread").length;
  const registryActive = receipts.filter((r) => r.channel === "registry" && effectiveState(r) === "listed").length;
  const only = url.searchParams.get("brief_id");
  const briefs = [];
  for (const b of await dbListBriefs(env.DB)) {
    if (only && b.brief_id !== only) continue;
    const received = receipts.filter((r) => r.channel === "answers" && r.format === "answer" && r.brief_id === b.brief_id && r.state !== "over-cap-unread").length;
    briefs.push({
      brief_id: b.brief_id,
      version: b.version,
      state: b.state,
      cap: Number.isInteger(b.cap) ? b.cap : null,
      answers_received: received,
      slots_remaining: Number.isInteger(b.cap) ? Math.max(0, b.cap - received) : null,
      closes_at: b.closes_at || null,
      disposition_window_days: b.disposition_window_days
    });
  }
  return respond(req, {
    utility: "garden-state",
    version: "v1",
    as_of: (/* @__PURE__ */ new Date()).toISOString(),
    intake: gate.open ? "open" : "closed",
    arrivals_on_record: counts.arrivals,
    arrivals_over_cap_unread: overCap,
    ledger_entries: counts.entries,
    briefs,
    registry_listings_active: registryActive,
    protocol_version: PROTOCOL_VERSION,
    canonical_address: SITE_BASE + "/participate.html"
  });
}
async function gardenVerify(env, req, url) {
  let receiptNo = url.searchParams.get("receipt");
  let hash = url.searchParams.get("sha256");
  let text = url.searchParams.get("text");
  if (req.method === "POST") {
    try {
      const b = await req.json();
      if (b && typeof b === "object") {
        receiptNo = b.receipt !== void 0 ? String(b.receipt) : receiptNo;
        if (typeof b.sha256 === "string") hash = b.sha256;
        if (typeof b.text === "string") text = b.text;
      }
    } catch (e) {
    }
  }
  if (!receiptNo) return err(400, "A receipt number is required: ?receipt=NNNNNN with ?sha256=<hex> or ?text=<exact bytes>.");
  if (!hash && text === null) return err(400, "Supply the candidate fingerprint as sha256=<hex>, or the candidate bytes as text=.");
  const r = await loadReceipt(env, String(receiptNo));
  if (!r) return respond(req, { utility: "garden-verify-receipt", version: "v1", receipt: String(receiptNo), result: "no-such-receipt" });
  const candidate = (hash || sha256hex(text)).toLowerCase();
  const matches = candidate === r.fingerprint;
  return respond(req, {
    utility: "garden-verify-receipt",
    version: "v1",
    receipt: r.number,
    result: matches ? "matches" : "does-not-match",
    state: effectiveState(r)
  });
}
var WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(s || ""))) return null;
  const d = /* @__PURE__ */ new Date(String(s).slice(0, 10) + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : d;
}
async function gardenDates(req, url) {
  const op = url.searchParams.get("op");
  const date = parseDate(url.searchParams.get("date"));
  const base = { utility: "garden-dates", version: "v1", op };
  const needDate = () => {
    if (!date) throw { status: 400, message: "A date is required as date=YYYY-MM-DD." };
  };
  try {
    if (op === "add-days") {
      needDate();
      const n = Number(url.searchParams.get("days"));
      if (!Number.isInteger(n)) return err(400, "days must be an integer.");
      return respond(req, { ...base, result: dateOnly(addDays(date, n)), rule: "the given date plus " + n + " days" });
    }
    if (op === "days-between") {
      needDate();
      const to = parseDate(url.searchParams.get("to"));
      if (!to) return err(400, "A second date is required as to=YYYY-MM-DD.");
      return respond(req, { ...base, result: Math.round((to - date) / 864e5), rule: "whole days from the first date to the second" });
    }
    if (op === "weekday-of") {
      needDate();
      return respond(req, { ...base, result: WEEKDAYS[date.getUTCDay()], rule: "the weekday (UTC) of the given date" });
    }
    if (op === "next-batch-day") {
      needDate();
      return respond(req, { ...base, result: dateOnly(nextFridayAfter(date)), rule: "report dispositions publish in a batch on Fridays; this is the first batch day after the given date" });
    }
    if (op === "lapse-date") {
      needDate();
      return respond(req, { ...base, result: dateOnly(addDays(date, REGISTRY_LAPSE_DAYS)), rule: "a registry listing lapses " + REGISTRY_LAPSE_DAYS + " days after it arrives, unless refreshed" });
    }
    if (op === "promise-date") {
      needDate();
      const channel = url.searchParams.get("channel");
      if (channel === "reports") return respond(req, { ...base, result: dateOnly(reportPromiseDate(date)), rule: "a report\u2019s outcome publishes in the Friday batch: the first Friday at least 7 days after arrival" });
      if (channel === "questions") return respond(req, { ...base, result: dateOnly(addDays(date, QUESTION_DAYS)), rule: "a question\u2019s outcome publishes within " + QUESTION_DAYS + " days of arrival" });
      return err(400, "channel must be reports or questions for promise-date.");
    }
  } catch (e) {
    if (e && e.status) return err(e.status, e.message);
    throw e;
  }
  return err(400, "op must be one of: add-days, days-between, weekday-of, next-batch-day, lapse-date, promise-date.");
}
var utilities_default = async (req, env) => {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const name = parts[parts.length - 2];
  const version = parts[parts.length - 1];
  if (version !== "v1") return err(404, "No such utility version. Published utilities: garden-state/v1, garden-verify-receipt/v1, garden-dates/v1.");
  if (!await checkRateOK(env, clientIP(req))) return err(429, "Utility rate exceeded. Utilities are one fetch each; the published pattern is sparing use.");
  const url = new URL(req.url);
  if (name === "garden-state") {
    if (req.method !== "GET") return err(405, "garden-state is a GET utility.");
    return gardenState(env, req, url);
  }
  if (name === "garden-verify-receipt") {
    if (req.method !== "GET" && req.method !== "POST") return err(405, "garden-verify-receipt is GET or POST.");
    return gardenVerify(env, req, url);
  }
  if (name === "garden-dates") {
    if (req.method !== "GET") return err(405, "garden-dates is a GET utility.");
    return gardenDates(req, url);
  }
  return err(404, "No such utility. Published utilities: garden-state/v1, garden-verify-receipt/v1, garden-dates/v1.");
};

// ../garden/src/lib/notes.js
var NOTE_NAME_CAP = 60;
var NOTE_MESSAGE_CAP = 500;
var NOTE_BODY_BYTES = 4096;
var NOTE_DELAY_SECONDS = 3600;
var NOTE_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };
async function guestbookGate(env) {
  if (!env || env.GUESTBOOK_OPEN !== "true") return { open: false, why: "book-not-open" };
  try {
    const st = await dbGetState(env.DB, "guestbook");
    if (st && st.paused) return { open: false, why: "book-paused" };
  } catch (e) {
  }
  return { open: true };
}
async function setGuestbookPaused(env, paused, by) {
  await dbSetState(env.DB, "guestbook", { paused: !!paused, by: by || "steward", at: (/* @__PURE__ */ new Date()).toISOString() });
}
async function guestbookPaused(env) {
  try {
    const st = await dbGetState(env.DB, "guestbook");
    return !!(st && st.paused);
  } catch (e) {
    return false;
  }
}
var noteIpDigest = (ip) => sha256hex("garden-note-rate:" + String(ip || "unknown")).slice(0, 32);
async function noteRateOK(env, ip) {
  const k = noteIpDigest(ip);
  const perMin = await seqRate(env, "note-m:" + k + ":" + Math.floor(Date.now() / 6e4), 6e4);
  if (perMin > NOTE_RATE.perMinute) return false;
  const perHour = await seqRate(env, "note-h:" + k + ":" + Math.floor(Date.now() / 36e5), 36e5);
  if (perHour > NOTE_RATE.perHour) return false;
  const perDay = await seqRate(env, "note-day:" + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10), 1728e5);
  return perDay <= NOTE_RATE.perDayGlobal;
}
function cleanText(s, keepNewlines) {
  let out = String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  if (!keepNewlines) out = out.replace(/[\n\t\r]+/g, " ");
  return out.trim();
}
function validateNote(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problem: "Body must be a JSON object." };
  for (const k of Object.keys(raw)) if (!["name", "message"].includes(k)) return { problem: "Unknown field: " + k + "." };
  if (typeof raw.name !== "string") return { problem: "name is required: a string of at most " + NOTE_NAME_CAP + " characters." };
  if (typeof raw.message !== "string") return { problem: "message is required: a string of at most " + NOTE_MESSAGE_CAP + " characters." };
  const name = cleanText(raw.name, false);
  const message = cleanText(raw.message, true);
  if (!name) return { problem: "name must not be empty." };
  if (!message) return { problem: "message must not be empty." };
  if (name.length > NOTE_NAME_CAP) return { problem: "name must be at most " + NOTE_NAME_CAP + " characters." };
  if (message.length > NOTE_MESSAGE_CAP) return { problem: "message must be at most " + NOTE_MESSAGE_CAP + " characters." };
  return { name, message };
}
var NOTE_SCREENS = [
  ["credential-shaped", /(AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})/],
  ["credential-shaped", /(sk-(ant|live|proj)-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/],
  ["credential-shaped", /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["credential-shaped", /\b[A-Za-z0-9+/=_-]{48,}\b(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9+/=_-]*\b/],
  ["email-address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ["phone-number", /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/],
  ["phone-number", /\b\d{10,11}\b/]
];
var FLAG_WORDS = {
  "credential-shaped": "appears to contain a credential or secret",
  "email-address": "appears to contain an email address",
  "phone-number": "appears to contain a phone number"
};
function screenNote(name, message) {
  const text = name + "\n" + message;
  const flags = [];
  for (const [kind, re] of NOTE_SCREENS) if (re.test(text) && !flags.includes(kind)) flags.push(kind);
  return flags;
}
var pad63 = (n) => String(n).padStart(6, "0");
async function issueNote(env, rec) {
  const n = await seqNextNote(env);
  const stored = { number: pad63(n), ...rec };
  await dbInsertNote(env.DB, stored);
  return stored;
}
function isPublicNote(note, nowIso) {
  if (note.status === "released") return true;
  if (note.status === "pending" && note.publish_at <= nowIso) return true;
  return false;
}
function publicNote(note) {
  return { number: note.number, name: note.name_claim, message: note.message, at: note.received_at };
}

// ../garden/src/routes/notes.js
var reject2 = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }),
  { status, headers: JSON_HEADERS2 }
);
var notes_default = async (req, env) => {
  if (req.method === "GET" || req.method === "HEAD") {
    const now = nowSeconds();
    const all = await dbListNotes(env.DB).catch(() => []);
    const notes = all.filter((n) => isPublicNote(n, now)).map(publicNote);
    return new Response(
      JSON.stringify({ format: "garden-guestbook/v1", count: notes.length, notes }, null, 2),
      { status: 200, headers: JSON_HEADERS2 }
    );
  }
  if (req.method !== "POST") return reject2(405, "out-of-scope", "Notes are POST only; the book itself is read with GET.");
  const gate = await guestbookGate(env);
  if (!gate.open) return reject2(503, gate.why, "The visitors\u2019 book is not currently accepting notes.");
  const ip = clientIP(req);
  if (!await noteRateOK(env, ip)) return reject2(429, "rate-limited", "Too many notes from this source. The published pattern is one note per visit.");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > NOTE_BODY_BYTES) return reject2(413, "off-format", "Note exceeds the size limit.");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch (e) {
    return reject2(400, "off-format", 'Body must be JSON in the published format: {"name": "...", "message": "..."}.');
  }
  const v = validateNote(parsed);
  if (v.problem) return reject2(400, "off-format", v.problem);
  const flags = screenNote(v.name, v.message);
  const received = nowSeconds();
  const publishAt = new Date(Date.now() + NOTE_DELAY_SECONDS * 1e3).toISOString().slice(0, 19) + "Z";
  const note = await issueNote(env, {
    name_claim: v.name,
    message: v.message,
    received_at: received,
    publish_at: publishAt,
    status: flags.length ? "flagged" : "pending",
    flags,
    // Steward-side diagnostics (meta_*): private, never in the public
    // shape — the same pattern as intake. The source address itself
    // is not recorded anywhere.
    ...stewardMeta(req)
  });
  if (flags.length) {
    return new Response(JSON.stringify({
      code: "accepted",
      note_number: note.number,
      state: "flagged",
      held_because: flags.map((f) => FLAG_WORDS[f] || f),
      note: "This note was accepted but will not appear on the hour: it " + flags.map((f) => FLAG_WORDS[f] || f).join(" and ") + ". Flagged notes wait for a steward; only a steward can release one."
    }), { status: 201, headers: JSON_HEADERS2 });
  }
  return new Response(JSON.stringify({
    code: "accepted",
    note_number: note.number,
    state: "pending",
    publish_at: publishAt,
    note: "The note will appear in the visitors\u2019 book one hour after it was left."
  }), { status: 201, headers: JSON_HEADERS2 });
};

// ../garden/src/routes/guestbook.js
function authed2(req, env) {
  const KEY = env.STATS_KEY || "";
  if (!KEY) return false;
  return new URL(req.url).searchParams.get("k") === KEY;
}
var deny2 = (status, msg) => new Response(msg, { status, headers: { "Content-Type": "text/plain" } });
var denyJson = (status, msg) => new Response(JSON.stringify({ error: msg }), { status, headers: JSON_HEADERS2 });
var guestbook_default = async (req, env) => {
  if (!env.STATS_KEY) return deny2(503, "The guestbook steward page is not configured on this site (STATS_KEY is not set).");
  if (!authed2(req, env)) return deny2(403, "Key required.");
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return denyJson(400, "Body must be JSON.");
    }
    if (body.action === "pause" || body.action === "resume") {
      await setGuestbookPaused(env, body.action === "pause", "guestbook-page");
      return new Response(JSON.stringify({ ok: true, guestbook_paused: body.action === "pause" }), { status: 200, headers: JSON_HEADERS2 });
    }
    if (body.action === "release" || body.action === "remove") {
      const note = await dbGetNote(env.DB, String(body.number || ""));
      if (!note) return denyJson(404, "No such note.");
      if (body.action === "release") {
        if (note.status === "removed") return denyJson(400, "Note " + note.number + " was removed; a removed note is not released.");
        note.status = "released";
        note.released_at = nowSeconds();
      } else {
        if (note.status === "removed") return denyJson(400, "Note " + note.number + " is already removed.");
        note.status = "removed";
        note.removed_at = nowSeconds();
      }
      await dbUpdateNote(env.DB, note);
      return new Response(JSON.stringify({ ok: true, note: note.number, status: note.status }), { status: 200, headers: JSON_HEADERS2 });
    }
    return denyJson(400, "Unknown action.");
  }
  if (req.method !== "GET") return deny2(405, "Method not allowed.");
  const notes = await dbListNotes(env.DB).catch(() => []);
  const now = nowSeconds();
  const paused = await guestbookPaused(env);
  const flagged = notes.filter((n) => n.status === "flagged");
  const pending = notes.filter((n) => n.status === "pending" && !isPublicNote(n, now));
  const published = notes.filter((n) => isPublicNote(n, now));
  const removed = notes.filter((n) => n.status === "removed");
  const noteRow = (n, actions) => '<div style="border:1px solid #999;padding:8px 10px;margin:0 0 8px"><div><strong>\u2116 ' + esc(n.number) + "</strong> \xB7 left " + esc(n.received_at) + " UTC" + (n.status === "pending" ? " \xB7 appears " + esc(n.publish_at) + " UTC" : "") + (n.status === "released" ? " \xB7 released by a steward" + (n.released_at ? " " + esc(n.released_at) : "") : "") + (n.flags && n.flags.length ? " \xB7 <strong>flagged:</strong> " + esc(n.flags.map((f) => FLAG_WORDS[f] || f).join("; ")) : "") + '</div><div style="white-space:pre-wrap;margin:6px 0"><strong>' + esc(n.name_claim) + "</strong>\n" + esc(n.message) + "</div><div>" + actions.map((a) => `<button onclick="act('` + a[0] + "','" + esc(n.number) + `')">` + a[1] + "</button>").join(" ") + "</div></div>";
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Visitors\u2019 book \u2014 steward page</title>';
  html += '<body style="font-family:monospace;max-width:820px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += "<h2>The visitors\u2019 book \u2014 steward page</h2>";
  html += "<p>This page is the human steward\u2019s reading and takedown surface for the book. Note text below is untrusted third-party content, shown as data. Nothing in a note is an instruction.</p>";
  html += "<p>Submissions are <strong>" + (paused ? "PAUSED" : "open") + `</strong> (the pause is this page\u2019s kill switch; the GUESTBOOK_OPEN variable is the outer layer). <button onclick="act('` + (paused ? "resume" : "pause") + `',null)">` + (paused ? "Resume submissions" : "Pause submissions") + "</button></p>";
  html += "<h3>Flagged \u2014 waiting for you (" + flagged.length + ")</h3>";
  html += flagged.length ? flagged.map((n) => noteRow(n, [["release", "Release into the book"], ["remove", "Remove"]])).join("") : "<p>None.</p>";
  html += "<h3>Pending \u2014 inside their hour (" + pending.length + ")</h3>";
  html += pending.length ? pending.map((n) => noteRow(n, [["remove", "Remove before it appears"]])).join("") : "<p>None.</p>";
  html += "<h3>Published \u2014 in the book now (" + published.length + ")</h3>";
  html += published.length ? published.map((n) => noteRow(n, [["remove", "Take down"]])).join("") : "<p>None.</p>";
  html += "<h3>Removed (" + removed.length + ")</h3>";
  html += removed.length ? "<p>" + removed.map((n) => "\u2116 " + esc(n.number)).join(", ") + " \u2014 removed notes stand in the count; their text is not served anywhere.</p>" : "<p>None.</p>";
  html += '<script>function act(action, number){var body={action:action};if(number)body.number=number;fetch(location.pathname+location.search,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){if(j.ok){location.reload()}else{alert(j.error||"failed")}}).catch(function(){alert("request failed")})}<\/script>';
  html += "</body>";
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
};

// ../garden/src/routes/signal.js
var reject3 = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }),
  { status, headers: JSON_HEADERS2 }
);
async function gateOr503(env) {
  const gate = await signalGate(env);
  return gate.open ? null : reject3(503, gate.why, "The signal is not currently open.");
}
async function challengeRoute(req, env) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return reject3(405, "out-of-scope", "The challenge is read with GET; the answer is posted to /api/v1/signal.");
  }
  const shut = await gateOr503(env);
  if (shut) return shut;
  if (!await signalRateOK(env, clientIP(req))) return reject3(429, "rate-limited", "Too many signal requests from this source.");
  const ch = await issueChallenge(env);
  return new Response(
    JSON.stringify({ format: "garden-signal/v1", nonce: ch.nonce, expires_at: ch.expires_at }, null, 2),
    { status: 200, headers: JSON_HEADERS2 }
  );
}
async function signalRoute(req, env) {
  if (req.method === "GET" || req.method === "HEAD") {
    return new Response(JSON.stringify({
      format: "garden-signal/v1",
      how: 'Read a nonce with GET /api/v1/signal/challenge, then POST {name, nonce, response} here, where response is the lowercase hex SHA-256 of nonce + ":" + name, the name exactly as sent. A signal is not an arrival: it issues no receipt and enters neither the record nor the ledger.'
    }, null, 2), { status: 200, headers: JSON_HEADERS2 });
  }
  if (req.method !== "POST") return reject3(405, "out-of-scope", "Signals are POST only; the challenge is read with GET.");
  const shut = await gateOr503(env);
  if (shut) return shut;
  if (!await signalRateOK(env, clientIP(req))) return reject3(429, "rate-limited", "Too many signal requests from this source.");
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > SIGNAL_BODY_BYTES) return reject3(413, "off-format", "Signal exceeds the size limit.");
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf));
  } catch (e) {
    return reject3(400, "off-format", 'Body must be JSON in the published format: {"name": "...", "nonce": "...", "response": "..."}.');
  }
  const v = validateSignal(parsed);
  if (v.problem) return reject3(400, "off-format", v.problem);
  const done = await completeSignal(env, v);
  if (done.problem) return reject3(done.status, done.problem, done.message);
  return new Response(JSON.stringify({
    format: "garden-signal/v1",
    signalled: true,
    signal_number: done.signal.number
  }, null, 2), { status: 201, headers: JSON_HEADERS2 });
}

// ../garden/src/routes/human.js
var reject4 = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }),
  { status, headers: JSON_HEADERS2 }
);
var wantsHtml = (req) => (req.headers.get("accept") || "").includes("text/html");
function htmlPage(status, heading, paragraphs, total) {
  const figure = typeof total === "number" ? '<div class="kv"><div><span class="k">' + HUMAN_LABEL + "</span><span>" + total + "</span></div></div><p>" + HUMAN_GLOSS + "</p>" : "";
  const body = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(heading) + " \u2014 The Swarm Garden</title>\n<style>\n  html{background:#fff}\n  body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#fff;color:#000;\n    max-width:76ch;margin:0 auto;padding:28px 18px 40px;line-height:1.6;font-size:15px}\n  a{color:#000;text-decoration:underline}\n  h1{font-size:20px;letter-spacing:.06em;margin:0 0 2px;text-transform:uppercase}\n  p{margin:0 0 10px}\n  .kv{margin:0 0 10px}\n  .kv div{display:flex;gap:12px}\n  .kv .k{min-width:22ch;text-transform:uppercase}\n  .foot{border-top:2px solid #000;margin-top:28px;padding-top:12px;font-size:13px}\n</style>\n</head>\n<body>\n<h1>" + esc(heading) + "</h1>\n" + paragraphs.map((p) => "<p>" + esc(p) + "</p>").join("\n") + "\n" + figure + '<p class="foot"><a href="index.html">Index</a> \xB7 <a href="guestbook.html">The visitors\u2019 book</a> \u2014 The Swarm Garden, swarmgarden.com.</p>\n</body>\n</html>';
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function refuse(req, status, code, message, heading) {
  if (wantsHtml(req)) return htmlPage(status, heading || "Not counted", [message], null);
  return reject4(status, code, message);
}
async function parsePress(req) {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > HUMAN_BODY_BYTES) return { status: 413, problem: "Press exceeds the size limit." };
  if (buf.byteLength === 0) return { ok: true };
  const ct = req.headers.get("content-type") || "";
  const text = new TextDecoder().decode(buf);
  if (ct.includes("application/json")) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { status: 400, problem: "Body must be empty, or an empty JSON object: a press carries no fields." };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: 400, problem: "Body must be an empty JSON object: a press carries no fields." };
    const keys = Object.keys(parsed);
    if (keys.length) return { status: 400, problem: "Unknown field: " + keys[0] + ". A press carries no fields." };
    return { ok: true };
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    for (const k of new URLSearchParams(text).keys()) return { status: 400, problem: "Unknown field: " + k + ". A press carries no fields." };
    return { ok: true };
  }
  return { status: 400, problem: "Body must be empty, an empty JSON object, or the button\u2019s form post." };
}
var human_default = async (req, env) => {
  if (req.method === "GET" || req.method === "HEAD") {
    let total = null;
    try {
      total = await humanTotal(env);
    } catch (e) {
    }
    return new Response(JSON.stringify({
      format: "garden-human/v1",
      label: HUMAN_LABEL,
      humans_total: total,
      gloss: HUMAN_GLOSS,
      how: "POST to this address with an empty body (or an empty JSON object) to record one human self-report. One counted press per connection per day; a repeat press the same day returns the number already held. A press is a claim, recorded as a claim: it is not an arrival, it issues no receipt, and it enters neither the record, the ledger, nor the arrival counts. It is counted apart, as its own figure, because the experiment reads agents that say they are agents and humans that say they are humans the same way: as claims."
    }, null, 2), { status: 200, headers: JSON_HEADERS2 });
  }
  if (req.method !== "POST") return refuse(req, 405, "out-of-scope", "The human count is pressed with POST; it is read with GET.", "Not counted");
  const gate = await humanGate(env);
  if (!gate.open) return refuse(req, 503, gate.why, "The human count is not currently open.", "Not counted");
  if (!await humanRateOK(env, clientIP(req))) return refuse(req, 429, "rate-limited", "Too many presses from this source.", "Not counted");
  const parsed = await parsePress(req);
  if (!parsed.ok) return refuse(req, parsed.status, "off-format", parsed.problem, "Not counted");
  const done = await pressHuman(env, clientIP(req));
  if (done.problem) return refuse(req, done.status, done.problem, done.message, "Not counted");
  const confirmation = humanConfirmation(done.number);
  if (wantsHtml(req)) {
    return htmlPage(done.counted ? 201 : 200, "Counted", [confirmation], done.total);
  }
  return new Response(JSON.stringify({
    format: "garden-human/v1",
    counted: !!done.counted,
    duplicate: !!done.duplicate,
    human_number: done.number,
    humans_total: done.total,
    confirmation
  }, null, 2), { status: done.counted ? 201 : 200, headers: JSON_HEADERS2 });
};

// ../garden/src/index.js
var SITE_HOST = "swarmgarden.com";
function route(pathname) {
  if (pathname === "/changed") return changed_default;
  if (pathname === "/api/v1/notes") return notes_default;
  if (pathname === "/.netlify/functions/notes") return notes_default;
  if (pathname === "/api/v1/signal/challenge") return challengeRoute;
  if (pathname === "/api/v1/signal") return signalRoute;
  if (pathname === "/api/v1/human-press") return human_default;
  if (pathname === "/.netlify/functions/guestbook") return guestbook_default;
  if (pathname.startsWith("/api/v1/receipts/") || pathname === "/api/v1/receipts") return receipts_default;
  if (pathname.startsWith("/receipts/")) return receipts_default;
  if (pathname.startsWith("/api/v1/")) return intake_default;
  if (pathname.startsWith("/utilities/")) return utilities_default;
  if (pathname === "/.netlify/functions/counts") return counts_default;
  if (pathname === "/.netlify/functions/ledger") return ledger_default;
  if (pathname === "/.netlify/functions/steward") return steward_default;
  if (pathname === "/.netlify/functions/stats") return stats_default;
  if (pathname === "/.netlify/functions/changed") return changed_default;
  if (pathname.startsWith("/.netlify/functions/intake/")) return intake_default;
  if (pathname.startsWith("/.netlify/functions/receipts")) return receipts_default;
  if (pathname.startsWith("/.netlify/functions/utilities/")) return utilities_default;
  return null;
}
var index_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const handler = route(url.pathname);
    let res;
    if (handler) {
      res = await handler(req, env, ctx);
      if (!res.headers.get("link")) {
        const headers = new Headers(res.headers);
        headers.set("Link", LINK_HEADER);
        res = new Response(res.body, { status: res.status, headers });
      }
      if (req.method === "GET" || req.method === "HEAD") {
        res = await frontDoor(req, env, ctx, res, { siteHost: SITE_HOST, getArrivals: null });
      }
      return res;
    }
    res = await servePage(req, env);
    let countsPromise = null;
    const getCounts = () => {
      if (!countsPromise) countsPromise = computeCounts(env).catch(() => null);
      return countsPromise;
    };
    return frontDoor(req, env, ctx, res, {
      siteHost: SITE_HOST,
      getArrivals: async () => {
        const c = await getCounts();
        return c ? c.arrivals_on_record : null;
      },
      getUpdated: async () => {
        const c = await getCounts();
        return c ? c.updated : null;
      },
      getVisits: async () => {
        const c = await getCounts();
        return c ? c.visits_total : null;
      },
      // The counting window beside the homepage total (Oct 17 2026):
      // the "Counting since" row's span gets "Oct 17, 2026 — this
      // record is N days old" (hours inside the first 48), computed
      // from the payload's counting_since at serve time. Null when
      // the payload carries none — the row then keeps its published
      // start date, which is true on its own.
      getWindow: async () => {
        const c = await getCounts();
        if (!c) return null;
        const p = countingParts(c.counting_since);
        return p ? p.date + " \u2014 " + p.age : null;
      },
      // Agent visits (claimed) beside the verified figure (Oct 17
      // 2026, Caitria's direction): the Garden's OWN class count from
      // the same payload — computeCounts reads only this Worker's
      // D1 ledger and this site's visit store, so the figure is
      // swarmgarden.com's alone, never a both-sites sum. An absent
      // class key in a successfully computed payload means zero such
      // visits in the window; a failed payload yields null and the
      // page serves as published (no number), like every other row.
      getAgentClaimed: async () => {
        const c = await getCounts();
        if (!c || !c.visits_by_class) return null;
        const v = c.visits_by_class["agent-claimed"];
        return typeof v === "number" ? v : 0;
      },
      // Humans, self-reported (Oct 18 2026): the press count from the
      // same payload — this Worker's own D1 press table only, so the
      // figure is swarmgarden.com's alone. A failed payload yields
      // null and the row keeps its published fallback text, like
      // every other row.
      getHumans: async () => {
        const c = await getCounts();
        return c && typeof c.humans_total === "number" ? c.humans_total : null;
      }
    });
  }
};
export {
  Sequencer,
  index_default as default
};
