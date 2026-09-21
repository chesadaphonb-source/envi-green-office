'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('./dom-harness.cjs');

const dashboard = () => ({
  app: { name: 'Green Office คณะสิ่งแวดล้อม', year: '2569', institution: 'มหาวิทยาลัยเกษตรศาสตร์' },
  criteria: { categoryCount: 7, topicCount: 24, indicatorCount: 65 },
  categories: Array.from({ length: 7 }, (_, index) => ({
    number: index + 1, id: 'category-' + (index + 1), name: 'หมวด ' + (index + 1),
    title: 'เกณฑ์การประเมิน ' + (index + 1), available: true, issue: null
  })),
  warnings: []
});
const item = (overrides = {}) => ({
  id: 'file-1', name: 'หลักฐาน.pdf', kind: 'file', mimeType: 'application/pdf', typeLabel: 'PDF',
  updatedAt: '2026-09-11T08:15:00.000Z', url: 'https://drive.google.com/open?id=file-1',
  path: 'หมวด1 / หลักฐาน.pdf', parentId: 'category-1', ...overrides
});
const folderPage = (items = [], extra = {}) => ({
  folder: { id: 'category-1', name: 'หมวด1', path: 'หมวด1', categoryNumber: 1 },
  breadcrumbs: [{ id: 'category-1', name: 'หมวด1' }], items, nextPageToken: null, ...extra
});
const filePage = (file = item()) => ({ item: file, folder: folderPage().folder, breadcrumbs: folderPage().breadcrumbs });
async function boot(data = dashboard()) {
  const client = createClient();
  client.next('getDashboardData').success(data);
  await client.flush();
  return client;
}
async function enterFirstCategory(client) {
  const card = client.find('categoryNavigation', element => element.tagName === 'A');
  assert.ok(card, 'Sidebar must contain a category link');
  card.click();
  await client.flush();
  return client.next('getFolderContents');
}
async function startSearch(client, query) {
  client.element('searchInput').value = query;
  client.element('searchForm').dispatch('submit');
  await client.flush();
  return client.next('searchDrive');
}

test('sidebar links switch categories, support native modified clicks and follow browser history', async () => {
  const client = await boot();
  const links = client.element('categoryNavigation').children;
  assert.equal(links.length, 7);
  assert.equal(client.element('sidebarHome').getAttribute('aria-current'), 'page');
  assert.match(links[3].href, /\?folder=category-4$/);
  assert.equal(links[3].dispatch('click', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(client.requests.length, 0);
  links[3].click();
  const response = folderPage([], { folder: { id: 'category-4', name: 'หมวด4', path: 'หมวด4', categoryNumber: 4 }, breadcrumbs: [{ id: 'category-4', name: 'หมวด4' }] });
  client.next('getFolderContents').success(response);
  assert.equal(links[3].getAttribute('aria-current'), 'page');
  assert.equal(client.element('sidebarHome').getAttribute('aria-current'), null);
  assert.equal(client.element('categoryOverview').hidden, false);
  assert.equal(client.element('categoryBadge').textContent, '4');
  assert.equal(client.element('categoryBannerTitle').textContent, dashboard().categories[3].title);
  client.back();
  client.next('getDashboardData').success(dashboard());
  assert.equal(client.element('categoryOverview').hidden, true);
  assert.equal(client.element('sidebarHome').getAttribute('aria-current'), 'page');
  client.forward();
  client.next('getFolderContents').success(response);
  assert.equal(client.element('categoryNavigation').children[3].getAttribute('aria-current'), 'page');
});

test('all category overviews use their own guidance and nested documents retain menu context without the overview', async () => {
  const client = await boot();
  const goals = new Set();
  for (let number = 1; number <= 7; number++) {
    client.element('categoryNavigation').children[number - 1].click();
    client.next('getFolderContents').success(folderPage([], { folder: { id: 'category-' + number, name: 'หมวด' + number, path: 'หมวด' + number, categoryNumber: number }, breadcrumbs: [{ id: 'category-' + number, name: 'หมวด' + number }] }));
    assert.equal(client.element('categoryBadge').textContent, String(number));
    assert.equal(client.element('categoryHighlights').children.length, 3);
    goals.add(client.element('categoryGoal').textContent);
  }
  assert.equal(goals.size, 7);
  client.element('categoryNavigation').children[0].click();
  client.next('getFolderContents').success(folderPage([item({ id: 'child-folder', name: 'โฟลเดอร์ย่อย', kind: 'folder' })]));
  client.find('fileList', el => el.tagName === 'A').click();
  client.next('getFolderContents').success(folderPage([item()], { breadcrumbs: [{ id: 'category-1', name: 'หมวด1' }, { id: 'child-folder', name: 'โฟลเดอร์ย่อย' }] }));
  assert.equal(client.element('categoryOverview').hidden, true);
  assert.equal(client.element('categoryNavigation').children[0].getAttribute('aria-current'), 'location');
  await startSearch(client, 'เอกสาร');
  assert.equal(client.element('categoryOverview').hidden, true);
  assert.ok(client.element('categoryNavigation').children.every(el => !el.getAttribute('aria-current')));
});

test('direct document navigation and sidebar loading are independent, with isolated menu retry', () => {
  const client = createClient({ parameters: { file: 'deep-pdf' } });
  const doc = client.next('getFileDetails');
  const menu = client.next('getDashboardData');
  doc.success(filePage(item({ id: 'deep-pdf' })));
  menu.failure(new Error('Menu unavailable'));
  assert.equal(client.element('previewPanel').hidden, false);
  assert.equal(client.element('errorPanel').hidden, true);
  assert.equal(client.element('navigationError').hidden, false);
  client.element('navigationRetry').click();
  client.next('getDashboardData').success(dashboard());
  assert.equal(client.element('navigationError').hidden, true);
  assert.equal(client.element('categoryNavigation').children[0].getAttribute('aria-current'), 'location');
  assert.equal(client.element('categoryOverview').hidden, true);
  assert.deepEqual(client.route(), { file: 'deep-pdf' });
  assert.equal(client.requests.length, 0);
});

test('late navigation metadata neither overwrites a newer dashboard nor reveals stale category details', () => {
  const client = createClient({ parameters: { folder: 'category-1' } });
  client.next('getFolderContents').success(folderPage());
  const oldMenu = client.next('getDashboardData');
  client.element('sidebarHome').click();
  client.next('getDashboardData').success(dashboard());
  const stale = dashboard();
  stale.categories[0].title = 'Stale title';
  oldMenu.success(stale);
  assert.doesNotMatch(client.element('categoryNavigation').textContent, /Stale title/);
  assert.equal(client.element('categoryOverview').hidden, true);
  assert.deepEqual(client.route(), {});
});

test('unavailable categories do not become clickable in the sidebar', async () => {
  const data = dashboard();
  Object.assign(data.categories[2], { available: false, id: null, issue: 'ไม่พบโฟลเดอร์' });
  const client = await boot(data);
  const unavailable = client.element('categoryNavigation').children[2];
  assert.equal(unavailable.tagName, 'SPAN');
  assert.equal(unavailable.getAttribute('aria-disabled'), 'true');
  assert.match(unavailable.getAttribute('title'), /ไม่พบโฟลเดอร์/);
  unavailable.click();
  assert.equal(client.requests.length, 0);
});


test('dashboard reserves blank space for energy charts and opens real categories from the sidebar', async () => {
  const client = await boot();
  assert.equal(client.element('categoryNavigation').children.length, 7);
  assert.equal(client.element('energyChartArea').hidden, false);
  assert.equal(client.element('energyChartArea').children.length, 0);
  assert.equal(client.element('viewDescription').hidden, true);
  assert.equal(client.element('topicCount').textContent, '24');
  assert.equal(client.element('indicatorCount').textContent, '65');
  const request = await enterFirstCategory(client);
  assert.equal(request.args[0], 'category-1');
  request.success(folderPage());
  await client.flush();
  assert.equal(client.element('dashboardHero').hidden, true);
  assert.equal(client.element('energyChartArea').hidden, true);
  assert.equal(client.element('viewDescription').hidden, false);
  assert.equal(client.element('browserPanel').hidden, false);
  assert.equal(client.element('emptyPanel').hidden, false);
  assert.match(client.element('breadcrumbs').textContent, /หน้าแรก/);
  assert.match(client.element('breadcrumbs').textContent, /หมวด1/);
  client.element('sidebarHome').click();
  client.next('getDashboardData').success(dashboard());
  assert.equal(client.element('energyChartArea').hidden, false);
  assert.equal(client.element('viewDescription').hidden, true);
});

test('missing category is disabled and its Drive issue remains visible', async () => {
  const data = dashboard();
  Object.assign(data.categories[2], { id: null, available: false, issue: 'ไม่พบโฟลเดอร์หมวดนี้' });
  data.warnings = ['หมวด 3: ไม่พบโฟลเดอร์หมวดนี้'];
  const client = await boot(data);
  assert.equal(client.element('categoryNavigation').children.length, 7);
  assert.ok(client.find('categoryNavigation', element => element.getAttribute('aria-disabled') === 'true'));
  assert.match(client.element('warningPanel').textContent, /ไม่พบโฟลเดอร์/);
});

test('Drive names render literally, and only trusted HTTPS files can open a preview', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  const attack = '<img src=x onerror="alert(1)"> & หลักฐาน.pdf';
  request.success(folderPage([
    item({ name: attack, path: 'หมวด1 / ' + attack }),
    item({ id: 'bad-link', name: 'Untrusted.pdf', url: 'javascript:alert(1)' }),
    item({ id: 'bad-host', name: 'Lookalike.pdf', url: 'https://drive.google.com.attacker.invalid/file' })
  ]));
  await client.flush();
  assert.match(client.element('fileList').textContent, /<img src=x onerror=/);
  assert.equal(client.all('fileList').filter(element => ['IMG', 'SCRIPT'].includes(element.tagName)).length, 0);
  const links = client.all('fileList').filter(element => element.tagName === 'A');
  assert.equal(links.length, 1, 'PDF has a link to its own page');
  assert.equal(links[0].href, 'https://script.google.com/macros/s/test-deployment/exec?file=file-1');
  assert.equal(client.element('previewFallbackLink').href, 'https://drive.google.com/open?id=file-1');
  assert.equal(client.find('previewFrameWrap', el => el.tagName === 'IFRAME').src, 'https://drive.google.com/file/d/file-1/preview');
  assert.equal(client.all('fileList').filter(el => el.classes().includes('preview-select')).length, 1);
});

test('sparse recursive search exposes continuation and restarts cleanly after cursor failure', async () => {
  const client = await boot();
  const request = await startSearch(client, 'HEIC');
  request.success({ query: 'HEIC', items: [], nextPageToken: 'cursor-search', complete: false, scannedFolders: 10 });
  await client.flush();
  assert.equal(client.element('pagination').hidden, false);
  assert.match(client.element('loadMoreButton').textContent, /ค้นหา/);
  client.element('loadMoreButton').click();
  await client.flush();
  const continuation = client.next('searchDrive');
  assert.equal(continuation.args[0], 'HEIC');
  assert.equal(continuation.args[1], 'cursor-search');
  continuation.failure(new Error('รายการต่อเนื่องหมดอายุ กรุณาค้นหาใหม่'));
  await client.flush();
  assert.equal(client.element('errorPanel').hidden, false);
  client.element('retryButton').click();
  await client.flush();
  const retry = client.next('searchDrive');
  assert.equal(retry.args[0], 'HEIC');
  assert.ok(!retry.args[1], 'Retry must restart rather than reuse expired cursor');
  retry.success({ query: 'HEIC', items: [item({ typeLabel: 'HEIC', name: 'IMG_5579.HEIC' })], nextPageToken: null, complete: true, scannedFolders: 20 });
  await client.flush();
  assert.equal(client.element('errorPanel').hidden, true);
  assert.equal(client.element('pagination').hidden, true);
  assert.match(client.element('fileList').textContent, /IMG_5579.HEIC/);
});

test('a late folder response cannot overwrite a newer search view', async () => {
  const client = await boot();
  const obsolete = await enterFirstCategory(client);
  const current = await startSearch(client, 'current');
  current.success({ query: 'current', items: [item({ name: 'current.pdf' })], nextPageToken: null, complete: true, scannedFolders: 7 });
  await client.flush();
  obsolete.success(folderPage([item({ name: 'OBSOLETE.pdf' })]));
  await client.flush();
  assert.match(client.element('fileList').textContent, /current.pdf/);
  assert.doesNotMatch(client.element('fileList').textContent, /OBSOLETE/);
});

test('initial backend error is displayed as plain text and retry loads dashboard', async () => {
  const client = createClient();
  client.next('getDashboardData').failure(new Error('<script>Drive permission failed</script>'));
  await client.flush();
  assert.equal(client.element('loadingPanel').hidden, true);
  assert.equal(client.element('errorPanel').hidden, false);
  assert.match(client.element('errorMessage').textContent, /Drive permission failed/);
  client.element('retryButton').click();
  await client.flush();
  client.next('getDashboardData').success(dashboard());
  await client.flush();
  assert.equal(client.element('errorPanel').hidden, true);
  assert.equal(client.element('categoryNavigation').children.length, 7);
});

test('folder pages append once, prevent concurrent loads, and refresh starts from page one', async () => {
  const client = await boot();
  const first = await enterFirstCategory(client);
  first.success(folderPage([item()], { nextPageToken: 'page-two' }));
  await client.flush();
  client.element('loadMoreButton').click();
  client.element('loadMoreButton').click();
  const next = client.next('getFolderContents');
  assert.equal(next.args[1], 'page-two');
  assert.equal(client.requests.length, 0);
  assert.equal(client.element('workspace').getAttribute('aria-busy'), 'true');
  next.success(folderPage([item(), item({ id: 'file-2', name: 'second.pdf' })]));
  await client.flush();
  assert.equal(client.element('fileList').children.length, 2);
  assert.equal(client.element('pagination').hidden, true);
  client.element('refreshButton').click();
  const refresh = client.next('getFolderContents');
  assert.equal(refresh.args[0], 'category-1');
  assert.equal(refresh.args[1], null);
  refresh.success(folderPage([item({ id: 'fresh', name: 'fresh.pdf' })]));
  await client.flush();
  assert.equal(client.element('fileList').children.length, 1);
  assert.match(client.element('fileList').textContent, /fresh.pdf/);
  assert.equal(client.element('workspace').getAttribute('aria-busy'), 'false');
});

test('nested folders and breadcrumbs navigate inside the app and home restores dashboard', async () => {
  const client = await boot();
  const first = await enterFirstCategory(client);
  first.success(folderPage([item({ id: 'nested', kind: 'folder', name: 'โฟลเดอร์ย่อย', typeLabel: 'Folder' })]));
  await client.flush();
  client.find('fileList', el => el.tagName === 'A' && el.textContent === 'โฟลเดอร์ย่อย').click();
  const nested = client.next('getFolderContents');
  assert.equal(nested.args[0], 'nested');
  nested.success(folderPage([], {
    folder: { id: 'nested', name: 'โฟลเดอร์ย่อย', path: 'หมวด1 / โฟลเดอร์ย่อย' },
    breadcrumbs: [{ id: 'category-1', name: 'หมวด1' }, { id: 'nested', name: 'โฟลเดอร์ย่อย' }]
  }));
  await client.flush();
  client.find('breadcrumbs', el => el.tagName === 'A' && el.textContent === 'หมวด1').click();
  const parent = client.next('getFolderContents');
  assert.equal(parent.args[0], 'category-1');
  client.element('homeButton').click();
  client.next('getDashboardData').success(dashboard());
  parent.failure(new Error('obsolete error'));
  await client.flush();
  assert.equal(client.element('errorPanel').hidden, true);
  assert.equal(client.element('browserPanel').hidden, true);
  assert.equal(client.element('dashboardHero').hidden, false);
  assert.equal(client.element('categoryNavigation').children.length, 7);
});

test('search normalizes text, ignores blank submissions, and distinguishes partial from empty results', async () => {
  const client = await boot();
  client.element('searchInput').value = '   ';
  client.element('searchForm').dispatch('submit');
  assert.equal(client.requests.length, 0);
  const request = await startSearch(client, '  Cafe\u0301  ');
  assert.equal(request.args[0], 'Café');
  request.success({ items: [], nextPageToken: 'continue', complete: false, scannedFolders: 2 });
  await client.flush();
  assert.match(client.element('resultSummary').textContent, /ผลลัพธ์บางส่วน/);
  assert.doesNotMatch(client.element('emptyTitle').textContent, /ไม่พบผลการค้นหา/);
  client.element('loadMoreButton').click();
  client.next('searchDrive').success({ items: [], nextPageToken: null, complete: true, scannedFolders: 7 });
  await client.flush();
  assert.equal(client.element('emptyTitle').textContent, 'ไม่พบผลการค้นหา');
  assert.match(client.element('resultSummary').textContent, /ค้นหาเสร็จแล้ว/);
});

test('PDF previews automatically, pagination preserves it, and images have their own page', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  request.success(folderPage([
    item({ id: 'photo', name: 'กิจกรรม.HEIC', mimeType: 'image/heic', typeLabel: 'HEIC', url: 'https://drive.google.com/open?id=photo&resourcekey=key-123' }),
    item()
  ], { nextPageToken: 'more' }));
  await client.flush();
  assert.equal(client.element('previewPanel').hidden, false);
  assert.equal(client.element('previewTitle').textContent, 'หลักฐาน.pdf');
  assert.equal(client.element('previousPreviewButton').disabled, true);
  const frame = client.find('previewFrameWrap', el => el.tagName === 'IFRAME');
  client.element('loadMoreButton').click();
  client.next('getFolderContents').success(folderPage([item({ id: 'more-pdf', name: 'more.pdf' })]));
  await client.flush();
  assert.equal(client.find('previewFrameWrap', el => el.tagName === 'IFRAME'), frame, 'Appending results must not reload the active document');
  assert.match(client.element('previewPosition').textContent, /1 จาก 3/);
  client.find('fileList', el => el.tagName === 'A' && el.textContent === 'กิจกรรม.HEIC').click();
  assert.deepEqual(client.route(), { file: 'photo' });
  client.next('getFileDetails').success({
    item: item({ id: 'photo', name: 'กิจกรรม.HEIC', mimeType: 'image/heic', typeLabel: 'HEIC', url: 'https://drive.google.com/open?id=photo&resourcekey=key-123' }),
    folder: folderPage().folder, breadcrumbs: folderPage().breadcrumbs
  });
  await client.flush();
  assert.equal(client.find('previewFrameWrap', el => el.tagName === 'IFRAME').src, 'https://drive.google.com/file/d/photo/preview?resourcekey=key-123');
  assert.match(client.element('previewType').textContent, /IMAGE/);
  assert.equal(client.element('fileTableWrap').hidden, true);
  client.element('expandPreviewButton').click();
  assert.equal(client.element('expandPreviewButton').getAttribute('aria-expanded'), 'true');
  client.element('homeButton').click();
  assert.equal(client.element('previewFrameWrap').children.length, 0, 'Leaving a folder unloads its document');
  assert.equal(client.element('previewPanel').hidden, true);
  assert.equal(client.element('expandPreviewButton').getAttribute('aria-expanded'), 'false');
});

test('preview arrows browse every loaded document without leaving the folder or losing the file link', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  const files = [item(), item({ id: 'pdf-2', name: 'second.pdf' }),
    item({ id: 'image-3', name: 'third.jpg', mimeType: 'image/jpeg', typeLabel: 'JPG' })];
  request.success(folderPage(files));
  await client.flush();
  const historyLength = client.historyLength;
  for (const file of files.slice(1)) {
    client.element('nextPreviewButton').click();
    assert.equal(client.requests.length, 0, 'Preview arrows should use loaded documents without another RPC');
    assert.deepEqual(client.route(), { folder: 'category-1' });
    assert.equal(client.element('previewTitle').textContent, file.name);
    assert.match(client.element('filePageLink').href, new RegExp('\\?file=' + file.id + '$'));
    assert.equal(client.element('documentLayout').classList.contains('single-document'), false);
  }
  assert.equal(client.element('nextPreviewButton').disabled, true);
  assert.match(client.element('previewPosition').textContent, /3 จาก 3/);
  client.element('previousPreviewButton').click();
  assert.equal(client.element('previewTitle').textContent, 'second.pdf');
  assert.equal(client.element('nextPreviewButton').disabled, false);
  assert.equal(client.historyLength, historyLength);
  client.element('filePageLink').click();
  assert.equal(client.next('getFileDetails').args[0], 'pdf-2');
  assert.deepEqual(client.route(), { file: 'pdf-2' });
});

test('Word documents stay collapsed, including folders containing only Word and search results', async () => {
  const client = await boot();
  const word = item({ id: 'word', name: 'รายงาน.DOCX', mimeType: 'application/octet-stream', typeLabel: 'ไฟล์อื่น ๆ' });
  const request = await enterFirstCategory(client);
  request.success(folderPage([word], { nextPageToken: 'more' }));
  await client.flush();
  assert.equal(client.element('fileList').children.length, 0);
  assert.equal(client.element('wordSection').hidden, false);
  assert.equal(client.element('wordList').hidden, true);
  assert.equal(client.element('emptyPanel').hidden, true, 'Word-only folders are not empty');
  assert.equal(client.element('previewPanel').hidden, true);
  assert.equal(client.element('pagination').hidden, false, 'Hidden Word files must not block later PDF pages');
  client.element('wordToggle').click();
  assert.equal(client.element('wordList').hidden, false);
  assert.equal(client.element('wordToggle').getAttribute('aria-expanded'), 'true');
  client.element('loadMoreButton').click();
  client.next('getFolderContents').success(folderPage([item()]));
  await client.flush();
  assert.equal(client.element('wordList').hidden, false, 'Loading more preserves disclosure state');
  assert.equal(client.element('previewPanel').hidden, false);
  const search = await startSearch(client, 'รายงาน');
  search.success({ items: [word], nextPageToken: null, complete: true, scannedFolders: 7 });
  await client.flush();
  assert.equal(client.element('wordList').hidden, true, 'New views collapse Word again');
  assert.equal(client.element('wordList').children.length, 1);
  assert.equal(client.element('previewFrameWrap').children.length, 0);
});

const photo = (id, overrides = {}) => item({ id, name: id + '.png', mimeType: 'image/png', typeLabel: 'PNG',
  url: 'https://drive.google.com/open?id=' + id + '&resourcekey=image-key', ...overrides });

test('folders with several images display a vertical gallery with lazy previews and individual page links', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  const images = Array.from({ length: 6 }, (_, index) => photo('photo-' + index));
  images[1] = photo('photo-1', { name: '<img src=x onerror=alert(1)>.HEIC', mimeType: 'image/heic', typeLabel: 'HEIC' });
  request.success(folderPage(images));
  await client.flush();
  assert.equal(client.element('imageGallery').hidden, false);
  assert.equal(client.element('imageGalleryList').children.length, 6);
  assert.equal(client.element('previewPanel').hidden, true);
  assert.equal(client.element('previewFrameWrap').children.length, 0, 'No duplicate single-image viewer');
  assert.equal(client.element('fileTableWrap').hidden, true, 'Images do not repeat in a sidebar');
  assert.match(client.element('imageGallerySummary').textContent, /6/);
  const frames = client.all('imageGalleryList').filter(el => el.tagName === 'IFRAME');
  assert.equal(frames.length, 6);
  frames.forEach((frame, index) => {
    assert.equal(frame.getAttribute('loading'), 'lazy');
    assert.equal(frame.src, 'https://drive.google.com/file/d/photo-' + index + '/preview?resourcekey=image-key');
  });
  assert.equal(client.all('imageGalleryList').filter(el => ['IMG','SCRIPT'].includes(el.tagName)).length, 0);
  assert.match(client.element('imageGalleryList').textContent, /<img src=x onerror=alert\(1\)>/);
  client.find('imageGalleryList', el => el.tagName === 'A' && el.textContent === 'photo-2.png').click();
  assert.equal(client.next('getFileDetails').args[0], 'photo-2');
  assert.deepEqual(client.route(), { file: 'photo-2' });
  assert.equal(client.element('imageGallery').hidden, true);
  assert.equal(client.element('imageGalleryList').children.length, 0, 'Leaving the folder unloads its gallery');
});

test('gallery pagination keeps existing frames, ignores repeated images, and refresh starts anew', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  request.success(folderPage([photo('one'), photo('two')], { nextPageToken: 'more' }));
  await client.flush();
  const firstFrame = client.find('imageGalleryList', el => el.tagName === 'IFRAME');
  client.element('loadMoreButton').click();
  client.next('getFolderContents').success(folderPage([photo('one'), photo('three')]));
  await client.flush();
  assert.equal(client.element('imageGalleryList').children.length, 3);
  assert.equal(client.find('imageGalleryList', el => el.tagName === 'IFRAME'), firstFrame);
  assert.equal(client.element('pagination').hidden, true);
  client.element('refreshButton').click();
  assert.equal(client.element('imageGalleryList').children.length, 0);
  client.next('getFolderContents').success(folderPage([photo('updated-one'), photo('updated-two')]));
  await client.flush();
  assert.equal(client.element('imageGalleryList').children.length, 2);
  assert.notEqual(client.find('imageGalleryList', el => el.tagName === 'IFRAME'), firstFrame);
});

test('a second image switches to gallery, while mixed folders retain PDF, subfolders and collapsed Word', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  request.success(folderPage([photo('one')], { nextPageToken: 'more' }));
  await client.flush();
  assert.equal(client.element('previewPanel').hidden, false);
  assert.equal(client.element('imageGallery').hidden, true);
  client.element('loadMoreButton').click();
  client.next('getFolderContents').success(folderPage([photo('two')], { nextPageToken: 'more-again' }));
  await client.flush();
  assert.equal(client.element('previewPanel').hidden, true);
  assert.equal(client.element('previewFrameWrap').children.length, 0);
  assert.equal(client.element('imageGalleryList').children.length, 2);
  client.element('loadMoreButton').click();
  client.next('getFolderContents').success(folderPage([item(),
    item({ id: 'word', name: 'report.docx', typeLabel: 'Word' }),
    item({ id: 'nested', name: 'Subfolder', kind: 'folder', typeLabel: 'Folder' })]));
  await client.flush();
  assert.equal(client.element('fileList').children.length, 2);
  assert.equal(client.element('previewPanel').hidden, false);
  assert.equal(client.element('previewTitle').textContent, 'หลักฐาน.pdf');
  assert.match(client.element('previewPosition').textContent, /1 จาก 1/);
  assert.equal(client.element('imageGalleryList').children.length, 2);
  assert.equal(client.element('wordSection').hidden, false);
  assert.equal(client.element('wordList').hidden, true);
  const search = await startSearch(client, 'photo');
  assert.equal(client.element('imageGalleryList').children.length, 0);
  search.success({ items: [photo('search-one'), photo('search-two')], nextPageToken: null, complete: true, scannedFolders: 7 });
  await client.flush();
  assert.equal(client.element('imageGallery').hidden, true, 'Search keeps a compact list');
  assert.equal(client.element('fileList').children.length, 2);
});

test('preview URL rejects untrusted origins, credentials, invalid IDs, and executable schemes', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  const urls = ['http://drive.google.com/open?id=a', 'https://drive.google.com.attacker.invalid/open?id=a',
    'https://drive.google.com@attacker.invalid/a', 'https://user:pass@drive.google.com/a',
    'https://drive.google.com:8443/a', 'javascript:alert(1)', 'data:text/html,boom'];
  request.success(folderPage(urls.map((url, index) => item({ id: 'bad-' + index, url })).concat([
    item({ id: '../outside', name: 'invalid.pdf' })
  ])));
  await client.flush();
  assert.equal(client.element('previewPanel').hidden, true);
  assert.equal(client.element('previewFrameWrap').children.length, 0);
  assert.equal(client.all('fileList').filter(el => el.classes().includes('preview-select')).length, 0);
});

test('non-preview documents retain safe external links with tab isolation', async () => {
  const client = await boot();
  const request = await enterFirstCategory(client);
  request.success(folderPage([item({ name: 'สรุป.xlsx', typeLabel: 'Excel', mimeType: 'application/vnd.ms-excel' })]));
  await client.flush();
  const link = client.find('fileList', el => el.tagName === 'A');
  assert.equal(link.href, 'https://drive.google.com/open?id=file-1');
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/);
  assert.match(link.rel, /noreferrer/);
  assert.equal(client.element('previewPanel').hidden, true);
});

test('shared folder, file, and search URLs start at the requested page while loading sidebar metadata separately', async () => {
  const folder = createClient({ parameters: { folder: 'category-4' } });
  assert.equal(folder.next('getFolderContents').args[0], 'category-4');
  folder.next('getDashboardData').success(dashboard());
  assert.equal(folder.requests.length, 0);
  const file = createClient({ parameters: { file: 'deep-pdf' } });
  const request = file.next('getFileDetails');
  assert.equal(request.args[0], 'deep-pdf');
  request.success(filePage(item({ id: 'deep-pdf', name: 'Deep.pdf' })));
  await file.flush();
  assert.equal(file.element('previewTitle').textContent, 'Deep.pdf');
  assert.match(file.element('parentLink').href, /\?folder=category-1$/);
  assert.equal(file.element('filePageLink').hidden, true);
  file.next('getDashboardData').success(dashboard());
  assert.equal(file.requests.length, 0);
  const search = createClient({ parameters: { q: '  Cafe\u0301  ' } });
  assert.equal(search.next('searchDrive').args[0], 'Café');
  assert.equal(search.element('searchInput').value, 'Café');
  assert.deepEqual(search.route(), { q: 'Café' });
});

test('browser back and forward restore pages without adding history and ignore obsolete requests', async () => {
  const client = await boot();
  const folder = await enterFirstCategory(client);
  assert.deepEqual(client.route(), { folder: 'category-1' });
  folder.success(folderPage([item()]));
  await client.flush();
  client.element('filePageLink').click();
  const obsoleteFile = client.next('getFileDetails');
  assert.deepEqual(client.route(), { file: 'file-1' });
  assert.equal(client.historyLength, 3);
  client.back();
  assert.deepEqual(client.route(), { folder: 'category-1' });
  client.next('getFolderContents').success(folderPage([item({ name: 'current.pdf' })]));
  obsoleteFile.success(filePage(item({ name: 'obsolete.pdf' })));
  await client.flush();
  assert.equal(client.element('viewTitle').textContent, 'หมวด1');
  assert.equal(client.element('previewTitle').textContent, 'current.pdf');
  client.forward();
  client.next('getFileDetails').success(filePage());
  await client.flush();
  assert.equal(client.element('viewTitle').textContent, 'หลักฐาน.pdf');
  client.element('refreshButton').click();
  assert.equal(client.next('getFileDetails').args[0], 'file-1');
  assert.equal(client.historyLength, 3);
});

test('page anchors have real shareable URLs and modified clicks use native browser navigation', async () => {
  const client = await boot();
  const link = client.find('categoryNavigation', el => el.tagName === 'A');
  assert.equal(link.href, 'https://script.google.com/macros/s/test-deployment/exec?folder=category-1');
  assert.equal(link.target, '_top');
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
    assert.equal(link.dispatch('click', modifiers).defaultPrevented, false);
  }
  assert.equal(client.requests.length, 0);
  assert.equal(client.historyLength, 1);
  assert.equal(link.dispatch('click', { button: 0 }).defaultPrevented, true);
  assert.equal(client.next('getFolderContents').args[0], 'category-1');
});

test('share button copies the page URL and provides a selectable fallback when clipboard is blocked', async () => {
  for (const clipboardError of [false, true]) {
    const client = createClient({ parameters: { file: 'shared-pdf' }, clipboardError });
    client.next('getFileDetails').success(filePage(item({ id: 'shared-pdf' })));
    await client.flush();
    client.element('copyPageButton').click();
    await client.flush();
    const expected = 'https://script.google.com/macros/s/test-deployment/exec?file=shared-pdf';
    assert.equal(client.element('sharePanel').hidden, false);
    assert.equal(client.element('shareUrl').value, expected);
    assert.equal(client.element('shareUrl').selected, true);
    if (clipboardError) assert.match(client.element('shareStatus').textContent, /Ctrl\+C/);
    else assert.deepEqual(client.clipboardWrites, [expected]);
  }
});

test('invalid links show a recoverable error and do not request Drive data', async () => {
  for (const parameters of [{ file: '../private' }, { folder: ['one', 'two'] }, { q: 'x'.repeat(121) }, { file: 'a', folder: 'b' }]) {
    const client = createClient({ parameters });
    assert.equal(client.requests.length, 0);
    assert.equal(client.element('errorPanel').hidden, false);
    client.element('dashboardLink').click();
    client.next('getDashboardData').success(dashboard());
    await client.flush();
    assert.equal(client.element('errorPanel').hidden, true);
  }
  const retry = createClient({ parameters: { file: '../private' } });
  retry.element('retryButton').click();
  retry.next('getDashboardData').success(dashboard());
  await retry.flush();
  assert.deepEqual(retry.route(), {}, 'Retrying an invalid URL must also repair the address for refresh and sharing');
  assert.equal(retry.historyLength, 1);
});

test('file failures retry the same link and stale initial URL callbacks do not override navigation', async () => {
  const client = createClient({ parameters: { file: 'missing-pdf' } });
  client.next('getFileDetails').failure(new Error('ไม่พบเอกสาร'));
  await client.flush();
  client.element('retryButton').click();
  assert.equal(client.next('getFileDetails').args[0], 'missing-pdf');
  assert.equal(client.historyLength, 1);
  const delayed = createClient({ parameters: { file: 'old-file' }, deferLocation: true });
  delayed.element('dashboardLink').click();
  delayed.next('getDashboardData').success(dashboard());
  delayed.finishLocation();
  await delayed.flush();
  assert.equal(delayed.requests.length, 0);
  assert.equal(delayed.element('categoryNavigation').children.length, 7);
});
