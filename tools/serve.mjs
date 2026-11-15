// Tiny static file server for local development. Usage: node tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] ?? process.env.PORT ?? 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.allium': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // /test/ serves the same files, like the deployed test build (the app switches to test mode by its URL).
  if (path === '/test') { res.writeHead(301, { Location: '/test/' }).end(); return; }
  const isTest = /^\/test(\/|$)/.test(path);
  if (isTest) path = path.slice(5) || '/';
  if (path.endsWith('/')) path += 'index.html';
  if (isTest && path === '/manifest.webmanifest') path = '/manifest.test.webmanifest';
  const file = normalize(join(root, path));
  const rel = file.slice(root.length);
  if (!file.startsWith(root + sep) || rel.split(/[\\/]/).some((p) => p.startsWith('.') || p === 'node_modules')) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Pawsterior on http://localhost:${port}`));
