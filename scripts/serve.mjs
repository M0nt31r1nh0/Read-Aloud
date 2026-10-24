// The stable app: serves the last version deployed with `npm run deploy`,
// independent of the development server and of the source being edited.
//
//   /               index.html of the current release (always revalidated)
//   /version.json   which release is current, and which are still kept
//                   (the app polls it)
//   /r/<id>/…       the files of one release; older releases stay available
//                   so a tab still running one keeps working
//   /media/…        pauses other audio while reading (see media.mjs)
//
// Usage: npm start [-- --port 4173]

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMediaRequest } from './media.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployDir = path.join(root, 'deploy');
const releasesDir = path.join(deployDir, 'releases');
const portArg = process.argv.indexOf('--port');
const port = Number(portArg > 0 ? process.argv[portArg + 1] : process.env.PORT || 4173);
// Only this computer can reach it.
const host = '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function current() {
  try {
    return JSON.parse(fs.readFileSync(path.join(deployDir, 'current.json'), 'utf8'));
  } catch {
    return null;
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function sendFile(res, file, cache) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (handleMediaRequest(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  const release = current();

  if (pathname === '/version.json') {
    if (!release) return send(res, 404, 'No version deployed yet', { 'Cache-Control': 'no-store' });
    // Which releases are still here: a tab running one that is not can no
    // longer load its files (to open another PDF) and must update.
    let available = [];
    try {
      available = fs.readdirSync(releasesDir).filter((d) => fs.existsSync(path.join(releasesDir, d, 'index.html')));
    } catch {
      // No releases folder: nothing is available.
    }
    return send(res, 200, JSON.stringify({ ...release, available }), { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  }
  if (pathname === '/' || pathname === '/index.html') {
    if (!release) return send(res, 503, 'No version of PDF Read Aloud has been deployed yet. Run: npm run deploy');
    return sendFile(res, path.join(releasesDir, release.version, 'index.html'), 'no-cache');
  }
  const match = /^\/r\/([\w.-]+)\/(.+)$/.exec(pathname);
  if (match) {
    const dir = path.join(releasesDir, match[1]);
    const file = path.resolve(dir, match[2]);
    if (!file.startsWith(dir + path.sep)) return send(res, 403, 'Forbidden');
    // File names inside a release never change, so they can be cached for good.
    return sendFile(res, file, 'public, max-age=31536000, immutable');
  }
  send(res, 404, 'Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${port} is in use: the stable app may already be running at http://localhost:${port}`);
  else console.error(err);
  process.exit(1);
});

server.listen(port, host, () => {
  const release = current();
  console.log(`PDF Read Aloud (stable) at http://localhost:${port}`);
  console.log(release ? `Serving version ${release.version}. New deployments are picked up without a restart.` : 'Nothing deployed yet: run npm run deploy.');
});
