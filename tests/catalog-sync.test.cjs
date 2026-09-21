const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { validateCatalog } = require('../site/catalog.js');

function harness() {
  const props = new Map([['CATALOG_SHEET_ID', 'private-sheet']]);
  const sheets = new Map();
  const entries = new Map();
  const cursors = new Map();
  const triggers = [];
  let nextToken = 0;
  let locked = false;
  let failSheet = null;
  let driveReads = 0;
  const rootId = '1DnHxbbw2B4Ow6_Odf8mCmzbsAJYuwYRx';
  function iterator(values, offset = 0) {
    let position = offset;
    return {
      hasNext: () => position < values.length,
      next: () => values[position++],
      getContinuationToken() {
        const token = 'cursor-' + ++nextToken;
        cursors.set(token, { values, position });
        return token;
      }
    };
  }
  function resume(token) {
    const value = cursors.get(token);
    if (!value) throw new Error('expired iterator');
    return iterator(value.values, value.position);
  }
  function entry(id, name, parentId, kind = 'folder', mimeType = 'application/pdf') {
    const data = { id, name, parentId, kind, mimeType, trashed: false, key: '', date: '2026-09-21T00:00:00.000Z' };
    Object.assign(data, {
      getId: () => data.id,
      getName: () => data.name,
      isTrashed: () => data.trashed,
      getLastUpdated: () => new Date(data.date),
      getResourceKey: () => data.key,
      getMimeType: () => data.mimeType,
      getParents: () => iterator(data.parentId ? [entries.get(data.parentId)] : []),
      getFolders: () => iterator([...entries.values()].filter(child => child.parentId === id && child.kind === 'folder' && !child.trashed)),
      getFiles: () => iterator([...entries.values()].filter(child => child.parentId === id && child.kind === 'file' && !child.trashed))
    });
    entries.set(id, data);
    return data;
  }
  function sheet(name) {
    const rows = [];
    let maxRows = 1000;
    const result = {
      rows, getMaxRows: () => maxRows,
      insertRowsAfter: (_, count) => { maxRows += count; },
      getRange(start, column, count) {
        return {
          setNumberFormat() { return this; },
          setValues(values) {
            if (failSheet === name) throw new Error('injected sheet write failure');
            values.forEach((row, index) => { rows[start - 1 + index] = row.slice(); });
            return this;
          },
          getValues: () => Array.from({ length: count }, (_, index) => rows[start - 1 + index] || [''])
        };
      }
    };
    sheets.set(name, result);
    return result;
  }
  const book = { getSheetByName: name => sheets.get(name), insertSheet: sheet };
  const scriptProperties = {
    getProperty: key => props.has(key) ? props.get(key) : null,
    setProperty: (key, value) => { props.set(key, value); return scriptProperties; },
    deleteProperty: key => props.delete(key)
  };
  const context = vm.createContext({
    console, Date,
    PropertiesService: { getScriptProperties: () => scriptProperties },
    LockService: { getScriptLock: () => ({ tryLock: () => locked ? false : (locked = true), releaseLock: () => { locked = false; } }) },
    SpreadsheetApp: { openById: id => { assert.equal(id, 'private-sheet'); return book; }, flush() {} },
    ScriptApp: {
      getProjectTriggers: () => triggers,
      newTrigger(name) {
        return { timeBased() { return this; }, everyMinutes(number) { assert.equal(number, 15); return this; },
          create() { triggers.push({ getHandlerFunction: () => name }); } };
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (algorithm, text) => crypto.createHash(algorithm).update(text).digest(),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url')
    },
    DriveApp: {
      getFolderById(id) { driveReads++; const result = entries.get(id); if (!result || result.kind !== 'folder') throw new Error('not found'); return result; },
      getFileById(id) { driveReads++; const result = entries.get(id); if (!result || result.kind !== 'file') throw new Error('not found'); return result; },
      continueFolderIterator: resume, continueFileIterator: resume
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput(text) {
      return { text, setMimeType() { return this; } };
    } }
  });
  for (const filename of ['Config.gs', 'Indexer.gs', 'Export.gs']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'catalog-sync', filename), 'utf8'), context, { filename });
  }
  entry(rootId, 'private Drive root', null);
  entry('outside', 'private outside', null);
  entry('cat1', 'หมวด 1', rootId);
  entry('pdf1', 'เอกสาร 1.pdf', 'cat1', 'file');
  entry('pdf2', 'เอกสาร 2.pdf', 'cat1', 'file');
  context.setupCatalogSync();
  const run = expression => vm.runInContext(expression, context);
  const exportCatalog = token => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ token }) } }).text);
  const enable = () => { props.set('CATALOG_EXPORT_TOKEN', 't'.repeat(40)); props.set('CATALOG_PUBLISH_ENABLED', 'true'); };
  function finish() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = context.syncCatalog();
      if (result.status === 'complete') return result;
    }
    throw new Error('job failed to finish');
  }
  return { context, props, sheets, entries, entry, rootId, run, exportCatalog, enable, finish, triggers,
    failWrites: name => { failSheet = name; }, setLocked: value => { locked = value; },
    driveReadCount: () => driveReads };
}

test('setup is idempotent and never enables publication', () => {
  const h = harness();
  h.context.setupCatalogSync();
  assert.equal(h.triggers.length, 1);
  assert.equal(h.sheets.size, 4);
  assert.equal(h.props.has('CATALOG_PUBLISH_ENABLED'), false);
  assert.deepEqual(h.exportCatalog('anything'), { ok: false, error: 'export_disabled' });
});

test('complete exported snapshot validates against the frontend schema without exposing Drive root', () => {
  const h = harness();
  h.entry('nested', 'รูปและ PDF', 'cat1');
  h.entry('picture', 'ภาพ.png', 'nested', 'file', 'image/png').key = 'resource-key';
  h.entry('shortcut', 'private shortcut', 'cat1', 'file', 'application/vnd.google-apps.shortcut');
  h.enable();
  h.finish();
  const catalog = h.exportCatalog('t'.repeat(40));
  validateCatalog(catalog);
  assert.equal(catalog.items.length, 5);
  assert.equal(catalog.items.find(item => item.id === 'cat1').parentId, null);
  assert.equal(catalog.items.find(item => item.id === 'picture').url, 'https://drive.google.com/open?id=picture&resourcekey=resource-key');
  assert.equal(JSON.stringify(catalog).includes(h.rootId), false);
  assert.equal(catalog.items.some(item => item.id === 'shortcut'), false);
});

test('partial scans resume across invocations and never replace the last good snapshot', () => {
  const h = harness(); h.enable(); h.finish();
  const previous = h.exportCatalog('t'.repeat(40));
  h.entry('pdf3', 'เอกสารใหม่.pdf', 'cat1', 'file');
  h.run('CATALOG_CONFIG.BATCH_SIZE = 1; CATALOG_CONFIG.MAX_STEPS = 1');
  const partial = h.context.syncCatalog();
  assert.notEqual(partial.status, 'complete');
  assert.deepEqual(h.exportCatalog('t'.repeat(40)), previous);
  assert.ok(h.props.has('CATALOG_CHECKPOINT'));
  h.finish();
  assert.ok(h.exportCatalog('t'.repeat(40)).items.some(item => item.id === 'pdf3'));
});

test('failed snapshot writes retain active pointer; a later completed scan removes deleted items', () => {
  const h = harness(); h.enable(); h.finish();
  const previous = h.exportCatalog('t'.repeat(40));
  const pointer = h.props.get('CATALOG_ACTIVE_SNAPSHOT');
  h.entries.get('pdf2').trashed = true;
  h.failWrites('Catalog_Snapshot_B');
  assert.throws(() => h.finish(), /injected/);
  assert.equal(h.props.get('CATALOG_ACTIVE_SNAPSHOT'), pointer);
  assert.deepEqual(h.exportCatalog('t'.repeat(40)), previous);
  h.failWrites(null); h.finish();
  assert.equal(h.exportCatalog('t'.repeat(40)).items.some(item => item.id === 'pdf2'), false);
});

test('moving a queued folder outside the root aborts resume and preserves old snapshot', () => {
  const h = harness();
  h.entry('nested', 'หมวดย่อย', 'cat1');
  h.entry('nested-file', 'เอกสารย่อย.pdf', 'nested', 'file');
  h.enable(); h.finish();
  const previous = h.exportCatalog('t'.repeat(40));
  h.run('CATALOG_CONFIG.BATCH_SIZE = 1; CATALOG_CONFIG.MAX_STEPS = 1');
  h.context.syncCatalog();
  h.entries.get('nested').parentId = 'outside';
  assert.throws(() => h.finish(), /โฟลเดอร์ถูกย้าย/);
  assert.equal(h.props.has('CATALOG_CHECKPOINT'), false);
  assert.deepEqual(h.exportCatalog('t'.repeat(40)), previous);
  h.finish();
  assert.equal(h.exportCatalog('t'.repeat(40)).items.some(item => item.id === 'nested-file'), false);
});

test('duplicate immediate category names disable the category and exclude its entire tree', () => {
  const h = harness();
  h.entry('duplicate', 'หมวด1', h.rootId);
  h.entry('secret', 'not exported.pdf', 'duplicate', 'file');
  h.enable(); h.finish();
  const result = h.exportCatalog('t'.repeat(40));
  validateCatalog(result);
  assert.equal(result.categories[0].available, false);
  assert.match(result.categories[0].issue, /ซ้ำ/);
  assert.equal(result.items.length, 0);
});

test('export authenticates a POST body only and never reads Drive', () => {
  const h = harness(); h.enable(); h.finish();
  const before = h.driveReadCount();
  assert.equal(h.exportCatalog('wrong').error, 'unauthorized');
  assert.equal(JSON.parse(h.context.doPost({ parameter: { token: 't'.repeat(40) } }).text).error, 'unauthorized');
  assert.equal(JSON.parse(h.context.doPost({ postData: { contents: '{' } }).text).error, 'unauthorized');
  assert.deepEqual(JSON.parse(h.context.doGet().text), { service: 'green-office-catalog', ok: true });
  assert.equal(h.exportCatalog('t'.repeat(40)).schemaVersion, 1);
  assert.equal(h.driveReadCount(), before);
  h.props.set('CATALOG_EXPORT_TOKEN', 'short');
  assert.equal(h.exportCatalog('short').error, 'export_disabled');
});

test('corrupted durable checkpoint is discarded; next scan safely overwrites uncommitted staging tail', () => {
  const h = harness(); h.enable(); h.finish();
  const pointer = h.props.get('CATALOG_ACTIVE_SNAPSHOT');
  h.run('CATALOG_CONFIG.BATCH_SIZE = 1; CATALOG_CONFIG.MAX_STEPS = 1');
  h.context.syncCatalog();
  h.sheets.get('Catalog_Checkpoint').rows[0][0] = JSON.stringify('damaged state');
  assert.throws(() => h.context.syncCatalog(), /เขียนไม่ครบ/);
  assert.equal(h.props.get('CATALOG_ACTIVE_SNAPSHOT'), pointer);
  assert.equal(h.props.has('CATALOG_CHECKPOINT'), false);
  h.finish();
  validateCatalog(h.exportCatalog('t'.repeat(40)));
});

test('overlapping timer execution does not start another scan', () => {
  const h = harness(); h.setLocked(true);
  assert.equal(h.context.syncCatalog().status, 'busy');
  assert.equal(h.props.has('CATALOG_CHECKPOINT'), false);
});

test('formula-like names remain literal JSON text in Sheet and exported data', () => {
  const h = harness(); h.entries.get('pdf1').name = '=IMPORTXML("https://invalid.test","//x")';
  h.enable(); h.finish();
  assert.equal(h.exportCatalog('t'.repeat(40)).items.find(item => item.id === 'pdf1').name, h.entries.get('pdf1').name);
  for (const sheet of h.sheets.values()) {
    assert.ok(sheet.rows.every(row => !/^[=+@-]/.test(row[0])));
  }
});

test('unrecognized MIME and prototype-like extensions always serialize as ordinary file labels', () => {
  const h = harness();
  h.entry('unknown', 'file.constructor', 'cat1', 'file', 'application/octet-stream');
  h.entry('other', 'file.xyz', 'cat1', 'file', 'toString');
  h.enable(); h.finish();
  const catalog = validateCatalog(h.exportCatalog('t'.repeat(40)));
  assert.equal(catalog.items.find(item => item.id === 'unknown').typeLabel, 'ไฟล์อื่น ๆ');
  assert.equal(catalog.items.find(item => item.id === 'other').typeLabel, 'ไฟล์อื่น ๆ');
});

test('file moved after scan but before verification cannot replace the completed snapshot', () => {
  const h = harness(); h.enable(); h.finish();
  const previous = h.exportCatalog('t'.repeat(40));
  h.run('CATALOG_CONFIG.BATCH_SIZE = 1; CATALOG_CONFIG.MAX_STEPS = 1');
  let phase;
  for (let i = 0; i < 20 && phase !== 'verify'; i++) phase = h.context.syncCatalog().status;
  assert.equal(phase, 'verify');
  h.entries.get('pdf2').parentId = 'outside';
  assert.throws(() => h.finish(), /ถูกย้ายหรือถูกลบ/);
  assert.deepEqual(h.exportCatalog('t'.repeat(40)), previous);
  h.finish();
  assert.equal(h.exportCatalog('t'.repeat(40)).items.some(item => item.id === 'pdf2'), false);
});
