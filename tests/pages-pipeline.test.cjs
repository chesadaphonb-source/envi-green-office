'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { checkedEndpoint, fetchCatalog, fetchCatalogWithRetry, writeCatalog, MAX_BYTES } = require('../scripts/fetch-catalog.cjs');
const { buildSite, FILES } = require('../scripts/build-site.cjs');
const { createPreviewServer } = require('../scripts/serve-site.cjs');

const PROJECT = path.resolve(__dirname, '..');
const ENDPOINT = 'https://script.google.com/macros/s/test_deployment/exec';
const TOKEN = 'a-test-token-that-is-at-least-32-characters';
const NOW = Date.parse('2026-09-21T08:00:00Z');
const FRESH = { generatedAt: new Date(NOW).toISOString() };
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const requestOptions = more => ({ url: ENDPOINT, token: TOKEN, now: NOW, validate: value => value, ...more });

test('catalog token is posted only to the configured canonical endpoint, then omitted on the Content Service redirect', async () => {
  const calls = [];
  const result = await fetchCatalog(requestOptions({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: 'https://script.googleusercontent.com/macros/echo?user_content_key=temporary' } }) : jsonResponse(FRESH);
  } }));
  assert.deepEqual(result, FRESH);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { token: TOKEN });
  assert.equal(calls[1].options.method, 'GET');
  assert.equal(calls[1].options.body, undefined);
  assert.equal(JSON.stringify(calls[1]).includes(TOKEN), false);
  assert.equal(calls[0].options.redirect, 'manual');
});

test('export refuses untrusted endpoints and redirects before a secret can be forwarded', async () => {
  for (const url of ['http://script.google.com/macros/s/abc/exec', ENDPOINT + '?token=x', ENDPOINT.replace('/macros/', '/macros/u/1/'), 'https://script.google.com.attacker.test/macros/s/abc/exec']) {
    assert.throws(() => checkedEndpoint(url));
  }
  for (const [status, location] of [[302, 'https://accounts.google.com/signin'], [303, 'https://example.test/steal'], [307, 'https://script.googleusercontent.com/macros/echo']]) {
    let calls = 0;
    await assert.rejects(fetchCatalog(requestOptions({ fetchImpl: async () => {
      calls += 1;
      return new Response(null, { status, headers: { Location: location } });
    } })));
    assert.equal(calls, 1);
  }
});

test('bad exports never replace the previously validated local catalog', async t => {
  const root = await temporary(t);
  const destination = path.join(root, 'catalog.json');
  await writeCatalog({ old: 'retained' }, destination);
  const cases = [
    () => new Response('<html>Google sign-in</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response('broken', { headers: { 'Content-Type': 'application/json' } }),
    () => jsonResponse({ generatedAt: '2026-09-01T00:00:00Z' }),
    () => jsonResponse({ generatedAt: '2026-10-01T00:00:00Z' }),
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_BYTES + 1) } })
  ];
  for (const response of cases) {
    await assert.rejects(fetchCatalog(requestOptions({ fetchImpl: async () => response() })).then(snapshot => writeCatalog(snapshot, destination)));
    assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { old: 'retained' });
  }
  await assert.rejects(fetchCatalog(requestOptions({ fetchImpl: async () => jsonResponse({ error: 'secret server detail' }), validate: () => { throw new Error('secret server detail'); } })), error => {
    assert.equal(error.message.includes('secret server detail'), false);
    return true;
  });
});

test('export deadline aborts an unresponsive server', async () => {
  await assert.rejects(fetchCatalog(requestOptions({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) })), /timed out/);
});

test('a transient Google redirect is retried at the canonical endpoint without following the rejected destination', async () => {
  const calls = [];
  const result = await fetchCatalogWithRetry(requestOptions({ fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://script.googleusercontent.com/macros/echo?user_content_key=temporary' } });
    if (calls.length === 2) return new Response(null, { status: 302, headers: { Location: 'https://script.google.com/error' } });
    return jsonResponse(FRESH);
  } }), { delay: async () => {} });
  assert.deepEqual(result, FRESH);
  assert.deepEqual(calls.map(call => call.url), [ENDPOINT, 'https://script.googleusercontent.com/macros/echo?user_content_key=temporary', ENDPOINT]);
  assert.equal(calls[1].body, undefined);
  assert.deepEqual(JSON.parse(calls[2].body), { token: TOKEN });
});

test('persistent export failures stop after three attempts and preserve the last good catalog', async t => {
  const destination = path.join(await temporary(t), 'catalog.json');
  await writeCatalog({ old: 'retained' }, destination);
  let calls = 0;
  await assert.rejects(fetchCatalogWithRetry(requestOptions({ fetchImpl: async () => {
    calls++;
    return new Response('Service unavailable', { status: 503 });
  } }), { delay: async () => {} }).then(snapshot => writeCatalog(snapshot, destination)));
  assert.equal(calls, 3);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { old: 'retained' });
});

test('production output contains only the allowlisted frontend, assets and validated catalog', async t => {
  const root = await projectFixture(t);
  const raw = validCatalog();
  raw.privateSetting = 'DO_NOT_PUBLISH';
  const catalogPath = path.join(root, '.local/catalog.json');
  await fs.writeFile(catalogPath, JSON.stringify(raw));
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist/old-secret.txt'), 'DO_NOT_PUBLISH');
  await buildSite({ root });
  const files = await filesUnder(path.join(root, 'dist'));
  assert.deepEqual(files.sort(), [...FILES.map(([, destination]) => destination), '.nojekyll', 'data/catalog.json'].sort());
  const published = await fs.readFile(path.join(root, 'dist/data/catalog.json'), 'utf8');
  assert.equal(published.includes('DO_NOT_PUBLISH'), false);
  assert.equal(JSON.parse(published).schemaVersion, 1);
});

test('production refuses missing or stale data and preserves the last complete build', async t => {
  const root = await projectFixture(t);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.writeFile(path.join(root, 'dist/index.html'), 'last completed build');
  await assert.rejects(buildSite({ root }), /valid catalog/);
  assert.equal(await fs.readFile(path.join(root, 'dist/index.html'), 'utf8'), 'last completed build');
  const raw = validCatalog();
  raw.generatedAt = '2020-01-01T00:00:00Z';
  await fs.writeFile(path.join(root, '.local/catalog.json'), JSON.stringify(raw));
  await assert.rejects(buildSite({ root }), /valid catalog/);
  assert.equal(await fs.readFile(path.join(root, 'dist/index.html'), 'utf8'), 'last completed build');
});

test('layout preview has no real or invented catalog and works under a repository path', async t => {
  const root = await projectFixture(t);
  await buildSite({ root, preview: true });
  await assert.rejects(fs.access(path.join(root, 'dist/data/catalog.json')));
  const server = createPreviewServer({ root: path.join(root, 'dist'), base: '/green-office-envi/' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(origin + '/green-office-envi/?folder=category_1')).status, 200);
  assert.equal((await fetch(origin + '/green-office-envi/assets/images/KU%20copy.jpg')).status, 200);
  assert.equal((await fetch(origin + '/green-office-envi/data/catalog.json')).status, 404);
  assert.equal((await fetch(origin + '/green-office-envi/.clasprc.json')).status, 404);
  assert.equal((await fetch(origin + '/green-office-envi/%2e%2e%2f.env')).status, 404);
  assert.equal((await fetch(origin + '/green-office-envi/app.js', { method: 'POST' })).status, 405);
});

async function temporary(t) {
  const staging = path.join(PROJECT, '.local');
  await fs.mkdir(staging, { recursive: true });
  const root = await fs.mkdtemp(path.join(staging, 'pipeline-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function projectFixture(t) {
  const root = await temporary(t);
  await fs.mkdir(path.join(root, '.local'));
  for (const [source] of FILES) {
    const target = path.join(root, source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (source === 'site/catalog.js') await fs.copyFile(path.join(PROJECT, source), target);
    else await fs.writeFile(target, source === 'site/index.html' ? '<!doctype html><title>Preview fixture</title>' : 'fixture');
  }
  await fs.writeFile(path.join(root, '.env'), 'DO_NOT_PUBLISH');
  await fs.writeFile(path.join(root, 'Code.gs'), 'DO_NOT_PUBLISH');
  return root;
}

function validCatalog() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, generatedAt: now,
    app: { name: 'Green Office', year: '2569', institution: 'คณะสิ่งแวดล้อม' },
    criteria: { categoryCount: 7, topicCount: 24, indicatorCount: 65 },
    categories: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, name: 'หมวด' + (i + 1), title: 'หัวข้อ ' + (i + 1), id: i === 0 ? 'category_1' : null, available: i === 0, issue: i === 0 ? null : 'ไม่พบโฟลเดอร์' })),
    warnings: [],
    items: [{ id: 'category_1', name: 'หมวด1', kind: 'folder', mimeType: 'application/vnd.google-apps.folder', typeLabel: 'Folder', updatedAt: now, url: 'https://drive.google.com/drive/folders/category_1', path: 'หมวด1', parentId: null, categoryNumber: 1 }]
  };
}

async function filesUnder(directory, prefix = '') {
  const result = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isDirectory()) result.push(...await filesUnder(path.join(directory, item.name), relative + '/'));
    else result.push(relative);
  }
  return result;
}
