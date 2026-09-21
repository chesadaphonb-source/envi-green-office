/** Public API: discover the actual immediate category folders on every request. */
function getDashboardData() {
  return withDriveErrors_(function() {
    const categories = discoverCategories_();
    return {
      app: { name: CONFIG.APP_NAME, year: CONFIG.YEAR, institution: CONFIG.INSTITUTION },
      criteria: getCriteria_(),
      categories: categories,
      warnings: categories.filter(function(category) { return !category.available; })
        .map(function(category) { return category.name + ': ' + category.issue; })
    };
  });
}

/** Public API: resolve a shared file URL without scanning folder pages. */
function getFileDetails(fileId) {
  return withDriveErrors_(function() {
    if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(fileId)) {
      userError_('รหัสเอกสารไม่ถูกต้อง');
    }
    const deadline = Date.now() + CONFIG.REQUEST_BUDGET_MS;
    const categories = discoverCategories_();
    const file = DriveApp.getFileById(fileId);
    if (file.isTrashed()) userError_('เอกสารนี้ถูกนำออกแล้ว');
    const parents = file.getParents();
    if (!parents.hasNext()) userError_('ไม่พบเอกสารในหมวดที่เปิดใช้งาน');
    const parentId = parents.next().getId();
    const context = resolveFolder_(parentId, categories, deadline);
    if (!isCurrentChild_(file, parentId)) userError_('เอกสารถูกย้าย กรุณาเปิดลิงก์ใหม่');
    return {
      item: toDriveItem_(file, 'file', context),
      folder: { id: parentId, name: context.folder.getName(), path: context.path, categoryNumber: context.categoryNumber },
      breadcrumbs: context.breadcrumbs
    };
  });
}

/** Public API: read one folder at any depth; folders precede files. */
function getFolderContents(folderId, pageToken) {
  return withDriveErrors_(function() {
    const deadline = Date.now() + CONFIG.REQUEST_BUDGET_MS;
    const categories = discoverCategories_();
    const context = resolveFolder_(folderId, categories, deadline);
    const state = pageToken ? readCursor_(pageToken, 'browse') : {
      folderId: folderId, stage: 'folders', iteratorToken: null
    };
    if (state.folderId !== folderId) userError_('หน้ารายการไม่ตรงกับโฟลเดอร์ กรุณาเปิดโฟลเดอร์ใหม่');

    let iterator = getIterator_(context.folder, state.stage, state.iteratorToken);
    const items = [];
    let inspected = 0;
    while (state.stage && items.length < CONFIG.PAGE_SIZE &&
        inspected < CONFIG.SCAN_BATCH_SIZE && Date.now() < deadline) {
      if (!iterator.hasNext()) {
        state.stage = state.stage === 'folders' ? 'files' : null;
        state.iteratorToken = null;
        if (state.stage) iterator = getIterator_(context.folder, state.stage, null);
        continue;
      }
      const entry = iterator.next();
      inspected++;
      // A resumed iterator can refer to an entry moved since the previous page.
      if (!isCurrentChild_(entry, folderId)) continue;
      items.push(toDriveItem_(entry, state.stage === 'folders' ? 'folder' : 'file', context));
    }

    // Avoid offering an empty last page when the page limit hits the final item.
    if (state.stage && !iterator.hasNext()) {
      state.stage = state.stage === 'folders' ? 'files' : null;
      if (state.stage) {
        iterator = getIterator_(context.folder, state.stage, null);
        if (!iterator.hasNext()) state.stage = null;
      }
    }
    state.iteratorToken = state.stage ? iterator.getContinuationToken() : null;
    return {
      folder: {
        id: folderId, name: context.folder.getName(), path: context.path,
        categoryNumber: context.categoryNumber
      },
      breadcrumbs: context.breadcrumbs,
      items: sortDriveItems_(items),
      nextPageToken: state.stage ? writeCursor_('browse', state) : null
    };
  });
}

/**
 * Public API: case-insensitive substring search of names in all category trees.
 * An explicit DFS stack supports arbitrary depth without JS recursion limits.
 * A page can have no matches while complete=false: continue with its token.
 */
function searchDrive(query, pageToken) {
  return withDriveErrors_(function() {
    if (typeof query !== 'string') userError_('กรุณาระบุคำค้นหา');
    query = query.trim().normalize('NFC');
    if (query.length > 120) userError_('คำค้นหาต้องมีความยาวไม่เกิน 120 ตัวอักษร');
    if (!query) return { query: '', items: [], nextPageToken: null, complete: true, scannedFolders: 0 };

    const deadline = Date.now() + CONFIG.REQUEST_BUDGET_MS;
    const categories = discoverCategories_();
    const signature = categorySignature_(categories);
    const state = pageToken ? readCursor_(pageToken, 'search') : {
      query: query,
      categorySignature: signature,
      scannedFolders: 0,
      stack: categories.filter(function(category) { return category.available; })
        .reverse().map(function(category) {
          return { id: category.id, stage: 'start', iteratorToken: null, includeSelf: true };
        })
    };
    if (state.query !== query) userError_('คำค้นหาเปลี่ยนไป กรุณาเริ่มค้นหาใหม่');
    if (state.categorySignature !== signature) userError_('หมวดใน Google Drive เปลี่ยนแปลง กรุณาค้นหาใหม่');

    const needle = query.toLowerCase();
    const items = [];
    const contexts = Object.create(null);
    const iterators = Object.create(null);
    let inspected = 0;
    while (state.stack.length && items.length < CONFIG.SEARCH_PAGE_SIZE &&
        inspected < CONFIG.SCAN_BATCH_SIZE && Date.now() < deadline) {
      const frame = state.stack[state.stack.length - 1];
      // Revalidate ancestry on every request, including all resumed DFS frames.
      let context = contexts[frame.id];
      if (!context) {
        try {
          context = resolveFolder_(frame.id, categories, deadline);
        } catch (error) {
          // A slow Drive call may cross the deadline during ancestry checks.
          // Preserve this unprocessed frame and the matches already collected.
          if (error.code === 'REQUEST_BUDGET_EXCEEDED') break;
          throw error;
        }
        contexts[frame.id] = context;
      }
      if (frame.stage === 'start') {
        state.scannedFolders++;
        inspected++;
        frame.stage = 'folders';
        if (frame.includeSelf && nameMatches_(context.folder.getName(), needle)) {
          items.push(toCategoryItem_(context));
        }
        continue;
      }

      const iteratorKey = frame.id + ':' + frame.stage;
      const iterator = iterators[iteratorKey] || getIterator_(context.folder, frame.stage, frame.iteratorToken);
      iterators[iteratorKey] = iterator;
      if (!iterator.hasNext()) {
        frame.iteratorToken = null;
        if (frame.stage === 'folders') frame.stage = 'files';
        else state.stack.pop();
        continue;
      }

      const entry = iterator.next();
      inspected++;
      frame.iteratorToken = iterator.getContinuationToken();
      if (!isCurrentChild_(entry, frame.id)) continue;
      const kind = frame.stage === 'folders' ? 'folder' : 'file';
      if (nameMatches_(entry.getName(), needle)) items.push(toDriveItem_(entry, kind, context));
      if (kind === 'folder') {
        // Drive folders have a single parent; never follow shortcut targets.
        if (state.stack.some(function(ancestor) { return ancestor.id === entry.getId(); })) {
          userError_('พบโครงสร้างโฟลเดอร์วนซ้ำ กรุณาตรวจสอบ Google Drive');
        }
        state.stack.push({ id: entry.getId(), stage: 'start', iteratorToken: null, includeSelf: false });
      }
    }

    const complete = state.stack.length === 0;
    return {
      query: query,
      items: sortDriveItems_(items),
      nextPageToken: complete ? null : writeCursor_('search', state),
      complete: complete,
      scannedFolders: state.scannedFolders
    };
  });
}

function discoverCategories_() {
  const root = DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID);
  if (root.isTrashed()) userError_('โฟลเดอร์หลักอยู่ในถังขยะ กรุณาตรวจสอบ Google Drive');
  const folders = root.getFolders();
  const matches = Object.create(null);
  while (folders.hasNext()) {
    const folder = folders.next();
    if (folder.isTrashed()) continue;
    const match = folder.getName().trim().match(/^หมวด\s*([1-7])$/);
    if (!match) continue;
    const number = Number(match[1]);
    if (!matches[number]) matches[number] = [];
    matches[number].push(folder.getId());
  }
  return getCategoryDefinitions_().map(function(definition) {
    const ids = matches[definition.number] || [];
    return {
      number: definition.number,
      name: definition.name,
      title: definition.title,
      id: ids.length === 1 ? ids[0] : null,
      available: ids.length === 1,
      issue: ids.length === 0 ? 'ไม่พบโฟลเดอร์หมวดนี้ในโฟลเดอร์หลัก' :
        ids.length > 1 ? 'พบโฟลเดอร์ชื่อหมวดซ้ำ กรุณาจัดให้เหลือหนึ่งโฟลเดอร์' : null
    };
  });
}

/** Reject root, arbitrary Drive IDs, trashed ancestors, and moved category trees. */
function resolveFolder_(folderId, categories, deadline) {
  if (typeof folderId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(folderId)) {
    userError_('รหัสโฟลเดอร์ไม่ถูกต้อง');
  }
  const allowed = Object.create(null);
  categories.forEach(function(category) {
    if (category.available) allowed[category.id] = category.number;
  });
  let current = DriveApp.getFolderById(folderId);
  const folder = current;
  const reversed = [];
  const seen = Object.create(null);
  while (current) {
    if (Date.now() >= deadline) {
      userError_('การตรวจสอบโฟลเดอร์ใช้เวลานาน กรุณาลองอีกครั้ง', 'REQUEST_BUDGET_EXCEEDED');
    }
    const id = current.getId();
    if (seen[id] || current.isTrashed() || id === CONFIG.ROOT_FOLDER_ID) break;
    seen[id] = true;
    reversed.push({ id: id, name: current.getName().trim() });
    if (allowed[id]) {
      // Categories were discovered directly under ROOT_FOLDER_ID in this call.
      if (!hasParent_(current, CONFIG.ROOT_FOLDER_ID)) break;
      const breadcrumbs = reversed.reverse();
      return {
        folder: folder, breadcrumbs: breadcrumbs,
        path: breadcrumbs.map(function(crumb) { return crumb.name; }).join(' / '),
        categoryNumber: allowed[id]
      };
    }
    const parents = current.getParents();
    current = parents.hasNext() ? parents.next() : null;
  }
  userError_('ไม่พบโฟลเดอร์ในหมวดที่เปิดใช้งาน หรือโฟลเดอร์ถูกย้าย กรุณากลับหน้าแรก');
}

function hasParent_(entry, parentId) {
  const parents = entry.getParents();
  while (parents.hasNext()) {
    if (parents.next().getId() === parentId) return true;
  }
  return false;
}

function isCurrentChild_(entry, parentId) {
  return !entry.isTrashed() && hasParent_(entry, parentId);
}

function getIterator_(folder, stage, token) {
  try {
    if (stage === 'folders') return token ? DriveApp.continueFolderIterator(token) : folder.getFolders();
    if (stage === 'files') return token ? DriveApp.continueFileIterator(token) : folder.getFiles();
  } catch (error) {
    if (token) userError_('รายการต่อเนื่องหมดอายุหรือข้อมูลเปลี่ยนแปลง กรุณาโหลดรายการหรือค้นหาใหม่');
    throw error;
  }
  userError_('สถานะรายการไม่ถูกต้อง กรุณาโหลดรายการใหม่');
}

function toDriveItem_(entry, kind, context) {
  const name = entry.getName();
  const mimeType = kind === 'folder' ? 'application/vnd.google-apps.folder' : entry.getMimeType();
  return {
    id: entry.getId(), name: name, kind: kind, mimeType: mimeType,
    typeLabel: typeLabel_(mimeType, name),
    updatedAt: entry.getLastUpdated().toISOString(),
    url: driveUrl_(entry, kind),
    path: context.path + ' / ' + name,
    parentId: context.folder.getId()
  };
}

function toCategoryItem_(context) {
  const item = toDriveItem_(context.folder, 'folder', context);
  item.path = context.path;
  item.parentId = CONFIG.ROOT_FOLDER_ID;
  return item;
}

function driveUrl_(entry, kind) {
  const id = encodeURIComponent(entry.getId());
  let url = kind === 'folder' ? 'https://drive.google.com/drive/folders/' + id :
    'https://drive.google.com/open?id=' + id;
  const resourceKey = entry.getResourceKey();
  if (resourceKey) url += (kind === 'folder' ? '?' : '&') + 'resourcekey=' + encodeURIComponent(resourceKey);
  return url;
}

function typeLabel_(mimeType, name) {
  const labels = {
    'application/vnd.google-apps.folder': 'Folder',
    'application/pdf': 'PDF',
    'application/vnd.google-apps.document': 'Google Docs',
    'application/vnd.google-apps.spreadsheet': 'Google Sheets',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/vnd.google-apps.shortcut': 'ทางลัด',
    'application/msword': 'Word',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.ms-word.document.macroEnabled.12': 'Word',
    'application/vnd.ms-excel': 'Excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.ms-excel.sheet.macroEnabled.12': 'Excel',
    'image/jpeg': 'JPG',
    'image/png': 'PNG',
    'image/heic': 'HEIC',
    'image/heif': 'HEIC'
  };
  if (Object.prototype.hasOwnProperty.call(labels, mimeType)) return labels[mimeType];
  const extension = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  const extensions = {
    pdf: 'PDF', doc: 'Word', docx: 'Word', docm: 'Word',
    xls: 'Excel', xlsx: 'Excel', xlsm: 'Excel', jpg: 'JPG', jpeg: 'JPG',
    png: 'PNG', heic: 'HEIC', heif: 'HEIC'
  };
  return extension && Object.prototype.hasOwnProperty.call(extensions, extension[1]) ?
    extensions[extension[1]] : 'ไฟล์อื่น ๆ';
}

function nameMatches_(name, needle) {
  return name.normalize('NFC').toLowerCase().indexOf(needle) !== -1;
}

function sortDriveItems_(items) {
  // Drive iterator order is not guaranteed: sorting applies within each page.
  return items.sort(function(a, b) {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'th', { numeric: true });
  });
}

function categorySignature_(categories) {
  return categories.filter(function(category) { return category.available; })
    .map(function(category) { return category.number + ':' + category.id; }).join('|');
}

/** Cache only opaque traversal state. The browser never supplies Drive iterator tokens. */
function writeCursor_(kind, state) {
  const token = Utilities.getUuid();
  const prefix = 'go-v1:' + CONFIG.ROOT_FOLDER_ID + ':' + token;
  const payload = JSON.stringify({ version: 1, rootId: CONFIG.ROOT_FOLDER_ID, kind: kind, state: state });
  const values = {};
  let count = 0;
  // A cache value is limited to 100 KB; 20k UTF-16 code units safely fit UTF-8.
  for (let offset = 0; offset < payload.length; offset += 20000) {
    values[prefix + ':' + count] = payload.slice(offset, offset + 20000);
    count++;
  }
  values[prefix] = String(count);
  CacheService.getScriptCache().putAll(values, CONFIG.CURSOR_TTL_SECONDS);
  return token;
}

function readCursor_(token, kind) {
  if (typeof token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) {
    userError_('รหัสหน้ารายการไม่ถูกต้อง กรุณาโหลดรายการหรือค้นหาใหม่');
  }
  const cache = CacheService.getScriptCache();
  const prefix = 'go-v1:' + CONFIG.ROOT_FOLDER_ID + ':' + token;
  const count = Number(cache.get(prefix));
  if (!Number.isInteger(count) || count < 1 || count > 1000) expiredCursor_();
  let text = '';
  for (let index = 0; index < count; index++) {
    const chunk = cache.get(prefix + ':' + index);
    if (chunk === null) expiredCursor_();
    text += chunk;
  }
  let payload;
  try { payload = JSON.parse(text); } catch (error) { expiredCursor_(); }
  if (payload.version !== 1 || payload.rootId !== CONFIG.ROOT_FOLDER_ID || payload.kind !== kind) expiredCursor_();
  return payload.state;
}

function expiredCursor_() {
  userError_('รายการต่อเนื่องหมดอายุ กรุณาโหลดโฟลเดอร์หรือเริ่มค้นหาใหม่');
}

function userError_(message, code) {
  const error = new Error(message);
  error.isUserError = true;
  if (code) error.code = code;
  throw error;
}

function withDriveErrors_(action) {
  try {
    return action();
  } catch (error) {
    if (error.isUserError) throw error;
    console.error(error.stack || String(error));
    throw new Error('ไม่สามารถอ่าน Google Drive ได้ กรุณาตรวจสอบสิทธิ์เข้าถึงโฟลเดอร์ของบัญชีที่รันแอป แล้วลองอีกครั้ง');
  }
}
