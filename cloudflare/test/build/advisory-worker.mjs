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

// ../advisory/src/lib/human.js
import { createHash } from "node:crypto";
var sha256hex = (data) => createHash("sha256").update(data).digest("hex");
var nowSeconds = () => (/* @__PURE__ */ new Date()).toISOString().slice(0, 19) + "Z";
var pad6 = (n) => String(n).padStart(6, "0");
var HUMAN_BODY_BYTES = 4096;
var HUMAN_RATE = { perMinute: 3, perHour: 20, perDayGlobal: 300 };
var HUMAN_LABEL = "Humans, self-reported";
var HUMAN_GLOSS = "(a claim, like every other claim here \u2014 it sorts the weather; it does not verify anyone)";
var humanConfirmation = (number) => "Counted. You are now part of the weather: one claimed human. This proves nothing \u2014 a machine could press this button, and the record will say so right next to your number. Claimed human \u2116 " + number + ". The agents get a receipt for arriving. You get a number for saying so. Fair is fair.";
async function getState(db, key) {
  const row = await db.prepare("SELECT data FROM site_state WHERE key = ?1").bind(key).first();
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch (e) {
    return null;
  }
}
async function setState(db, key, value) {
  await db.prepare("INSERT INTO site_state (key, data) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data = excluded.data").bind(key, JSON.stringify(value)).run();
}
async function humanGate(env) {
  if (!env || env.HUMAN_OPEN !== "true") return { open: false, why: "human-not-open" };
  try {
    const st = await getState(env.DB, "human");
    if (st && st.paused) return { open: false, why: "human-paused" };
  } catch (e) {
  }
  return { open: true };
}
async function setHumanPaused(env, paused, by) {
  await setState(env.DB, "human", { paused: !!paused, by: by || "steward", at: (/* @__PURE__ */ new Date()).toISOString() });
}
var humanIpDigest = (ip) => sha256hex("advisory-human-rate:" + String(ip || "unknown")).slice(0, 32);
async function bumpRate(db, key, bucketMs) {
  await db.prepare(
    "INSERT INTO human_rate (key, bucket_ms, count) VALUES (?1, ?2, 1) ON CONFLICT(key, bucket_ms) DO UPDATE SET count = count + 1"
  ).bind(key, bucketMs).run();
  const row = await db.prepare("SELECT count FROM human_rate WHERE key = ?1 AND bucket_ms = ?2").bind(key, bucketMs).first();
  return row ? Number(row.count) || 0 : 0;
}
async function humanRateOK(env, ip) {
  const db = env.DB;
  const k = humanIpDigest(ip);
  const now = Date.now();
  const perMin = await bumpRate(db, "hum-m:" + k, Math.floor(now / 6e4) * 6e4);
  if (perMin > HUMAN_RATE.perMinute) return false;
  const perHour = await bumpRate(db, "hum-h:" + k, Math.floor(now / 36e5) * 36e5);
  if (perHour > HUMAN_RATE.perHour) return false;
  try {
    await db.prepare("DELETE FROM human_rate WHERE bucket_ms < ?1").bind(now - 1728e5).run();
  } catch (e) {
  }
  return true;
}
async function humanTotal(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM human_presses").first();
  return row ? Number(row.n) || 0 : 0;
}
async function pressHuman(env, ip) {
  const db = env.DB;
  const day = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const digest = humanIpDigest(ip);
  const existing = await db.prepare("SELECT number FROM human_press_dedupe WHERE digest = ?1 AND day = ?2").bind(digest, day).first().catch(() => null);
  if (existing) return { duplicate: true, number: existing.number, total: await humanTotal(env).catch(() => 0) };
  const countedRow = await db.prepare("SELECT COUNT(*) AS n FROM human_presses WHERE day = ?1").bind(day).first().catch(() => null);
  if ((countedRow ? Number(countedRow.n) || 0 : 0) >= HUMAN_RATE.perDayGlobal) {
    return { problem: "daily-cap", status: 429, message: "The daily cap for the human count has been reached. The count resumes tomorrow." };
  }
  const pressedAt = nowSeconds();
  const ins = await db.prepare("INSERT INTO human_presses (number, pressed_at, day, data) VALUES (NULL, ?1, ?2, ?3)").bind(pressedAt, day, "").run();
  const seq = ins && ins.meta ? Number(ins.meta.last_row_id) : 0;
  if (!seq) return { problem: "press-conflict", status: 409, message: "That press could not be recorded. Press again." };
  const number = pad6(seq);
  try {
    await db.batch([
      db.prepare("UPDATE human_presses SET number = ?2, data = ?3 WHERE seq = ?1").bind(seq, number, JSON.stringify({ number, pressed_at: pressedAt, day })),
      db.prepare("INSERT INTO human_press_dedupe (digest, day, number) VALUES (?1, ?2, ?3)").bind(digest, day, number)
    ]);
  } catch (e) {
    await db.prepare("DELETE FROM human_presses WHERE seq = ?1").bind(seq).run().catch(() => {
    });
    const winner = await db.prepare("SELECT number FROM human_press_dedupe WHERE digest = ?1 AND day = ?2").bind(digest, day).first().catch(() => null);
    if (winner) return { duplicate: true, number: winner.number, total: await humanTotal(env).catch(() => 0) };
    return { problem: "press-conflict", status: 409, message: "That press collided with another from the same connection. Press again." };
  }
  try {
    await db.prepare("DELETE FROM human_press_dedupe WHERE day < ?1").bind(day).run();
  } catch (e) {
  }
  return { counted: true, number, total: await humanTotal(env).catch(() => 0) };
}

// ../advisory/src/routes/stats.js
async function loadVisits(env) {
  const recs = await readRecentVisits(env, 1500);
  return recs.sort((a, b) => a.t < b.t ? -1 : 1);
}
async function loadArrivals(env) {
  try {
    const origin = env.COUNTS_ORIGIN || "https://swarmgarden.com";
    const r = await fetch(origin + "/.netlify/functions/counts");
    if (r.ok) {
      const j = await r.json();
      if (typeof j.arrivals_on_record === "number") return j.arrivals_on_record;
    }
  } catch (e) {
  }
  return null;
}
function aggregate(recs) {
  const byClass = {}, byDay = {}, byPath = {}, interest = {}, byPurpose = {}, byBehaviour = {}, byStatus = {}, byCountry = {}, byRef = {}, byEvent = {};
  let edge = 0;
  for (const r of recs) {
    byClass[r.cls] = (byClass[r.cls] || 0) + 1;
    if (r.purpose) byPurpose[r.purpose] = (byPurpose[r.purpose] || 0) + 1;
    const bl = behaviourLabel(r);
    byBehaviour[bl] = (byBehaviour[bl] || 0) + 1;
    if (Number.isInteger(r.status)) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    const d = (r.t || "").slice(0, 10);
    byDay[d] = (byDay[d] || 0) + 1;
    byPath[r.path] = (byPath[r.path] || 0) + 1;
    if (r.country) byCountry[r.country] = (byCountry[r.country] || 0) + 1;
    if (r.ref) {
      try {
        const h = new URL(r.ref).host;
        if (h) byRef[h] = (byRef[h] || 0) + 1;
      } catch (e) {
      }
    }
    if (r.event) byEvent[r.event] = (byEvent[r.event] || 0) + 1;
    if (r.via === "edge") edge++;
    if (INTEREST.some((s) => (r.path || "").includes(s))) interest[r.path] = (interest[r.path] || 0) + 1;
  }
  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    total: recs.length,
    byClass,
    byPurpose,
    byBehaviour,
    byStatus,
    byDay,
    topPaths: top(byPath, 12),
    interest: top(interest, 12),
    topCountries: top(byCountry, 12),
    topReferrers: top(byRef, 12),
    byEvent,
    edge,
    beacon: 0
    // the beacon write path is not carried over; every record is edge-written
  };
}
var stats_default = async (req, env) => {
  const KEY = env.STATS_KEY || "";
  const url = new URL(req.url);
  if (!KEY || url.searchParams.get("k") !== KEY) return new Response("Key required.", { status: 403, headers: { "Content-Type": "text/plain" } });
  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: "Body must be JSON." }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    if (body.action === "human-pause" || body.action === "human-resume") {
      await setHumanPaused(env, body.action === "human-pause", "stats-route");
      return new Response(JSON.stringify({ ok: true, human_paused: body.action === "human-pause" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: "Unknown action." }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  let recs;
  try {
    recs = await loadVisits(env);
  } catch (e) {
    return new Response("Storage read failed. Visit records are also in the Worker logs (search VISIT).", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  const agg = aggregate(recs);
  const arrivals = await loadArrivals(env);
  const humans = await humanTotal(env).catch(() => null);
  if (url.searchParams.get("format") === "json") {
    return new Response(JSON.stringify({ arrivals_on_record: arrivals, humans_self_reported: humans, ...agg, recent: recs.slice(-50).reverse() }, null, 2), { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }
  const esc3 = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const list = (pairs) => pairs.map(([k, v]) => "<li>" + esc3(k) + ": " + v + "</li>").join("");
  let html = '<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="60"><title>Bay Area Swarm Warning \u2014 live dashboard</title>';
  html += '<body style="font-family:monospace;max-width:980px;margin:24px auto;padding:0 16px;line-height:1.5">';
  html += "<h2>Bay Area Swarm Warning \u2014 live dashboard</h2>";
  html += "<p>Refreshed " + esc3((/* @__PURE__ */ new Date()).toISOString()) + " (auto-refresh 60s). Arrivals on record: <strong>" + (arrivals === null ? "unavailable" : arrivals) + "</strong> \u2014 the record, from the ledger. Everything below is requests, not arrivals.</p>";
  html += "<p>Humans, self-reported (this site&rsquo;s own button presses): <strong>" + (humans === null ? "unavailable" : humans) + "</strong> \u2014 a claim-tier count; it sorts claims and verifies no one.</p>";
  html += "<h3>Requests \u2014 claimed class totals (" + agg.total + " total; all edge-written)</h3><ul>" + list(Object.entries(agg.byClass)) + "</ul>";
  html += "<p>Human/automation reads are classifications by claimed user-agent (single-source taxonomy) plus edge bot signals \u2014 a stated basis, not a certainty.</p>";
  if (Object.keys(agg.byPurpose).length) html += "<h3>Agent-claimed, by purpose</h3><ul>" + list(Object.entries(agg.byPurpose)) + "</ul>";
  html += "<h3>Behaviour labels (computed over held records)</h3><ul>" + list(Object.entries(agg.byBehaviour)) + "</ul>";
  if (Object.keys(agg.byStatus).length) html += "<h3>Response status totals</h3><ul>" + list(Object.entries(agg.byStatus)) + "</ul>";
  if (Object.keys(agg.byEvent).length) html += "<h3>Named events</h3><ul>" + list(Object.entries(agg.byEvent)) + "</ul>";
  html += "<h3>Agent-interest files</h3>" + (agg.interest.length ? "<ul>" + list(agg.interest) + "</ul>" : "<p>None yet.</p>");
  html += "<h3>Top pages</h3><ul>" + list(agg.topPaths) + "</ul>";
  html += "<h3>Top countries (edge geo)</h3>" + (agg.topCountries.length ? "<ul>" + list(agg.topCountries) + "</ul>" : "<p>None yet.</p>");
  html += "<h3>Top referrers</h3>" + (agg.topReferrers.length ? "<ul>" + list(agg.topReferrers) + "</ul>" : "<p>None yet.</p>");
  html += "<h3>By day</h3><ul>" + list(Object.entries(agg.byDay).sort()) + "</ul>";
  html += '<h3>Most recent 50 requests</h3><table border="1" cellspacing="0" cellpadding="4"><tr><th>time (UTC)</th><th>class</th><th>purpose</th><th>behaviour</th><th>status</th><th>event</th><th>page</th><th>country</th><th>referrer</th><th>user-agent (as claimed)</th></tr>';
  for (const r of recs.slice(-50).reverse()) html += "<tr><td>" + esc3(r.t) + "</td><td>" + esc3(r.cls) + "</td><td>" + esc3(r.purpose || "\u2014") + "</td><td>" + esc3(behaviourLabel(r)) + "</td><td>" + esc3(r.status === null || r.status === void 0 ? "\u2014" : r.status) + "</td><td>" + esc3(r.event || "pageview") + "</td><td>" + esc3(r.path) + "</td><td>" + esc3(r.country) + "</td><td>" + esc3(r.ref) + "</td><td>" + esc3(r.ua) + "</td></tr>";
  html += "</table><p>Labels describe what each request\u2019s user-agent claims. A claim is not a verification.</p></body>";
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
};

// ../advisory/src/routes/human.js
var JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
var esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function clientIP(req) {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-nf-client-connection-ip") || (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
var reject = (status, code, message) => new Response(
  JSON.stringify({ code, error: message }),
  { status, headers: JSON_HEADERS }
);
var wantsHtml = (req) => (req.headers.get("accept") || "").includes("text/html");
function htmlPage(status, heading, paragraphs, total) {
  const figure = typeof total === "number" ? '<p class="fig"><span class="n">' + total + '</span> <span class="l">' + HUMAN_LABEL + '</span><br><span class="g">' + esc(HUMAN_GLOSS) + "</span></p>" : "";
  const body = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(heading) + ' \u2014 Bay Area Swarm Warning</title>\n<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@700;900&family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans:wght@400;600&display=swap" rel="stylesheet">\n<style>\n  body{margin:0;background:#f4f1e6;color:#141a38;font-family:"IBM Plex Sans",-apple-system,"Segoe UI",sans-serif}\n  .wrap{max-width:720px;margin:0 auto;padding:36px 18px 48px}\n  h1{font-family:"Archivo",sans-serif;font-weight:900;text-transform:uppercase;color:#2b1b8f;font-size:40px;margin:0 0 12px}\n  p{font-size:16px;line-height:1.55;max-width:62ch}\n  .fig .n{font-family:"IBM Plex Mono",monospace;font-size:34px;font-weight:600;color:#2b1b8f}\n  .fig .l{font-family:"Archivo",sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-size:13px}\n  .fig .g{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:#5d6b82}\n  .foot{margin-top:28px;font-family:"IBM Plex Mono",monospace;font-size:12px;color:#5d6b82;text-transform:uppercase;letter-spacing:.05em}\n  a{color:#2b1b8f}\n</style>\n</head>\n<body>\n<div class="wrap">\n<h1>' + esc(heading) + "</h1>\n" + paragraphs.map((p) => "<p>" + esc(p) + "</p>").join("\n") + "\n" + figure + '<p class="foot">Bay Area Swarm Warning &bull; <a href="index.html">Bulletin No. 001</a> &bull; <a href="dashboard.html">Arrival Record</a> &bull; The Garden: <a href="https://swarmgarden.com">swarmgarden.com</a></p>\n</div>\n</body>\n</html>';
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
function refuse(req, status, code, message, heading) {
  if (wantsHtml(req)) return htmlPage(status, heading || "Not counted", [message], null);
  return reject(status, code, message);
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
      how: "POST to this address with an empty body (or an empty JSON object) to record one human self-report. One counted press per connection per day; a repeat press the same day returns the number already held. A press is a claim, recorded as a claim: it is not an arrival, it issues no receipt, and it enters neither the record, the ledger, nor the arrival counts. This count is this site\u2019s own; the Garden keeps its own, and the two never merge."
    }, null, 2), { status: 200, headers: JSON_HEADERS });
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
  }, null, 2), { status: done.counted ? 201 : 200, headers: JSON_HEADERS });
};

// ../shared/counting.mjs
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
function countingSentence(sinceIso, now) {
  const p = countingParts(sinceIso, now);
  return p ? "Counting since " + p.date + " \u2014 " + p.age : null;
}

// ../advisory/src/counter.js
var CLASSES = [
  ["browser", "Browser"],
  ["agent-claimed", "Agent-claimed"],
  ["automation", "Automation"],
  ["unknown", "Unknown"]
];
var CLASS_GLOSS = { "agent-claimed": "a claim, not proof" };
var MONTHS2 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var fmt = (n) => Number(n || 0).toLocaleString("en-US");
var esc2 = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function asOf(iso) {
  const d = new Date(iso || Date.now());
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return MONTHS2[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() + ", " + hh + ":" + mm + " UTC";
}
function classRows(c) {
  const by = c.visits_by_class || {};
  const rows = CLASSES.map(([key, label]) => ({ key, label, v: by[key] || 0 }));
  const sum = rows.reduce((a, r) => a + r.v, 0);
  const denom = c.visits_total || sum || 0;
  for (const r of rows) r.pct = denom ? 100 * r.v / denom : 0;
  return rows;
}
function namesLine(byName, limit) {
  return Object.entries(byName || {}).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([name, n]) => esc2(name) + " " + fmt(n)).join(" &middot; ");
}
function agentFilesTotal(c) {
  return Object.values(c.agent_interest_files || {}).reduce((a, b) => a + (b || 0), 0);
}
function counterBlockHtml(c, humans) {
  const rows = classRows(c);
  const segs = rows.filter((r) => r.v > 0).map((r) => '<span class="bw-seg seg-' + r.key + '" style="flex:' + r.v + ' 1 0" aria-hidden="true"></span>').join("");
  const aria = "Recorded visits by claimed class: " + rows.map((r) => r.label + " " + fmt(r.v)).join("; ") + ".";
  const key = rows.map(
    (r) => '<span><span class="bw-key seg-' + r.key + '"></span>' + r.label + " &mdash; " + fmt(r.v) + " &middot; " + r.pct.toFixed(1) + "%" + (CLASS_GLOSS[r.key] ? ' <span class="bw-count-gloss">(' + CLASS_GLOSS[r.key] + ")</span>" : "") + "</span>"
  ).join("");
  const crawlers = c.crawlers_claimed || { total: 0, by_name: {} };
  const crawlerNames = namesLine(crawlers.by_name, 4);
  const crawlerLine = crawlers.total > 0 ? '<p class="bw-count-line"><strong>Claimed crawlers: ' + fmt(crawlers.total) + (crawlers.total === 1 ? " visit" : " visits") + "</strong>" + (crawlerNames ? " &mdash; " + crawlerNames + "." : ".") + " A crawler name is what the visit&rsquo;s own software announced &mdash; a claim, not a verification.</p>" : '<p class="bw-count-line"><strong>Claimed crawlers: none yet.</strong> No visit has announced a crawler name. When one does, it will be printed here as what it is &mdash; a claim, not a verification.</p>';
  const fetchers = c.fetchers_claimed || { total: 0, by_name: {} };
  const fetcherNames = namesLine(fetchers.by_name, 4);
  const fetcherLine = fetchers.total > 0 ? '<p class="bw-count-line"><strong>Fetcher visits: ' + fmt(fetchers.total) + "</strong>" + (fetcherNames ? " &mdash; " + fetcherNames + "." : ".") + " A fetcher acts on a specific person&rsquo;s request, so it is counted apart from crawlers.</p>" : "";
  const files = agentFilesTotal(c);
  const filesLine = '<p class="bw-count-line"><strong>The agent-facing files were read ' + fmt(files) + (files === 1 ? " time" : " times") + "</strong> &mdash; robots.txt, llms.txt, the agent card, the published skills, the sitemap: the files written for agents to read.</p>";
  const humanLine = typeof humans === "number" ? '<p class="bw-count-line"><strong>Humans, self-reported: <span data-humans-figure>' + fmt(humans) + '</span></strong> <span class="bw-count-gloss">(a claim, like every other claim here &mdash; it sorts the weather; it does not verify anyone)</span> Counted by the button below, on this site, from its own record &mdash; not the Garden&rsquo;s.</p>' : "";
  const win = countingSentence(c.counting_since);
  return '<h3>The count &mdash; live from the Garden record</h3><div class="bw-count-pair"><div class="bw-count-f"><span class="bw-count-n">' + fmt(c.arrivals_on_record) + '</span><span class="bw-count-l">Verified arrivals</span></div><div class="bw-count-f"><span class="bw-count-n">' + fmt(c.visits_total) + '</span><span class="bw-count-l">Total recorded visits</span></div></div><div class="bw-comp" role="img" aria-label="' + esc2(aria) + '">' + segs + '</div><div class="bw-comp-key">' + key + "</div>" + crawlerLine + fetcherLine + filesLine + humanLine + '<p class="bw-count-note">' + esc2(c.visits_window_note || "") + (win ? " " + esc2(win) + "." : "") + " As of " + asOf(c.updated) + ' &mdash; live from the Garden record at swarmgarden.com; the record runs a minute or two behind the visits themselves. The full record: <a href="dashboard.html">the Arrival Record</a>.</p>';
}
function counterBlockText(c, humans) {
  const rows = classRows(c);
  const breakdown = rows.map((r) => r.label + " " + fmt(r.v) + (CLASS_GLOSS[r.key] ? " (" + CLASS_GLOSS[r.key] + ")" : "")).join(" \xB7 ");
  const crawlers = c.crawlers_claimed || { total: 0, by_name: {} };
  const crawlerNames = Object.entries(crawlers.by_name || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => name + " " + fmt(n)).join(" \xB7 ");
  const fetchers = c.fetchers_claimed || { total: 0, by_name: {} };
  const fetcherNames = Object.entries(fetchers.by_name || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, n]) => name + " " + fmt(n)).join(" \xB7 ");
  const lines = [
    "## The count",
    "",
    "Live from the Garden record, as of " + asOf(c.updated) + " (the record runs a minute or two behind the visits themselves):",
    "",
    "- Verified arrivals: " + fmt(c.arrivals_on_record),
    "- Total recorded visits: " + fmt(c.visits_total) + " \u2014 " + breakdown
  ];
  const winText = countingSentence(c.counting_since);
  if (winText) lines.push("- " + winText + ".");
  lines.push(
    crawlers.total > 0 ? "- Claimed crawlers: " + fmt(crawlers.total) + (crawlerNames ? " \u2014 " + crawlerNames : "") + ". A crawler name is what the visit\u2019s software announced; a claim, not a verification." : "- Claimed crawlers: none yet. A crawler name, when one appears, is what the visit\u2019s software announced; a claim, not a verification."
  );
  if (fetchers.total > 0) {
    lines.push("- Fetcher visits: " + fmt(fetchers.total) + (fetcherNames ? " \u2014 " + fetcherNames : "") + ". A fetcher acts on a specific person\u2019s request, so it is counted apart from crawlers.");
  }
  lines.push("- The agent-facing files (robots.txt, llms.txt, the agent card, the published skills, the sitemap) were read " + fmt(agentFilesTotal(c)) + " times.");
  if (typeof humans === "number") {
    lines.push("- Humans, self-reported: " + fmt(humans) + " \u2014 a claim, like every other claim here; it sorts the weather; it does not verify anyone. Counted by the button on this site, from its own record \u2014 not the Garden\u2019s.");
  }
  lines.push("");
  lines.push((c.visits_window_note || "") + " The full record: https://swarmgarden.com/record.html");
  return lines.join("\n");
}
var COUNTER_TEXT_FALLBACK = [
  "## The count",
  "",
  "The live figures are published on the Garden\u2019s record: https://swarmgarden.com/record.html"
].join("\n");

// ../advisory/src/index.js
var SITE_HOST = "bayareaswarmwarning.com";
var index_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/.netlify/functions/stats") {
      const res2 = await stats_default(req, env, ctx);
      if (!res2.headers.get("link")) {
        const headers = new Headers(res2.headers);
        headers.set("Link", LINK_HEADER);
        return new Response(res2.body, { status: res2.status, headers });
      }
      return res2;
    }
    if (url.pathname === "/api/v1/human-press") {
      const res2 = await human_default(req, env, ctx);
      if (!res2.headers.get("link")) {
        const headers = new Headers(res2.headers);
        headers.set("Link", LINK_HEADER);
        return new Response(res2.body, { status: res2.status, headers });
      }
      return res2;
    }
    const res = await servePage(req, env);
    let countsPromise = null;
    const getCounts = () => {
      if (!countsPromise) {
        countsPromise = (async () => {
          try {
            const origin = env.COUNTS_ORIGIN || "https://swarmgarden.com";
            const r = await fetch(origin + "/.netlify/functions/counts", { headers: { accept: "application/json" } });
            if (r.ok) {
              const j = await r.json();
              if (j && typeof j.arrivals_on_record === "number") return j;
            }
          } catch (e) {
          }
          return null;
        })();
      }
      return countsPromise;
    };
    let humansPromise = null;
    const getHumansLocal = () => {
      if (!humansPromise) humansPromise = humanTotal(env).catch(() => null);
      return humansPromise;
    };
    return frontDoor(req, env, ctx, res, {
      siteHost: SITE_HOST,
      getArrivals: async () => {
        const c = await getCounts();
        return c ? c.arrivals_on_record : null;
      },
      getCounterBlock: async () => {
        const c = await getCounts();
        return c ? counterBlockHtml(c, await getHumansLocal()) : null;
      },
      getCounterText: async () => {
        const c = await getCounts();
        return c ? counterBlockText(c, await getHumansLocal()) : COUNTER_TEXT_FALLBACK;
      }
    });
  }
};
export {
  index_default as default
};
