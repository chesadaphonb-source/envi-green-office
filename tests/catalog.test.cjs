'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCatalog, createIndex, createClient } = require('../site/catalog.js');

function fixture() {
  const generatedAt = '2026-09-21T00:00:00.000Z';
  const categories = Array.from({ length: 7 }, (_, i) => ({ number: i + 1, name: 'หมวด ' + (i + 1), title: 'หัวข้อ ' + (i + 1), id: 'cat' + (i + 1), available: true, issue: null }));
  const items = categories.map(category => ({ id: category.id, name: category.name, kind: 'folder', mimeType: 'application/vnd.google-apps.folder',
    typeLabel: 'Folder', updatedAt: generatedAt, url: 'https://drive.google.com/drive/folders/' + category.id,
    path: category.name, parentId: null, categoryNumber: category.number }));
  items.push({ id: 'nested', name: 'พลังงาน', kind: 'folder', mimeType: 'application/vnd.google-apps.folder', typeLabel: 'Folder', updatedAt: generatedAt,
    url: 'https://drive.google.com/drive/folders/nested', path: 'ignored incoming path', parentId: 'cat3', categoryNumber: 3 });
  items.push({ id: 'document', name: 'การใช้ไฟฟ้า 2569.pdf', kind: 'file', mimeType: 'application/pdf', typeLabel: 'PDF', updatedAt: generatedAt,
    url: 'https://drive.google.com/open?id=document&resourcekey=0-test', path: '', parentId: 'nested', categoryNumber: 3 });
  return { schemaVersion: 1, generatedAt, app: { name: 'Green Office', year: '2569', institution: 'คณะสิ่งแวดล้อม' },
    criteria: { categoryCount: 7, topicCount: 24, indicatorCount: 65 }, categories, items, warnings: [] };
}

test('normalizes only approved fields and reconstructs folder ancestry for direct file routes', () => {
  const raw = fixture();
  raw.secret = 'must not publish'; raw.items[8].ownerEmail = 'private@example.test';
  const catalog = validateCatalog(raw);
  assert.equal(catalog.secret, undefined);
  assert.equal(catalog.items[8].ownerEmail, undefined);
  assert.equal(catalog.items[8].path, 'หมวด 3 / พลังงาน / การใช้ไฟฟ้า 2569.pdf');
  const details = createIndex(raw).request('getFileDetails', ['document']);
  assert.deepEqual(details.breadcrumbs.map(item => item.id), ['cat3', 'nested']);
  assert.equal(details.folder.categoryNumber, 3);
  assert.match(details.item.url, /resourcekey=0-test/);
  assert.equal(details.generatedAt, raw.generatedAt);
});

test('rejects orphan, cycle, category crossing, duplicate and unpublished roots', () => {
  for (const change of [
    raw => { raw.items[8].parentId = 'outside'; },
    raw => { raw.items[7].parentId = 'nested'; },
    raw => { raw.items[8].parentId = 'cat1'; },
    raw => { raw.items.push({ ...raw.items[8] }); },
    raw => { raw.categories[2] = { ...raw.categories[2], available: false, id: null }; },
    raw => { raw.items[8].parentId = null; },
    raw => { raw.categories[0].number = 2; },
    raw => { raw.items[7].mimeType = 'application/pdf'; }
  ]) {
    const raw = fixture(); change(raw); assert.throws(() => validateCatalog(raw));
  }
});

test('rejects misleading or unsafe Drive URLs and shortcuts', () => {
  for (const url of ['javascript:alert(1)', 'https://drive.google.com.evil.test/open?id=document',
    'https://drive.google.com/open?id=another', 'https://user@drive.google.com/open?id=document',
    'https://drive.google.com/open?id=document&id=another', 'https://drive.google.com/open?id=document&token=secret']) {
    const raw = fixture(); raw.items[8].url = url; assert.throws(() => validateCatalog(raw));
  }
  const raw = fixture(); raw.items[8].mimeType = 'application/vnd.google-apps.shortcut';
  assert.throws(() => validateCatalog(raw));
});

test('folder pagination globally sorts names and validates cursor scope and generation', () => {
  const raw = fixture();
  for (let i = 170; i >= 1; i--) raw.items.push({ ...raw.items[8], id: 'file' + i, name: 'ไฟล์ ' + i + '.pdf', url: 'https://drive.google.com/open?id=file' + i });
  const index = createIndex(raw);
  const first = index.request('getFolderContents', ['nested']);
  const second = index.request('getFolderContents', ['nested', first.nextPageToken]);
  const third = index.request('getFolderContents', ['nested', second.nextPageToken]);
  const all = [...first.items, ...second.items, ...third.items];
  assert.equal(new Set(all.map(item => item.id)).size, 171);
  assert.equal(third.nextPageToken, null);
  assert.ok(all.findIndex(item => item.id === 'file2') < all.findIndex(item => item.id === 'file10'));
  assert.throws(() => index.request('getFolderContents', ['cat1', first.nextPageToken]), { code: 'INVALID_CURSOR' });
  raw.generatedAt = '2026-09-21T01:00:00.000Z';
  assert.throws(() => createIndex(raw).request('getFolderContents', ['nested', first.nextPageToken]), { code: 'INVALID_CURSOR' });
});

test('search uses Thai names, complete flags, empty results and safe text', () => {
  const raw = fixture();
  raw.items[8].name = '<img onerror=alert(1)> การใช้ไฟฟ้า.PDF';
  const index = createIndex(raw);
  const result = index.request('searchDrive', ['  ไฟฟ้า.pdf  ']);
  assert.equal(result.items.length, 1);
  assert.equal(result.complete, true);
  assert.match(result.items[0].name, /^<img/); // Rendering uses textContent, never HTML.
  assert.equal(index.request('searchDrive', ['missing']).items.length, 0);
  assert.equal(index.request('searchDrive', ['  ']).items.length, 0);
  assert.throws(() => index.request('getFileDetails', ['outside']), { code: 'NOT_FOUND' });
  result.items[0].name = 'changed by renderer';
  assert.notEqual(index.request('getFileDetails', ['document']).item.name, 'changed by renderer');
});

test('client fetches once for concurrent views; navigation uses in-memory index', async () => {
  let calls = 0;
  let requestOptions;
  const client = createClient({ url: 'https://example.test/green-office/data/catalog.json', fetch: async (_, options) => {
    calls++; requestOptions = options;
    return { ok: true, json: async () => fixture() };
  } });
  await Promise.all([client.request('getDashboardData'), client.request('getFileDetails', ['document'])]);
  await client.request('searchDrive', ['ไฟฟ้า']);
  assert.equal(calls, 1);
  assert.equal(requestOptions.credentials, 'omit');
  assert.equal(requestOptions.cache, 'no-cache');
});

test('refresh replaces snapshot only after validation; failure preserves last good index', async () => {
  let payload = fixture();
  const client = createClient({ url: 'catalog.json', fetch: async () => ({ ok: true, json: async () => payload }) });
  await client.request('getDashboardData');
  payload = { schemaVersion: 1 };
  await assert.rejects(client.refresh());
  assert.equal((await client.request('getFileDetails', ['document'])).item.id, 'document');
  payload = fixture(); payload.items.pop(); payload.generatedAt = '2026-09-21T02:00:00.000Z';
  await client.refresh();
  await assert.rejects(client.request('getFileDetails', ['document']), { code: 'NOT_FOUND' });
  payload = fixture();
  await assert.rejects(client.refresh(), { code: 'STALE_CATALOG' });
});

test('missing preview catalog and malformed errors are clear and never leak remote details', async () => {
  const missing = createClient({ url: 'catalog.json', fetch: async () => ({ ok: false, status: 404 }) });
  await assert.rejects(missing.request('getDashboardData'), { code: 'CATALOG_NOT_CONFIGURED' });
  const bad = createClient({ url: 'catalog.json', fetch: async () => { throw new Error('secret URL'); } });
  await assert.rejects(bad.refresh(), cause => cause.code === 'CATALOG_UNAVAILABLE' && !cause.message.includes('secret'));
});

module.exports = { fixture };
