'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Element } = require('./dom-harness.cjs');
const root = path.resolve(__dirname, '..');

test('about deep link stays readable when catalog is unavailable and has a shareable SIT address', async () => {
  const page = client({ url: 'https://envi.example/repo/sit/?page=about' });
  assert.equal(page.element('aboutPage').hidden, false);
  assert.equal(page.element('energyChartArea').hidden, true);
  assert.equal(page.element('browserPanel').hidden, true);
  assert.equal(page.element('loadingPanel').hidden, true);
  assert.equal(page.element('refreshButton').hidden, true);
  assert.equal(page.element('sidebarAbout').getAttribute('aria-current'), 'page');
  page.next('getDashboardData').failure(new Error('offline'));
  await page.flush();
  assert.equal(page.element('aboutPage').hidden, false);
  assert.equal(page.element('errorPanel').hidden, true);
  assert.equal(page.element('navigationError').hidden, false);
  page.element('copyPageButton').click();
  await page.flush();
  assert.equal(page.clipboardWrites[0], 'https://envi.example/repo/sit/?page=about');
});

test('about navigation discards pending document responses and supports browser back and forward', async () => {
  const page = await boot();
  page.element('categoryNavigation').children[0].click();
  const pending = page.next('getFolderContents');
  page.element('sidebarAbout').click();
  pending.success({ folder: { id: 'category-1', name: 'Old folder' }, items: [], totalItems: 0, breadcrumbs: [] });
  await page.flush();
  assert.equal(page.element('aboutPage').hidden, false);
  assert.equal(page.element('viewTitle').textContent, 'ความเป็นมาของสำนักงานสีเขียว');
  assert.equal(page.element('previewPanel').hidden, true);
  page.element('sidebarHome').click();
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  assert.equal(page.element('aboutPage').hidden, true);
  assert.equal(page.element('energyChartArea').hidden, false);
  assert.equal(page.element('aboutTeaser').hidden, false);
  assert.equal(page.element('refreshButton').hidden, false);
  page.back();
  assert.equal(page.window.location.search, '?page=about');
  assert.equal(page.element('aboutPage').hidden, false);
  page.forward();
  assert.equal(page.element('aboutPage').hidden, true);
});

test('unknown or conflicting content-page routes do not silently show the homepage', () => {
  for (const query of ['?page=unknown', '?page=about&folder=category-1', '?page=about&page=about']) {
    const page = client({ url: 'https://envi.example/repo/sit/' + query });
    assert.equal(page.element('errorPanel').hidden, false);
    assert.equal(page.element('aboutPage').hidden, true);
    assert.equal(page.element('copyPageButton').disabled, true);
  }
});

// Exercise native browser history and asynchronous catalog reads without Google RPC.
// The small DOM double is for behavior checks; it does not render the visual layout.
function client(options = {}) {
  const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1]);
    element.id = match[3];
    element.hidden = /\bhidden\b/.test(match[2]);
    element.disabled = /\bdisabled\b/.test(match[2]);
    elements.set(element.id, element);
  }
  const document = new Element('document');
  Object.assign(document, {
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag),
    body: new Element('body')
  });
  const window = new Element('window');
  const requests = [];
  const refreshes = [];
  const fetches = [];
  let catalogUrl;
  const api = {
    request(method, args) { return new Promise((success, failure) => requests.push({ method, args, success, failure })); },
    refresh() { return new Promise((success, failure) => refreshes.push({ success, failure })); }
  };
  const entries = [options.url || 'https://envi.example/green-office/'];
  let index = 0;
  const updateLocation = url => { window.location = new URL(url); };
  updateLocation(entries[0]);
  window.history = {
    pushState(state, title, url) { entries.splice(index + 1); entries.push(url); index++; updateLocation(url); },
    replaceState(state, title, url) { entries[index] = url; updateLocation(url); }
  };
  window.GreenOfficeCatalog = { createClient({ url }) { catalogUrl = url; return api; } };
  const clipboardWrites = [];
  const context = vm.createContext({
    document, window, URL, URLSearchParams, Intl, console,
    AbortController, setTimeout, clearTimeout,
    fetch: (url, options) => new Promise((success, failure) => fetches.push({ url, options, success, failure })),
    navigator: { clipboard: { async writeText(value) { clipboardWrites.push(value); } } }
  });
  if (options.realCatalog) {
    vm.runInContext(fs.readFileSync(path.join(root, 'site/catalog.js'), 'utf8'), context, { filename: 'site/catalog.js' });
    window.GreenOfficeCatalog = { createClient(options) {
      catalogUrl = options.url;
      return context.GreenOfficeCatalog.createClient(options);
    } };
  }
  vm.runInContext(fs.readFileSync(path.join(root, 'site/app.js'), 'utf8'), context, { filename: 'site/app.js' });
  document.dispatch('DOMContentLoaded');
  return {
    document, window, requests, refreshes, fetches, clipboardWrites,
    get catalogUrl() { return catalogUrl; },
    get historyLength() { return entries.length; },
    element: id => elements.get(id),
    back() { if (index > 0) { updateLocation(entries[--index]); window.dispatch('popstate'); } },
    forward() { if (index + 1 < entries.length) { updateLocation(entries[++index]); window.dispatch('popstate'); } },
    next(method) {
      const index = requests.findIndex(request => request.method === method);
      assert.notEqual(index, -1, 'Expected catalog request ' + method);
      return requests.splice(index, 1)[0];
    },
    async flush() { await new Promise(resolve => setImmediate(resolve)); }
  };
}

const dashboard = () => ({
  app: { name: 'Green Office', year: '2569' },
  generatedAt: '2026-09-21T03:00:00.000Z',
  criteria: { categoryCount: 7, topicCount: 24, indicatorCount: 65 },
  categories: Array.from({ length: 7 }, (_, i) => ({ number: i + 1, id: 'category-' + (i + 1), name: 'หมวด ' + (i + 1), title: 'เกณฑ์ ' + (i + 1), available: true })),
  warnings: []
});
const item = (overrides = {}) => ({
  id: 'file-1', name: 'หลักฐาน.pdf', kind: 'file', mimeType: 'application/pdf', typeLabel: 'PDF',
  url: 'https://drive.google.com/file/d/file-1/view?resourcekey=resource-key',
  path: 'หมวด 1 / หลักฐาน.pdf', parentId: 'category-1', updatedAt: '2026-09-20T03:00:00.000Z', ...overrides
});
const folder = (items = []) => ({
  folder: { id: 'category-1', name: 'หมวด 1', path: 'หมวด 1', categoryNumber: 1 },
  breadcrumbs: [{ id: 'category-1', name: 'หมวด 1' }], items, nextPageToken: null
});
const file = () => ({ item: item(), folder: folder().folder, breadcrumbs: folder().breadcrumbs });
function snapshot() {
  const metadata = dashboard();
  metadata.app.institution = 'คณะสิ่งแวดล้อม';
  const items = metadata.categories.map(category => ({
    id: category.id, name: category.name, kind: 'folder', mimeType: 'application/vnd.google-apps.folder',
    typeLabel: 'Folder', updatedAt: metadata.generatedAt, url: 'https://drive.google.com/drive/folders/' + category.id,
    parentId: null, categoryNumber: category.number
  }));
  items.push({ ...items[0], id: 'nested-folder', name: 'หลักฐานพลังงาน', parentId: 'category-1', url: 'https://drive.google.com/drive/folders/nested-folder' });
  items.push(item({ categoryNumber: 1, parentId: 'nested-folder', url: 'https://drive.google.com/open?id=file-1&resourcekey=resource-key' }));
  return { schemaVersion: 1, ...metadata, items };
}
async function respondCatalog(page, data = snapshot()) {
  const pending = page.fetches.shift();
  assert.ok(pending, 'Expected a catalog fetch');
  pending.success({ ok: true, status: 200, json: async () => data });
  await page.flush();
}
async function boot(options) {
  const page = client(options);
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  return page;
}

test('static shell uses supplied image URLs and no templating or runtime Apps Script', () => {
  const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'site/app.js'), 'utf8');
  assert.doesNotMatch(html + script, /<\?|google\.script|data:image\//);
  assert.doesNotMatch(html, /\?{3,}|<body>"/);
  assert.match(html, /<title>Green Office คณะสิ่งแวดล้อม \| 2569<\/title>/);
  assert.match(html, /src="assets\/images\/green-office-building\.png"/);
  assert.match(html, /src="assets\/images\/logo\.png"/);
  assert.ok(html.indexOf('src="catalog.js"') < html.indexOf('src="app.js"'));
});

test('SIT filters replace stale previews, expose selected Word files and reset when navigating to another folder', async () => {
  const page = client({ url: 'https://envi.example/repo/sit/?folder=nested-folder', realCatalog: true });
  const data = snapshot();
  data.items.push(item({ id: 'word-1', name: 'บันทึก.docx', mimeType: 'application/msword', typeLabel: 'Word', categoryNumber: 1, parentId: 'nested-folder', url: 'https://drive.google.com/open?id=word-1' }));
  await respondCatalog(page, data);
  assert.equal(page.catalogUrl, 'https://envi.example/repo/sit/data/catalog.json');
  assert.equal(page.element('listingControls').hidden, false);
  assert.match(page.element('listingStats').textContent, /ทั้งหมด 2/);
  assert.match(page.element('listingUpdated').textContent, /แก้ไขล่าสุด/);
  assert.equal(page.element('previewPanel').hidden, false);
  page.element('fileTypeFilter').value = 'word';
  page.element('fileTypeFilter').dispatch('change');
  await page.flush();
  assert.equal(page.element('previewPanel').hidden, true);
  assert.equal(page.element('previewFrameWrap').children.length, 0);
  assert.equal(page.element('wordList').hidden, false);
  assert.equal(page.element('wordList').children.length, 1);
  assert.equal(page.element('parentLink').hidden, false);
  assert.equal(page.fetches.length, 0);
  page.element('resetFilters').click();
  await page.flush();
  assert.equal(page.element('fileTypeFilter').value, 'all');
  assert.equal(page.element('wordList').hidden, true);
  page.element('fileSort').value = 'updated';
  page.element('fileSort').dispatch('change');
  await page.flush();
  page.element('parentLink').click();
  await page.flush();
  assert.equal(page.element('fileSort').value, 'name');
  assert.equal(page.window.location.pathname, '/repo/sit/');
});

test('filtered empty search remains recoverable and preserves search breadcrumb and parent link', async () => {
  const page = client({ url: 'https://envi.example/repo/sit/?q=' + encodeURIComponent('หลักฐาน.pdf'), realCatalog: true });
  await respondCatalog(page);
  page.element('fileTypeFilter').value = 'image';
  page.element('fileTypeFilter').dispatch('change');
  await page.flush();
  assert.equal(page.element('emptyPanel').hidden, false);
  assert.match(page.element('emptyTitle').textContent, /ประเภทที่เลือก/);
  assert.equal(page.element('parentLink').hidden, false);
  assert.ok(page.element('breadcrumbs').children.length);
  assert.match(page.element('listingStats').textContent, /ทั้งหมด 1/);
  page.element('resetFilters').click();
  await page.flush();
  assert.equal(page.element('emptyPanel').hidden, true);
  assert.equal(page.element('previewPanel').hidden, false);
});

test('homepage preserves blank energy area and uses repo-relative data and native links', async () => {
  const page = await boot();
  assert.equal(page.catalogUrl, 'https://envi.example/green-office/data/catalog.json');
  assert.equal(page.element('energyChartArea').hidden, false);
  assert.equal(page.element('energyChartArea').children.length, 0);
  assert.equal(page.element('catalogUpdated').getAttribute('datetime'), dashboard().generatedAt);
  const links = page.element('categoryNavigation').children;
  assert.equal(links.length, 7);
  assert.equal(links[0].href, 'https://envi.example/green-office/?folder=category-1');
  for (const action of [{ ctrlKey: true }, { metaKey: true }, { button: 1 }]) {
    assert.equal(links[0].dispatch('click', action).defaultPrevented, false);
  }
  assert.equal(page.requests.length, 0);
  links[0].click();
  page.next('getFolderContents').success(folder());
  await page.flush();
  assert.equal(page.window.location.search, '?folder=category-1');
  assert.equal(page.element('categoryOverview').hidden, false);
  page.back();
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  assert.equal(page.element('energyChartArea').hidden, false);
  page.forward();
  page.next('getFolderContents').success(folder());
  await page.flush();
  assert.equal(page.element('categoryOverview').hidden, false);
  assert.equal(page.historyLength, 2);
});

test('direct PDF links work at index.html under repo and retain preview resource key and share URL', async () => {
  const page = client({ url: 'https://envi.example/repo/index.html?file=file-1' });
  assert.equal(page.catalogUrl, 'https://envi.example/repo/data/catalog.json');
  page.next('getFileDetails').success(file());
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  assert.equal(page.element('previewPanel').hidden, false);
  assert.match(page.element('previewFrameWrap').children[0].src, /\/file-1\/preview\?resourcekey=resource-key$/);
  page.element('copyPageButton').click();
  await page.flush();
  assert.deepEqual(page.clipboardWrites, ['https://envi.example/repo/index.html?file=file-1']);
  assert.equal(page.element('parentLink').href, 'https://envi.example/repo/index.html?folder=category-1');
});

test('late errors and sidebar metadata cannot replace the current page', async () => {
  const page = client({ url: 'https://envi.example/repo/?folder=category-1' });
  const oldFolder = page.next('getFolderContents');
  const oldMenu = page.next('getDashboardData');
  page.element('sidebarHome').click();
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  oldFolder.failure(new Error('old failure'));
  const oldData = dashboard();
  oldData.categories[0].title = 'Stale';
  oldMenu.success(oldData);
  await page.flush();
  assert.equal(page.element('errorPanel').hidden, true);
  assert.doesNotMatch(page.element('categoryNavigation').textContent, /Stale/);
  assert.equal(page.element('energyChartArea').hidden, false);
});

test('refresh waits for fresh catalog before reloading route and menu; failed refresh can retry', async () => {
  const page = await boot();
  page.element('categoryNavigation').children[0].click();
  page.next('getFolderContents').success(folder());
  await page.flush();
  page.element('refreshButton').click();
  assert.equal(page.refreshes.length, 1);
  assert.equal(page.requests.length, 0);
  assert.equal(page.element('refreshButton').disabled, true);
  page.refreshes.shift().success();
  await page.flush();
  page.next('getFolderContents').success(folder([item()]));
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  assert.equal(page.element('previewPanel').hidden, false);
  assert.equal(page.historyLength, 2);
  page.element('refreshButton').click();
  page.refreshes.shift().failure(new Error('เครือข่ายไม่พร้อม'));
  await page.flush();
  assert.equal(page.element('errorPanel').hidden, false);
  assert.equal(page.element('refreshButton').disabled, false);
  page.element('retryButton').click();
  assert.equal(page.refreshes.length, 1);
});

test('vertical image gallery, PDF and collapsed Word remain available together', async () => {
  const page = client({ url: 'https://envi.example/repo/?folder=category-1' });
  const images = [1, 2].map(i => item({ id: 'img-' + i, name: i + '.png', mimeType: 'image/png', typeLabel: 'PNG' }));
  page.next('getFolderContents').success(folder([item(), ...images, item({ id: 'word-1', name: 'ต้นฉบับ.docx', typeLabel: 'Word' })]));
  page.next('getDashboardData').success(dashboard());
  await page.flush();
  assert.equal(page.element('previewPanel').hidden, false);
  assert.equal(page.element('imageGallery').hidden, false);
  assert.equal(page.element('imageGalleryList').children.length, 2);
  const frames = page.element('imageGalleryList').querySelectorAll('iframe');
  assert.equal(frames.length, 2);
  assert.ok(frames.every(frame => frame.getAttribute('loading') === 'lazy'));
  assert.equal(page.element('wordSection').hidden, false);
  assert.equal(page.element('wordList').hidden, true);
  page.element('wordToggle').click();
  assert.equal(page.element('wordList').hidden, false);
});

test('invalid duplicate routes do not request catalog content; missing catalog explains setup state', async () => {
  const invalid = client({ url: 'https://envi.example/repo/?folder=a&folder=b' });
  assert.equal(invalid.requests.length, 0);
  assert.equal(invalid.element('errorPanel').hidden, false);
  const page = client();
  page.next('getDashboardData').failure(Object.assign(new Error('missing'), { code: 'CATALOG_NOT_CONFIGURED' }));
  await page.flush();
  assert.match(page.element('errorMessage').textContent, /ยังไม่มีสารบัญเอกสาร/);
  assert.equal(page.element('loadingPanel').hidden, true);
});

test('search normalizes Thai query and respects repo route when submitted by keyboard', async () => {
  const page = await boot();
  page.element('searchInput').value = '  น้ำ  ';
  const event = page.element('searchForm').dispatch('submit');
  assert.equal(event.defaultPrevented, true);
  const request = page.next('searchDrive');
  assert.equal(request.args[0], 'น้ำ');
  assert.equal(new URL(page.window.location.href).searchParams.get('q'), 'น้ำ');
  request.success({ items: [], complete: true, scannedFolders: 7 });
  await page.flush();
  assert.equal(page.element('emptyPanel').hidden, false);
  assert.equal(page.element('categoryOverview').hidden, true);
});

test('search pagination describes known catalog results without claiming another Drive scan', async () => {
  const page = await boot();
  page.element('searchInput').value = 'หลักฐาน';
  page.element('searchForm').dispatch('submit');
  page.next('searchDrive').success({ items: [item()], totalItems: 81, nextPageToken: 'next-page', complete: false });
  await page.flush();
  assert.match(page.element('resultSummary').textContent, /แสดง 1 จาก 81 รายการ/);
  assert.equal(page.element('pagination').hidden, false);
  assert.equal(page.element('loadMoreButton').textContent, 'แสดงรายการเพิ่มเติม');
  assert.doesNotMatch(page.element('paginationMessage').textContent, /สแกน|ค้นหาไม่ครบ/);
});

test('actual catalog adapter shares one fetch for deep file and sidebar, then resolves folder and history locally', async () => {
  for (const suffix of ['/', '/index.html']) {
    const page = client({ realCatalog: true, url: 'https://envi.example/repo' + suffix + '?file=file-1' });
    assert.equal(page.fetches.length, 1);
    assert.equal(page.fetches[0].url, 'https://envi.example/repo/data/catalog.json');
    assert.equal(page.fetches[0].options.credentials, 'omit');
    await respondCatalog(page);
    assert.equal(page.element('previewPanel').hidden, false);
    assert.equal(page.element('viewTitle').textContent, 'หลักฐาน.pdf');
    assert.match(page.element('previewFrameWrap').children[0].src, /resourcekey=resource-key/);
    assert.equal(page.element('categoryNavigation').children[0].getAttribute('aria-current'), 'location');
    page.element('parentLink').click();
    await page.flush();
    assert.equal(page.element('viewTitle').textContent, 'หลักฐานพลังงาน');
    assert.equal(page.element('categoryOverview').hidden, true);
    assert.equal(page.window.location.pathname, '/repo' + suffix);
    page.element('parentLink').click();
    await page.flush();
    assert.equal(page.element('viewTitle').textContent, 'หมวด 1');
    assert.equal(page.element('categoryOverview').hidden, false);
    assert.match(page.element('fileList').querySelector('a').href, /\?folder=nested-folder$/);
    page.back();
    await page.flush();
    assert.equal(page.element('viewTitle').textContent, 'หลักฐานพลังงาน');
    page.back();
    await page.flush();
    assert.equal(page.element('viewTitle').textContent, 'หลักฐาน.pdf');
    assert.equal(page.fetches.length, 0, 'Ordinary navigation must use loaded catalog');
  }
});

test('actual adapter refresh failure retains prior document and recovers with updated menu and deleted item state', async () => {
  const page = client({ realCatalog: true, url: 'https://envi.example/repo/?file=file-1' });
  await respondCatalog(page);
  page.element('refreshButton').click();
  page.fetches.shift().failure(new Error('offline'));
  await page.flush();
  assert.equal(page.element('errorPanel').hidden, false);
  assert.equal(page.element('previewPanel').hidden, false);
  assert.equal(page.element('catalogUpdated').getAttribute('datetime'), snapshot().generatedAt);
  page.element('retryButton').click();
  const replacement = snapshot();
  replacement.generatedAt = '2026-09-21T04:00:00.000Z';
  replacement.categories[0].title = 'หมวดปรับปรุงล่าสุด';
  replacement.items.pop();
  await respondCatalog(page, replacement);
  assert.match(page.element('errorMessage').textContent, /ไม่พบรายการนี้/);
  assert.equal(page.element('previewPanel').hidden, true);
  assert.match(page.element('categoryNavigation').textContent, /หมวดปรับปรุงล่าสุด/);
  assert.equal(page.element('catalogUpdated').getAttribute('datetime'), replacement.generatedAt);
  page.element('sidebarHome').click();
  await page.flush();
  assert.equal(page.element('errorPanel').hidden, true);
  assert.equal(page.fetches.length, 0);
});

test('actual adapter refresh and navigation race shows fresh menu while retaining the chosen route', async () => {
  const page = client({ realCatalog: true });
  await respondCatalog(page);
  page.element('refreshButton').click();
  page.element('categoryNavigation').children[0].click();
  assert.equal(page.window.location.search, '?folder=category-1');
  assert.equal(page.fetches.length, 1, 'Navigation must share the pending refresh');
  const replacement = snapshot();
  replacement.generatedAt = '2026-09-21T04:00:00.000Z';
  replacement.categories[0].title = 'เกณฑ์ฉบับปรับปรุง';
  await respondCatalog(page, replacement);
  assert.equal(page.window.location.search, '?folder=category-1');
  assert.equal(page.element('viewTitle').textContent, 'หมวด 1');
  assert.equal(page.element('categoryBannerTitle').textContent, 'เกณฑ์ฉบับปรับปรุง');
  assert.match(page.element('categoryNavigation').textContent, /เกณฑ์ฉบับปรับปรุง/);
  assert.equal(page.element('refreshButton').disabled, false);
  assert.equal(page.fetches.length, 0);
});
