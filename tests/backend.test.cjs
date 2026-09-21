'use strict';

// Run with: node --test tests/backend.test.cjs
// This checks server behavior against a mutable Drive tree. It does not contact
// Google or prove that the deployed Apps Script account has Drive permission.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const PROJECT = path.resolve(__dirname, '..');
const ROOT_ID = '1DnHxbbw2B4Ow6_Odf8mCmzbsAJYuwYRx';
const UPDATED = '2026-09-11T08:15:00.000Z';

function createEnvironment(configOverrides = {}) {
  const nodes = new Map();
  const continuations = new Map();
  const cache = new Map();
  const logs = [];
  const folderLookupDelays = new Map();
  let now = Date.parse(UPDATED);
  let sequence = 0;

  function iterator(values, kind, offset = 0) {
    const snapshot = Array.from(values);
    let position = offset;
    return {
      hasNext: () => position < snapshot.length,
      next() {
        if (position >= snapshot.length) throw new Error('Iterator exhausted');
        return snapshot[position++];
      },
      getContinuationToken() {
        const token = 'iterator-' + (++sequence);
        continuations.set(token, { values: snapshot, kind, offset: position });
        return token;
      }
    };
  }

  function resume(token, kind) {
    const saved = continuations.get(token);
    if (!saved || saved.kind !== kind) throw new Error('Invalid iterator token');
    return iterator(saved.values, kind, saved.offset);
  }

  function children(parent, kind) {
    return Array.from(nodes.values()).filter(node =>
      node.parentId === parent.id && node.kind === kind && !node.trashed
    );
  }

  function add(kind, id, name, parentId, mimeType) {
    const node = {
      id, name, parentId, kind, mimeType,
      updated: UPDATED,
      trashed: false,
      getId() { return this.id; },
      getName() { return this.name; },
      getUrl() {
        return this.kind === 'folder'
          ? 'https://drive.google.com/drive/folders/' + this.id
          : 'https://drive.google.com/file/d/' + this.id + '/view';
      },
      getLastUpdated() { return new Date(this.updated); },
      getDateCreated() { return new Date(this.updated); },
      isTrashed() { return this.trashed; },
      getParents() {
        return iterator(this.parentId ? [nodes.get(this.parentId)] : [], 'folder');
      },
      getFolders() { return iterator(children(this, 'folder'), 'folder'); },
      getFiles() { return iterator(children(this, 'file'), 'file'); },
      getFoldersByName(value) {
        return iterator(children(this, 'folder').filter(item => item.name === value), 'folder');
      },
      getMimeType() { return this.mimeType; },
      getSize() { return 123; },
      getResourceKey() { return ''; }
    };
    nodes.set(id, node);
    return node;
  }

  const folder = (id, name, parentId = ROOT_ID) =>
    add('folder', id, name, parentId, 'application/vnd.google-apps.folder');
  const file = (id, name, parentId, mimeType = 'application/pdf') =>
    add('file', id, name, parentId, mimeType);
  folder(ROOT_ID, 'Green Office ENVI 2569', null);
  for (let number = 1; number <= 7; number++) {
    folder('category-' + number, 'หมวด' + number);
  }
  folder('outside-root', 'Private unrelated folder', null);

  function getNode(id, kind) {
    const found = nodes.get(id);
    if (!found || found.kind !== kind || found.trashed) {
      throw new Error('Cannot access Drive ' + kind + ': ' + id);
    }
    return found;
  }

  const mockCache = {
    get(key) {
      const saved = cache.get(key);
      if (!saved || saved.expires <= now) return null;
      return saved.value;
    },
    put(key, value, expiration = 600) {
      assert.equal(typeof value, 'string', 'Apps Script cache values must be strings');
      assert.ok(Buffer.byteLength(value, 'utf8') <= 100 * 1024, 'Apps Script cache entry exceeds 100 KB');
      cache.set(key, { value, expires: now + expiration * 1000 });
    },
    remove(key) { cache.delete(key); },
    getAll(keys) {
      return Object.fromEntries(keys.map(key => [key, this.get(key)]).filter(entry => entry[1] !== null));
    },
    putAll(values, expiration) {
      for (const [key, value] of Object.entries(values)) this.put(key, value, expiration);
    },
    removeAll(keys) { keys.forEach(key => this.remove(key)); }
  };

  class MockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }

  const output = {
    title: null,
    frameMode: null,
    setTitle(title) { this.title = title; return this; },
    setXFrameOptionsMode(mode) { this.frameMode = mode; return this; },
    addMetaTag() { return this; }
  };
  const templates = [];
  const context = vm.createContext({
    console: { error(...args) { logs.push(args.map(String).join(' ')); } },
    Date: MockDate,
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/test-deployment/exec' }) },
    DriveApp: {
      getFolderById(id) {
        const delay = folderLookupDelays.get(id) || 0;
        folderLookupDelays.delete(id);
        now += delay;
        return getNode(id, 'folder');
      },
      getFileById: id => getNode(id, 'file'),
      continueFolderIterator: token => resume(token, 'folder'),
      continueFileIterator: token => resume(token, 'file')
    },
    CacheService: { getScriptCache: () => mockCache, getUserCache: () => mockCache },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      newBlob(value) { return { getBytes: () => Array.from(Buffer.from(value, 'utf8')) }; },
      base64EncodeWebSafe: value => Buffer.from(value).toString('base64url'),
      base64DecodeWebSafe: value => Array.from(Buffer.from(value, 'base64url')),
      Charset: { UTF_8: 'UTF-8' }
    },
    HtmlService: {
      XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
      createTemplateFromFile(filename) {
        const template = { filename, evaluate: () => output };
        templates.push(template);
        return template;
      },
      createHtmlOutputFromFile(filename) {
        return { getContent: () => fs.readFileSync(path.join(PROJECT, filename + '.html'), 'utf8') };
      }
    }
  });
  for (const filename of ['Config.gs', 'CriteriaService.gs', 'DriveService.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(PROJECT, filename), 'utf8'), context, { filename });
  }
  context.testConfigOverrides = configOverrides;
  vm.runInContext('Object.assign(CONFIG, testConfigOverrides); delete testConfigOverrides;', context);

  return {
    context, nodes, folder, file, templates, output, logs,
    advanceTime(milliseconds) { now += milliseconds; },
    delayNextFolderRead(id, milliseconds) { folderLookupDelays.set(id, milliseconds); },
    expireCache() { cache.clear(); },
    call(name, ...args) {
      assert.equal(typeof context[name], 'function', 'Missing server API: ' + name);
      return JSON.parse(JSON.stringify(context[name](...args)));
    },
    config() { return JSON.parse(vm.runInContext('JSON.stringify(CONFIG)', context)); }
  };
}

function collectPages(env, method, argument, initialToken) {
  const items = [];
  const pages = [];
  let token = initialToken;
  do {
    const page = env.call(method, argument, token);
    assert.ok(Array.isArray(page.items));
    pages.push(page);
    items.push(...page.items);
    token = page.nextPageToken;
    assert.ok(pages.length <= 1000, 'Pagination did not terminate');
  } while (token);
  return { items, pages };
}

function assertIds(items, expectedIds) {
  const actualIds = items.map(item => item.id);
  assert.equal(new Set(actualIds).size, actualIds.length, 'An item appeared on more than one page');
  assert.deepEqual(actualIds.slice().sort(), expectedIds.slice().sort());
}

test('Web App entry point renders the configured dashboard template', () => {
  const env = createEnvironment();
  const config = env.config();
  assert.equal(config.ROOT_FOLDER_ID, ROOT_ID);
  assert.equal(String(config.YEAR), '2569');
  env.context.doGet();
  assert.equal(env.templates.length, 1);
  assert.equal(env.templates[0].filename, 'index');
  assert.equal(env.output.title, config.APP_NAME);
  assert.equal(env.templates[0].appUrl, 'https://script.google.com/macros/s/test-deployment/exec');
});

test('entry point passes route data to contextual HTML attributes and restricts includes', () => {
  const env = createEnvironment();
  const query = '\"><script>alert(1)</script>';
  env.context.doGet({ parameter: { q: query } });
  assert.equal(JSON.parse(env.templates[0].initialRoute).q, query);
  const html = fs.readFileSync(path.join(PROJECT, 'index.html'), 'utf8');
  assert.match(html, /data-initial-route="<\?= initialRoute \?>"/);
  assert.throws(() => env.context.include('../Config'));
  assert.match(env.context.include('branding'), /class="institution-logo"/);
  assert.match(env.context.include('hero-image'), /class="campus-art"/);
});

test('Workspace deployment URLs produce canonical share links without the organization prefix', () => {
  const env = createEnvironment();
  for (const mode of ['exec', 'dev']) {
    env.context.ScriptApp.getService = () => ({ getUrl: () => 'https://script.google.com/a/ku.th/macros/s/example-id/' + mode });
    env.context.doGet();
    assert.equal(env.templates.at(-1).appUrl, 'https://script.google.com/macros/s/example-id/' + mode);
  }
});

test('a direct document link resolves nested files beyond the first folder page', () => {
  const env = createEnvironment({ PAGE_SIZE: 1 });
  env.folder('nested-documents', 'นโยบาย', 'category-1');
  env.file('first-pdf', 'first.pdf', 'nested-documents');
  const target = env.file('target-pdf', 'นโยบาย.pdf', 'nested-documents');
  target.getResourceKey = () => 'document-key';
  assertIds(env.call('getFolderContents', 'nested-documents').items, ['first-pdf']);
  const page = env.call('getFileDetails', 'target-pdf');
  assert.equal(page.item.id, 'target-pdf');
  assert.equal(page.folder.id, 'nested-documents');
  assert.equal(page.folder.categoryNumber, 1);
  assert.deepEqual(page.breadcrumbs.map(crumb => crumb.id), ['category-1', 'nested-documents']);
  assert.match(page.item.url, /resourcekey=document-key/);
  assert.equal(page.item.updatedAt, UPDATED);
});

test('direct document links reject unrelated, moved, trashed, and invalid file IDs', () => {
  const env = createEnvironment();
  env.file('private-file', 'secret.pdf', 'outside-root');
  env.file('root-file', 'root.pdf', ROOT_ID);
  env.folder('unlisted', 'Other');
  env.file('unlisted-file', 'other.pdf', 'unlisted');
  const moving = env.folder('moving', 'Files', 'category-1');
  env.file('moved-file', 'moved.pdf', moving.id);
  env.call('getFileDetails', 'moved-file');
  moving.parentId = 'outside-root';
  const trashed = env.file('trashed-file', 'deleted.pdf', 'category-2');
  trashed.trashed = true;
  for (const id of ['private-file', 'root-file', 'unlisted-file', 'moved-file', 'trashed-file', 'missing', '../private-file', {}, '']) {
    assert.throws(() => env.call('getFileDetails', id));
  }
});

test('dashboard discovers all seven live categories and reports the supplied criteria totals', () => {
  const env = createEnvironment();
  // Whitespace variations in real Drive folder names are accepted.
  env.nodes.get('category-2').name = ' หมวด 2 ';
  env.folder('ignored-eight', 'หมวด8');
  env.folder('ignored-suffix', 'หมวด1 สำรอง');
  const dashboard = env.call('getDashboardData');
  assert.equal(dashboard.app.name, 'Green Office คณะสิ่งแวดล้อม');
  assert.equal(String(dashboard.app.year), '2569');
  assert.deepEqual(dashboard.criteria, { categoryCount: 7, topicCount: 24, indicatorCount: 65 });
  assert.deepEqual(dashboard.categories.map(item => item.number), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(dashboard.categories.map(item => item.id), [1, 2, 3, 4, 5, 6, 7].map(number => 'category-' + number));
  assert.ok(dashboard.categories.every(item => item.available && item.title && !item.issue));
  assert.equal(dashboard.categories[6].title, 'การดำเนินงานสำนักงานสีเขียวเพื่อความต่อเนื่อง');
  assert.deepEqual(dashboard.warnings, []);
});

test('missing and duplicate categories stay visible but cannot be opened until Drive is corrected', () => {
  const env = createEnvironment();
  env.nodes.get('category-2').parentId = 'outside-root';
  const duplicate = env.folder('duplicate-category-3', 'หมวด 3');
  const dashboard = env.call('getDashboardData');
  assert.equal(dashboard.categories.length, 7);
  for (const number of [2, 3]) {
    const category = dashboard.categories.find(item => item.number === number);
    assert.equal(category.available, false);
    assert.equal(category.id, null);
    assert.ok(category.issue);
    assert.throws(() => env.call('getFolderContents', 'category-' + number));
  }
  assert.equal(dashboard.warnings.length, 2);
  assert.throws(() => env.call('getFolderContents', duplicate.id));
  env.nodes.get('category-2').parentId = ROOT_ID;
  duplicate.parentId = 'outside-root';
  assert.ok(env.call('getDashboardData').categories.every(item => item.available));
});

test('file metadata supports all requested formats and transports Thai and markup names as data', () => {
  const env = createEnvironment();
  const parent = env.folder('evidence-folder', 'คำสั่งคณะทำงาน <b>&</b>', 'category-1');
  const cases = [
    ['pdf', 'application/pdf', 'PDF'],
    ['gdoc', 'application/vnd.google-apps.document', 'Google Docs'],
    ['gsheet', 'application/vnd.google-apps.spreadsheet', 'Google Sheets'],
    ['doc', 'application/msword', 'Word'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word'],
    ['xls', 'application/vnd.ms-excel', 'Excel'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'],
    ['jpg', 'image/jpeg', 'JPG'],
    ['png', 'image/png', 'PNG'],
    ['heic', 'image/heic', 'HEIC'],
    ['HEIC', 'application/octet-stream', 'HEIC']
  ];
  for (const [extension, mime] of cases) env.file('format-' + extension, 'หลักฐาน.' + extension, parent.id, mime);
  const attackName = '<img src=x onerror="alert(1)"> & </script> เอกสารไทย.pdf';
  const markupFile = env.file('markup-name', attackName, parent.id);
  markupFile.getUrl = () => 'javascript:alert(1)';
  markupFile.getResourceKey = () => 'resource&key=<test>';
  env.folder('child-folder', 'ภาพกิจกรรม', parent.id);
  const response = env.call('getFolderContents', parent.id);
  for (const [extension, mime, label] of cases) {
    const item = response.items.find(value => value.id === 'format-' + extension);
    assert.equal(item.kind, 'file');
    assert.equal(item.mimeType, mime);
    assert.equal(item.typeLabel, label);
    assert.equal(item.updatedAt, UPDATED);
    assert.equal(item.parentId, parent.id);
    assert.ok(item.path.includes(parent.name));
    assert.ok(item.path.endsWith(item.name));
  }
  const folderItem = response.items.find(item => item.id === 'child-folder');
  assert.equal(folderItem.kind, 'folder');
  assert.equal(folderItem.typeLabel, 'Folder');
  const markupItem = response.items.find(item => item.id === markupFile.id);
  assert.equal(markupItem.name, attackName);
  assert.ok(markupItem.path.endsWith(attackName));
  const target = new URL(markupItem.url);
  assert.equal(target.protocol, 'https:');
  assert.equal(target.hostname, 'drive.google.com');
  assert.equal(target.searchParams.get('id'), markupFile.id);
  assert.equal(target.searchParams.get('resourcekey'), markupFile.getResourceKey());
  assert.equal(response.breadcrumbs.at(-1).name, parent.name);
});

test('unknown types with JavaScript property names return serializable fallback labels', () => {
  const env = createEnvironment();
  const names = ['evidence.constructor', 'evidence.toString', 'evidence.__proto__'];
  const weirdMimeTypes = ['constructor', 'toString', '__proto__'];
  names.forEach((name, index) => env.file('unknown-extension-' + index, name, 'category-1', 'application/octet-stream'));
  weirdMimeTypes.forEach((mime, index) => env.file('unknown-mime-' + index, 'evidence.bin', 'category-1', mime));
  // Assert before JSON transport, since JSON.stringify silently omits functions.
  const rawResponse = env.context.getFolderContents('category-1');
  assert.equal(rawResponse.items.length, names.length + weirdMimeTypes.length);
  for (const item of rawResponse.items) {
    assert.equal(typeof item.typeLabel, 'string');
    assert.equal(item.typeLabel, 'ไฟล์อื่น ๆ');
  }
  const transported = JSON.parse(JSON.stringify(rawResponse));
  assert.ok(transported.items.every(item => item.typeLabel === 'ไฟล์อื่น ๆ'));
});

test('folder browsing visits arbitrarily nested folders and rereads newly added files', () => {
  const env = createEnvironment();
  let parentId = 'category-1';
  const ancestorIds = [parentId];
  for (let depth = 1; depth <= 30; depth++) {
    const id = 'depth-' + depth;
    env.folder(id, 'โฟลเดอร์ชั้น ' + depth, parentId);
    const contents = env.call('getFolderContents', parentId);
    assert.ok(contents.items.some(item => item.id === id));
    parentId = id;
    ancestorIds.push(id);
  }
  assertIds(env.call('getFolderContents', parentId).items, []);
  env.file('added-after-first-read', 'หลักฐานที่เพิ่มภายหลัง.pdf', parentId);
  const fresh = env.call('getFolderContents', parentId);
  assertIds(fresh.items, ['added-after-first-read']);
  assert.ok(Array.isArray(fresh.breadcrumbs));
  assert.deepEqual(fresh.breadcrumbs.filter(item => item.id !== ROOT_ID).map(item => item.id), ancestorIds);
});

test('folder pagination returns every child once across folder and file boundaries', () => {
  const env = createEnvironment({ PAGE_SIZE: 3 });
  const expected = [];
  for (let number = 0; number < 8; number++) {
    expected.push('folder-' + number, 'file-' + number);
    env.folder('folder-' + number, 'หมวดย่อย ' + number, 'category-1');
    env.file('file-' + number, 'หลักฐาน ' + number + '.pdf', 'category-1');
  }
  const result = collectPages(env, 'getFolderContents', 'category-1');
  assert.ok(result.pages.length > 1);
  assert.ok(result.pages.every(page => page.items.length <= 3));
  assertIds(result.items, expected);
});

test('root and unrelated folders cannot be browsed', () => {
  const env = createEnvironment();
  env.folder('unrelated-inside-root', 'บันทึกส่วนตัว');
  env.folder('child-outside', 'ข้อมูลส่วนตัว', 'outside-root');
  for (const id of [ROOT_ID, 'outside-root', 'child-outside', 'unrelated-inside-root', 'missing-id']) {
    assert.throws(() => env.call('getFolderContents', id), undefined, id + ' must be rejected');
  }
});

test('folder cursors reject forgery, cross-folder reuse, and expiry', () => {
  const env = createEnvironment({ PAGE_SIZE: 1 });
  env.file('first', 'one.pdf', 'category-1');
  env.file('second', 'two.pdf', 'category-1');
  const first = env.call('getFolderContents', 'category-1');
  assert.ok(first.nextPageToken);
  assert.throws(() => env.call('getFolderContents', 'category-1', 'forged-token'));
  assert.throws(() => env.call('getFolderContents', 'category-2', first.nextPageToken));
  env.advanceTime((env.config().CURSOR_TTL_SECONDS + 1) * 1000);
  assert.throws(() => env.call('getFolderContents', 'category-1', first.nextPageToken));
});

test('a browse cursor cannot disclose children of a folder moved outside the root', () => {
  const env = createEnvironment({ PAGE_SIZE: 1 });
  const moving = env.folder('moving-folder', 'เอกสารเดิม', 'category-1');
  env.file('public-first', 'one.pdf', moving.id);
  env.file('now-private', 'two.pdf', moving.id);
  const first = env.call('getFolderContents', moving.id);
  assert.ok(first.nextPageToken);
  moving.parentId = 'outside-root';
  assert.throws(() => env.call('getFolderContents', moving.id, first.nextPageToken));
});

test('recursive search spans categories and pages and matches folder and file names', () => {
  const env = createEnvironment({ SEARCH_PAGE_SIZE: 3, SCAN_BATCH_SIZE: 4 });
  const expected = [];
  for (let category = 1; category <= 7; category++) {
    let parent = 'category-' + category;
    for (let depth = 1; depth <= 4; depth++) {
      const folderId = 'search-folder-' + category + '-' + depth;
      env.folder(folderId, depth === 4 ? 'นโยบาย Policy folder' : 'เอกสาร ' + depth, parent);
      if (depth === 4) expected.push(folderId);
      const fileId = 'search-file-' + category + '-' + depth;
      env.file(fileId, 'นโยบาย policy ' + depth + '.pdf', folderId);
      expected.push(fileId);
      parent = folderId;
    }
  }
  env.file('private-match', 'policy secret.pdf', 'outside-root');
  env.folder('unrelated-inside-root', 'Other');
  env.file('unrelated-match', 'policy secret.pdf', 'unrelated-inside-root');
  const result = collectPages(env, 'searchDrive', '  PoLiCy  ');
  assert.ok(result.pages.length > 1);
  assert.ok(result.pages.every(page => page.items.length <= 3));
  assert.equal(result.pages.at(-1).complete, true);
  assertIds(result.items, expected);
});

test('sparse search continues scanning after pages with no matches', () => {
  const env = createEnvironment({ SEARCH_PAGE_SIZE: 2, SCAN_BATCH_SIZE: 2 });
  let parentId = 'category-7';
  for (let depth = 1; depth <= 15; depth++) {
    const id = 'sparse-' + depth;
    env.folder(id, 'ordinary folder ' + depth, parentId);
    env.file('ordinary-' + depth, 'ordinary file.pdf', id);
    parentId = id;
  }
  env.file('deep-match', 'เอกสารเป้าหมาย.pdf', parentId);
  const result = collectPages(env, 'searchDrive', 'เป้าหมาย');
  assert.ok(result.pages.some(page => page.items.length === 0 && page.nextPageToken));
  assertIds(result.items, ['deep-match']);
  assert.equal(result.pages.at(-1).complete, true);
});

test('search preserves partial results and resumes after a slow Drive lookup exhausts the request budget', () => {
  const env = createEnvironment({ REQUEST_BUDGET_MS: 100 });
  env.folder('slow-target-folder', 'target folder', 'category-1');
  env.file('nested-target-file', 'target nested.pdf', 'slow-target-folder');
  env.file('later-target-file', 'target later.pdf', 'category-2');
  // The folder name is already a match before search opens that folder to read
  // its contents. Model one slow Drive call, then let subsequent calls recover.
  env.delayNextFolderRead('slow-target-folder', 200);
  const first = env.call('searchDrive', 'target');
  assertIds(first.items, ['slow-target-folder']);
  assert.equal(first.complete, false);
  assert.ok(first.nextPageToken);
  const rest = collectPages(env, 'searchDrive', 'target', first.nextPageToken);
  assertIds(first.items.concat(rest.items), ['slow-target-folder', 'nested-target-file', 'later-target-file']);
  assert.equal(rest.pages.at(-1).complete, true);
});

test('search cursors reject forgery, changed queries, API misuse, and expiry', () => {
  const env = createEnvironment({ SEARCH_PAGE_SIZE: 1 });
  env.file('first-result', 'หลักฐาน one.pdf', 'category-1');
  env.file('second-result', 'หลักฐาน two.pdf', 'category-1');
  const first = env.call('searchDrive', 'หลักฐาน');
  assert.ok(first.nextPageToken);
  assert.throws(() => env.call('searchDrive', 'หลักฐาน', 'forged-token'));
  assert.throws(() => env.call('searchDrive', 'different query', first.nextPageToken));
  assert.throws(() => env.call('getFolderContents', 'category-1', first.nextPageToken));
  env.expireCache();
  assert.throws(() => env.call('searchDrive', 'หลักฐาน', first.nextPageToken));
});

test('new searches discover files added after a completed search', () => {
  const env = createEnvironment();
  env.folder('new-evidence-folder', 'หลักฐาน', 'category-4');
  assertIds(collectPages(env, 'searchDrive', 'รายงานใหม่').items, []);
  env.file('newly-created', 'รายงานใหม่.pdf', 'new-evidence-folder');
  assertIds(collectPages(env, 'searchDrive', 'รายงานใหม่').items, ['newly-created']);
});

test('continued browsing omits a file moved to an unrelated folder', () => {
  const env = createEnvironment({ PAGE_SIZE: 1 });
  env.file('still-visible', 'a.pdf', 'category-1');
  const moved = env.file('moved-file', 'b.pdf', 'category-1');
  const first = env.call('getFolderContents', 'category-1');
  assertIds(first.items, ['still-visible']);
  assert.ok(first.nextPageToken);
  moved.parentId = 'outside-root';
  const rest = env.call('getFolderContents', 'category-1', first.nextPageToken);
  assert.ok(rest.items.every(item => item.id !== moved.id));
});

test('continued search fails safely when its current ancestor moved outside the root', () => {
  const env = createEnvironment({ SEARCH_PAGE_SIZE: 1, SCAN_BATCH_SIZE: 100 });
  const moving = env.folder('search-moving-folder', 'records', 'category-1');
  env.file('search-public-first', 'target first.pdf', moving.id);
  env.file('search-now-private', 'target second.pdf', moving.id);
  const first = env.call('searchDrive', 'target');
  assertIds(first.items, ['search-public-first']);
  assert.ok(first.nextPageToken);
  moving.parentId = 'outside-root';
  assert.throws(() => env.call('searchDrive', 'target', first.nextPageToken), error =>
    error.isUserError === true && /โฟลเดอร์/.test(error.message)
  );
});

test('search normalizes Unicode, accepts Thai, and handles empty and overlong input', () => {
  const env = createEnvironment();
  env.file('thai-match', 'ประกาศนโยบายสีเขียว.pdf', 'category-1');
  env.file('unicode-match', 'Cafe\u0301 policy.pdf', 'category-2');
  assertIds(collectPages(env, 'searchDrive', 'นโยบายสีเขียว').items, ['thai-match']);
  assertIds(collectPages(env, 'searchDrive', 'CAFÉ').items, ['unicode-match']);
  const empty = env.call('searchDrive', '  ');
  assertIds(empty.items, []);
  assert.equal(empty.complete, true);
  assert.equal(empty.nextPageToken, null);
  assert.throws(() => env.call('searchDrive', 'a'.repeat(121)));
  assert.throws(() => env.call('searchDrive', { query: 'not a string' }));
});

test('search requires a fresh traversal when discovered category folders change', () => {
  const env = createEnvironment({ SEARCH_PAGE_SIZE: 1 });
  env.file('one-policy', 'policy one.pdf', 'category-1');
  env.file('two-policy', 'policy two.pdf', 'category-1');
  const first = env.call('searchDrive', 'policy');
  assert.ok(first.nextPageToken);
  env.nodes.get('category-7').name = 'archived category';
  assert.throws(() => env.call('searchDrive', 'policy', first.nextPageToken), error =>
    error.isUserError === true && /ค้นหาใหม่/.test(error.message)
  );
});
