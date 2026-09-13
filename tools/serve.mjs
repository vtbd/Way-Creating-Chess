/**
 * Zero-dependency static file server for local testing.
 *
 * ES modules and Web Workers need an `http://` origin, so double-clicking
 * `index.html` will not work. Run this instead:
 *
 *   node tools/serve.mjs [port]
 *
 * Then open http://localhost:8000/.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.argv[2] || process.env.PORT || 8000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const relative = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let target = resolve(join(root, relative || 'index.html'));
  if (!target.startsWith(root)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
  if (!existsSync(target)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(target).pipe(response);
}).listen(port, () => {
  console.log(`Way Creating Chess 本地预览：http://localhost:${port}/`);
});
