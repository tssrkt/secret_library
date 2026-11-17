import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const host = '127.0.0.1';
const port = Number(process.env.E2E_PORT || 4173);
const privateRoots = new Set(['.git', '.ua', 'node_modules', 'functions', 'apps-script-invite', 'tests', 'temp']);
const privateFiles = new Set(['package.json', 'package-lock.json', 'playwright.config.js', '.firebaserc', 'firebase.json', 'firestore.rules']);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  try {
    const pathname = decodeURIComponent(new URL(request.url, `http://${host}:${port}`).pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const segments = relative.split(/[\\/]/);
    if (segments.some((part) => part.startsWith('.') || part === 'node_modules') ||
        privateRoots.has(segments[0]) || (segments.length === 1 && privateFiles.has(segments[0]))) {
      response.writeHead(404).end('Not found');
      return;
    }

    const filePath = resolve(root, relative);
    if (filePath !== root && !filePath.startsWith(root + sep)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    const details = await stat(filePath);
    if (!details.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const body = request.method === 'HEAD' ? null : await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`E2E static server ready at http://${host}:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
