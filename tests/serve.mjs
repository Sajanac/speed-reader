// Minimal static server for tests. Usage: node tests/serve.mjs <root> <port> [coop]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dir, port, coop] = process.argv.slice(2);
const root = path.resolve(dir);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.bcmap': 'application/octet-stream' };
http
  .createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(root, p);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      const headers = { 'content-type': types[path.extname(file)] || 'application/octet-stream' };
      if (coop) headers['cross-origin-opener-policy'] = 'same-origin';
      res.writeHead(200, headers).end(data);
    });
  })
  .listen(Number(port), '127.0.0.1');
