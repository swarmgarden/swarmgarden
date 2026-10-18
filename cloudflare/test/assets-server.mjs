// Local stand-in for the Workers Assets binding, used ONLY by the test
// harness. Miniflare 4's `assets` option intercepts every request in
// front of the user Worker (runWorkerFirst had no effect in local
// testing), which makes front-door verification impossible; so the
// harness binds ASSETS to this plain file server instead. The Worker
// code under test calls env.ASSETS.fetch(...) identically either way.
// Production asset behaviour (headers, html_handling, 404 page) is a
// Phase 4 staging-verify item; the real config is validated locally
// by `wrangler deploy --dry-run`.
import { promises as fs } from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.json': 'application/json', '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.css': 'text/css', '.js': 'text/javascript'
};

export function assetsService(rootDir) {
  return async (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(rootDir, p);
    if (!file.startsWith(rootDir)) return new Response('not found', { status: 404 });
    try {
      const data = await fs.readFile(file);
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Content-Length': String(data.byteLength) };
      if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(data, { status: 200, headers });
    } catch (e) {
      return new Response('not found', { status: 404 });
    }
  };
}
