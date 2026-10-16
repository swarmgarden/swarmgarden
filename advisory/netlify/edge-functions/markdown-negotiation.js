// Markdown content negotiation.
// Agents that prefer Markdown (Claude Code, Cursor, OpenCode, and others)
// announce it with an Accept header but do not guess a .md address.
// When a request for an HTML page genuinely prefers Markdown, serve the
// page's prebuilt Markdown twin at the canonical URL. Everything else
// passes through untouched. Browsers do not prefer Markdown and are
// never negotiated. Negotiated responses are marked no-store so a
// shared cache can never hand raw Markdown to a browser.

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
  if (!md.explicit) return false; // a wildcard mention is not a preference
  const htmlQ = Math.max(
    qFor(entries, "text", "html").q,
    qFor(entries, "application", "xhtml+xml").q
  );
  return md.q >= htmlQ; // ties go to Markdown: naming it signals it can be used
}

function twinPath(pathname) {
  if (pathname === "/" || pathname === "/index.html") return "/index.md";
  if (pathname.endsWith(".html")) return pathname.slice(0, -5) + ".md";
  if (!pathname.includes(".")) return pathname.replace(/\/$/, "") + ".md";
  return null;
}

export default async (request, context) => {
  if (request.method !== "GET" && request.method !== "HEAD") return context.next();
  const url = new URL(request.url);
  const p = url.pathname;
  if (p.startsWith("/.netlify/") || p.startsWith("/.well-known/")) return context.next();
  if (/\.(md|txt|xml|json|svg|jpg|jpeg|png|webp|gif|ico|css|js|map)$/i.test(p)) return context.next();
  if (!prefersMarkdown(request.headers.get("accept"))) return context.next();
  const twin = twinPath(p);
  if (!twin) return context.next();

  const twinUrl = new URL(twin, url);
  const res = await context.next(new Request(twinUrl, { method: "GET" }));
  if (!res.ok) return context.next();

  const body = await res.text();
  const headers = new Headers();
  headers.set("Content-Type", "text/markdown; charset=utf-8");
  headers.set("Vary", "Accept");
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Markdown-Tokens", String(Math.ceil(body.length / 4)));
  headers.set("Link", `<${twin}>; rel="alternate"; type="text/markdown"`);
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(body, { status: 200, headers });
};
