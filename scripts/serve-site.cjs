'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FILES } = require('./build-site.cjs');

const PUBLIC_FILES = new Set([...FILES.map(([, destination]) => destination), 'data/catalog.json']);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png' };

function createPreviewServer({ root = path.resolve(__dirname, '../dist'), base = '/' } = {}) {
  if (!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(base)) throw new Error('Preview base must be / or a path such as /green-office-envi/.');
  return http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end('Method not allowed');
      return;
    }
    try {
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (base !== '/' && pathname === base.slice(0, -1)) {
        response.writeHead(302, { Location: base + url.search });
        response.end();
        return;
      }
      const file = pathname.startsWith(base) ? pathname.slice(base.length) || 'index.html' : '';
      if (!PUBLIC_FILES.has(file)) throw new Error('Not found');
      const target = path.join(root, file);
      const resolvedRoot = await fs.realpath(root);
      const resolvedTarget = await fs.realpath(target);
      if (!resolvedTarget.startsWith(resolvedRoot + path.sep) || !(await fs.lstat(target)).isFile()) throw new Error('Not found');
      const content = await fs.readFile(target);
      response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': content.length });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  let port = 4173;
  try {
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--port') port = Number(args[++i]);
      else if (args[i] === '--base') options.base = args[++i];
      else throw new Error('Usage: npm run preview -- [--port 4173] [--base /green-office-envi/]');
    }
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Choose a port between 1024 and 65535.');
    const server = createPreviewServer(options);
    server.on('error', () => { console.error('Cannot start preview server. Check the port and build the site first.'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log('Local preview: http://127.0.0.1:' + port + (options.base || '/')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createPreviewServer };
