(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GreenOfficeCatalog = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';

  const ID = /^[A-Za-z0-9_-]{1,200}$/;
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const PAGE_SIZE = 80;
  const MAX_ITEMS = 50000;
  function error(message, code) { return Object.assign(new Error(message), { code: code || 'INVALID_CATALOG' }); }
  function check(condition, message) { if (!condition) throw error(message || 'สารบัญเอกสารไม่สมบูรณ์ กรุณาลองโหลดใหม่'); }
  function text(value, max, empty) {
    check(typeof value === 'string' && value.length <= max && (empty || value.trim().length));
    return value;
  }
  function timestamp(value) {
    check(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)));
    return value;
  }
  function identifier(value) { check(typeof value === 'string' && ID.test(value)); return value; }
  function driveUrl(value, item) {
    const url = new URL(text(value, 1500));
    check(url.origin === 'https://drive.google.com' && !url.username && !url.password && !url.hash);
    if (item.kind === 'folder') check(url.pathname === '/drive/folders/' + item.id && !url.searchParams.has('id'));
    else check(url.pathname === '/open' && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === item.id);
    check([...url.searchParams.keys()].every(key => key === 'id' || key === 'resourcekey'));
    check(url.searchParams.getAll('resourcekey').length <= 1);
    if (url.searchParams.has('resourcekey')) identifier(url.searchParams.get('resourcekey'));
    return url.href;
  }

  // Used by the browser and by the publishing pipeline. Only these fields reach Pages.
  function validateCatalog(raw) {
    if (raw && (raw.error === 'CATALOG_NOT_CONFIGURED' || raw.error && raw.error.code === 'CATALOG_NOT_CONFIGURED')) {
      throw error('กำลังเตรียมสารบัญเอกสารสำหรับเว็บใหม่ กรุณาใช้เว็บเดิมระหว่างการย้ายระบบ', 'CATALOG_NOT_CONFIGURED');
    }
    check(raw && typeof raw === 'object' && raw.schemaVersion === 1 && !raw.error && raw.ok !== false);
    check(raw.app && raw.criteria && Array.isArray(raw.categories) && raw.categories.length === 7);
    check(Array.isArray(raw.items) && raw.items.length <= MAX_ITEMS);
    check(Array.isArray(raw.warnings) && raw.warnings.length <= 100);
    const app = { name: text(raw.app.name, 300), year: text(raw.app.year, 10), institution: text(raw.app.institution, 500) };
    const criteria = {};
    for (const key of ['categoryCount', 'topicCount', 'indicatorCount']) {
      check(Number.isInteger(raw.criteria[key]) && raw.criteria[key] > 0 && raw.criteria[key] < 10000);
      criteria[key] = raw.criteria[key];
    }
    check(criteria.categoryCount === 7);
    const numbers = new Set();
    const roots = new Map();
    const categories = raw.categories.map(category => {
      check(category && Number.isInteger(category.number) && category.number >= 1 && category.number <= 7 && !numbers.has(category.number));
      numbers.add(category.number);
      check(typeof category.available === 'boolean');
      const result = { number: category.number, name: text(category.name, 300), title: text(category.title, 500),
        id: category.available ? identifier(category.id) : null, available: category.available,
        issue: category.issue == null ? null : text(category.issue, 1000, true) };
      if (result.available) { check(!roots.has(result.id)); roots.set(result.id, result.number); }
      else check(category.id === null);
      return result;
    }).sort((a, b) => a.number - b.number);
    const byId = new Map();
    const items = raw.items.map(source => {
      check(source && (source.kind === 'folder' || source.kind === 'file'));
      const item = { id: identifier(source.id), name: text(source.name, 1000), kind: source.kind,
        mimeType: text(source.mimeType, 200), typeLabel: text(source.typeLabel, 100), updatedAt: timestamp(source.updatedAt),
        parentId: source.parentId === null ? null : identifier(source.parentId), categoryNumber: source.categoryNumber };
      check(!byId.has(item.id) && Number.isInteger(item.categoryNumber) && item.categoryNumber >= 1 && item.categoryNumber <= 7);
      check((item.kind === 'folder') === (item.mimeType === FOLDER_MIME));
      check(item.mimeType !== 'application/vnd.google-apps.shortcut', 'สารบัญมีทางลัดที่ยังไม่ได้รองรับ');
      item.url = driveUrl(source.url, item);
      byId.set(item.id, item);
      return item;
    });
    for (const [id, categoryNumber] of roots) {
      const item = byId.get(id);
      check(item && item.kind === 'folder' && item.parentId === null && item.categoryNumber === categoryNumber);
    }
    // Resolve each ancestry once; reject orphaned, cyclic, and cross-category entries.
    const resolved = new Set();
    for (const item of items) {
      let current = item;
      const pending = [];
      const visited = new Set();
      while (!resolved.has(current.id)) {
        check(!visited.has(current.id) && pending.length < 200);
        visited.add(current.id);
        pending.push(current);
        if (current.parentId === null) {
          check(roots.get(current.id) === current.categoryNumber && current.kind === 'folder');
          break;
        }
        const parent = byId.get(current.parentId);
        check(parent && parent.kind === 'folder' && parent.categoryNumber === current.categoryNumber);
        current = parent;
      }
      for (let index = pending.length - 1; index >= 0; index--) {
        const entry = pending[index];
        entry.path = entry.parentId === null ? entry.name : byId.get(entry.parentId).path + ' / ' + entry.name;
        check(entry.path.length <= 50000);
        resolved.add(entry.id);
      }
    }
    return { schemaVersion: 1, generatedAt: timestamp(raw.generatedAt), app, criteria, categories,
      warnings: raw.warnings.map(warning => text(warning, 1000, true)), items };
  }

  function createIndex(raw) {
    const catalog = validateCatalog(raw);
    const byId = new Map(catalog.items.map(item => [item.id, item]));
    const children = new Map();
    const compare = (a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'th', { numeric: true }) || a.id.localeCompare(b.id) : a.kind === 'folder' ? -1 : 1;
    const sorted = catalog.items.slice().sort(compare);
    for (const item of sorted) {
      if (!children.has(item.parentId)) children.set(item.parentId, []);
      children.get(item.parentId).push(item);
    }
    function find(id, kind) {
      const item = byId.get(id);
      if (!item || item.kind !== kind) throw error('ไม่พบรายการนี้ในสารบัญล่าสุด กรุณากลับหน้าแรกหรือค้นหาใหม่', 'NOT_FOUND');
      return item;
    }
    function folderContext(folder) {
      const breadcrumbs = [];
      let ancestor = folder;
      while (ancestor) { breadcrumbs.push({ id: ancestor.id, name: ancestor.name }); ancestor = byId.get(ancestor.parentId); }
      return { folder: { id: folder.id, name: folder.name, path: folder.path, categoryNumber: folder.categoryNumber }, breadcrumbs: breadcrumbs.reverse() };
    }
    function page(items, token, scope) {
      let offset = 0;
      if (token != null) {
        let cursor;
        try { cursor = JSON.parse(token); } catch (_) { throw error('หน้ารายการไม่ถูกต้อง กรุณาโหลดใหม่', 'INVALID_CURSOR'); }
        if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[0] !== catalog.generatedAt || cursor[1] !== scope ||
            !Number.isInteger(cursor[2]) || cursor[2] < 1 || cursor[2] >= items.length) {
          throw error('สารบัญเปลี่ยนแปลงหรือหน้ารายการไม่ตรงกัน กรุณาโหลดใหม่', 'INVALID_CURSOR');
        }
        offset = cursor[2];
      }
      const next = offset + PAGE_SIZE;
      return { items: items.slice(offset, next), totalItems: items.length, nextPageToken: next < items.length ? JSON.stringify([catalog.generatedAt, scope, next]) : null };
    }
    function request(method, args) {
      args = args || [];
      let result;
      switch (method) {
        case 'getDashboardData':
          result = { app: catalog.app, criteria: catalog.criteria, categories: catalog.categories, warnings: catalog.warnings };
          break;
        case 'getFolderContents': {
          const folder = find(args[0], 'folder');
          result = Object.assign(folderContext(folder), page(children.get(folder.id) || [], args[1], 'folder:' + folder.id));
          break;
        }
        case 'getFileDetails': {
          const item = find(args[0], 'file');
          result = Object.assign({ item }, folderContext(find(item.parentId, 'folder')));
          break;
        }
        case 'searchDrive': {
          const query = text(args[0], 120, true).trim().normalize('NFC');
          const needle = query.toLocaleLowerCase('th');
          const matches = query ? sorted.filter(item => item.name.normalize('NFC').toLocaleLowerCase('th').includes(needle)) : [];
          result = Object.assign({ query, scannedFolders: children.size }, page(matches, args[1], 'search:' + query));
          result.complete = !result.nextPageToken;
          break;
        }
        default: throw error('ไม่รองรับการเรียกข้อมูลนี้', 'UNKNOWN_METHOD');
      }
      // Callers can annotate render data without corrupting the shared index.
      return JSON.parse(JSON.stringify(Object.assign(result, { generatedAt: catalog.generatedAt })));
    }
    return { request, generatedAt: catalog.generatedAt };
  }

  function createClient(options) {
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    let index = null;
    let pending = null;
    function load(force) {
      if (pending) return pending;
      if (index && !force) return Promise.resolve(index);
      pending = (async function () {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
          const response = await fetcher(options.url, { credentials: 'omit', cache: 'no-cache', signal: controller.signal, headers: { Accept: 'application/json' } });
          if (response.status === 404) throw error('กำลังเตรียมสารบัญเอกสารสำหรับเว็บใหม่ กรุณาใช้เว็บเดิมระหว่างการย้ายระบบ', 'CATALOG_NOT_CONFIGURED');
          if (!response.ok) throw error('โหลดสารบัญไม่สำเร็จ กรุณาลองอีกครั้ง', 'CATALOG_UNAVAILABLE');
          const next = createIndex(await response.json());
          if (index && Date.parse(next.generatedAt) < Date.parse(index.generatedAt)) throw error('ได้รับสารบัญรุ่นเก่า กรุณาลองโหลดใหม่', 'STALE_CATALOG');
          index = next;
          return index;
        } catch (cause) {
          if (cause && cause.code) throw cause;
          throw error('เชื่อมต่อสารบัญไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตแล้วลองอีกครั้ง', 'CATALOG_UNAVAILABLE');
        } finally { clearTimeout(timeout); }
      })();
      pending = pending.finally(() => { pending = null; });
      return pending;
    }
    return {
      request: (method, args) => load(false).then(current => current.request(method, args)),
      refresh: () => load(true).then(current => ({ generatedAt: current.generatedAt }))
    };
  }
  return { validateCatalog, createIndex, createClient };
});
