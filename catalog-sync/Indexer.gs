/** Run manually once, on a new dedicated Sheet. This never enables export. */
function setupCatalogSync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('มีงานอัปเดตกำลังทำงานอยู่');
  try {
    const book = catalogBook_();
    CATALOG_CONFIG.TABS.forEach(function(name) {
      if (!book.getSheetByName(name)) book.insertSheet(name);
    });
    if (!ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === 'syncCatalog';
    })) {
      ScriptApp.newTrigger('syncCatalog').timeBased().everyMinutes(15).create();
    }
    return { ready: true, exportEnabled: properties_().getProperty('CATALOG_PUBLISH_ENABLED') === 'true' };
  } finally { lock.releaseLock(); }
}

/** Timer/manual entry point. Scan progress survives executions and failures. */
function syncCatalog() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { status: 'busy' };
  const deadline = Date.now() + CATALOG_CONFIG.BUDGET_MS;
  let state;
  try {
    const book = catalogBook_();
    requireTabs_(book);
    const categories = discoverCategories_(deadline);
    state = readCheckpoint_(book);
    if (!state) state = startScan_(book, categories);
    if (Date.now() - Date.parse(state.startedAt) > CATALOG_CONFIG.MAX_JOB_AGE_MS ||
        JSON.stringify(state.categories) !== JSON.stringify(categories)) {
      throw new Error('หมวดหรือสถานะรายการเปลี่ยนไป ต้องเริ่มสแกนใหม่');
    }
    let steps = 0;
    while (Date.now() < deadline && steps < CATALOG_CONFIG.MAX_STEPS) {
      const result = state.phase === 'scan' ? scanBatch_(book, state, deadline) :
        verifyBatch_(book, state, deadline);
      steps += result.steps;
      saveCheckpoint_(book, state);
      if (state.phase === 'complete') {
        // Recheck category membership immediately before publishing the completed scan.
        if (JSON.stringify(discoverCategories_(deadline)) !== JSON.stringify(state.categories)) {
          throw new Error('หมวดเปลี่ยนระหว่างสแกน ต้องเริ่มใหม่');
        }
        publishSnapshot_(book, state);
        properties_().deleteProperty('CATALOG_CHECKPOINT');
        properties_().setProperty('CATALOG_LAST_STATUS', JSON.stringify({
          status: 'complete', at: new Date().toISOString(), itemCount: state.count
        }));
        return { status: 'complete', itemCount: state.count };
      }
      if (!result.steps) break;
    }
    properties_().setProperty('CATALOG_LAST_STATUS', JSON.stringify({
      status: state.phase, at: new Date().toISOString(), itemCount: state.count,
      verifiedCount: state.verified
    }));
    return { status: state.phase, itemCount: state.count, verifiedCount: state.verified };
  } catch (error) {
    // A deadline during ancestry discovery discards only the uncommitted batch.
    if (error.code === 'CATALOG_BUDGET') return { status: 'paused' };
    // Fail closed. Keep the previous completed snapshot; rebuild next invocation.
    properties_().deleteProperty('CATALOG_CHECKPOINT');
    properties_().setProperty('CATALOG_LAST_STATUS', JSON.stringify({
      status: 'failed', at: new Date().toISOString(), message: 'สแกนไม่สำเร็จ รอบถัดไปจะเริ่มใหม่'
    }));
    throw error;
  } finally { lock.releaseLock(); }
}

function properties_() { return PropertiesService.getScriptProperties(); }

function catalogBook_() {
  const id = properties_().getProperty('CATALOG_SHEET_ID');
  if (!id || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw new Error('กรุณาตั้ง CATALOG_SHEET_ID เป็นรหัส Sheet เฉพาะสำหรับสารบัญ');
  }
  return SpreadsheetApp.openById(id);
}

function requireTabs_(book) {
  CATALOG_CONFIG.TABS.forEach(function(name) {
    if (!book.getSheetByName(name)) throw new Error('กรุณารัน setupCatalogSync ก่อน');
  });
}

function discoverCategories_(deadline) {
  const root = DriveApp.getFolderById(CATALOG_CONFIG.ROOT_FOLDER_ID);
  if (root.isTrashed()) throw new Error('โฟลเดอร์หลักอยู่ในถังขยะ');
  const folders = root.getFolders();
  const matches = Object.create(null);
  while (folders.hasNext()) {
    checkDeadline_(deadline);
    const folder = folders.next();
    if (!isChild_(folder, CATALOG_CONFIG.ROOT_FOLDER_ID)) continue;
    const match = folder.getName().trim().match(/^หมวด\s*([1-7])$/);
    if (!match) continue;
    const number = Number(match[1]);
    if (!matches[number]) matches[number] = [];
    matches[number].push(folder.getId());
  }
  return categoryDefinitions_().map(function(category) {
    const ids = matches[category.number] || [];
    return Object.assign({}, category, {
      id: ids.length === 1 ? ids[0] : null,
      available: ids.length === 1,
      issue: ids.length === 0 ? 'ไม่พบโฟลเดอร์หมวดนี้ในโฟลเดอร์หลัก' :
        ids.length > 1 ? 'พบโฟลเดอร์ชื่อหมวดซ้ำ กรุณาจัดให้เหลือหนึ่งโฟลเดอร์' : null
    });
  });
}

function startScan_(book, categories) {
  const state = {
    version: 1, startedAt: new Date().toISOString(), phase: 'scan',
    categories: categories, queue: [], count: 0, verified: 0
  };
  const roots = [];
  categories.forEach(function(category) {
    if (!category.available) return;
    const folder = DriveApp.getFolderById(category.id);
    const item = makeItem_(folder, 'folder', null, folder.getName(), category.number);
    roots.push(item);
    state.queue.push({ id: item.id, path: item.path, parentId: null,
      categoryNumber: category.number, phase: 'folders', token: null });
  });
  // Overwrite from row 1; old tail rows are ignored using the committed row count.
  appendItems_(book, state, roots);
  saveCheckpoint_(book, state);
  return state;
}

function scanBatch_(book, state, deadline) {
  const rows = [];
  let steps = 0;
  while (state.queue.length && steps < CATALOG_CONFIG.BATCH_SIZE && Date.now() < deadline) {
    const frame = state.queue[0];
    const folder = validateFolder_(frame, state.categories, deadline);
    const iterator = frame.phase === 'folders' ?
      (frame.token ? DriveApp.continueFolderIterator(frame.token) : folder.getFolders()) :
      (frame.token ? DriveApp.continueFileIterator(frame.token) : folder.getFiles());
    while (iterator.hasNext() && steps < CATALOG_CONFIG.BATCH_SIZE && Date.now() < deadline) {
      const entry = iterator.next();
      steps++;
      if (!isChild_(entry, frame.id)) continue;
      const kind = frame.phase === 'folders' ? 'folder' : 'file';
      // Do not publish or follow shortcuts, including shortcuts to outside the root.
      if (kind === 'file' && entry.getMimeType() === 'application/vnd.google-apps.shortcut') continue;
      const item = makeItem_(entry, kind, frame.id, frame.path + ' / ' + entry.getName(), frame.categoryNumber);
      rows.push(item);
      if (kind === 'folder') {
        state.queue.push({ id: item.id, path: item.path, parentId: frame.id,
          categoryNumber: item.categoryNumber, phase: 'folders', token: null });
      }
    }
    if (iterator.hasNext()) frame.token = iterator.getContinuationToken();
    else if (frame.phase === 'folders') { frame.phase = 'files'; frame.token = null; }
    else { state.queue.shift(); steps++; }
  }
  appendItems_(book, state, rows);
  if (!state.queue.length) state.phase = 'verify';
  return { steps: steps };
}

function verifyBatch_(book, state, deadline) {
  const count = Math.min(CATALOG_CONFIG.BATCH_SIZE, state.count - state.verified);
  const rows = count ? readItems_(book, state.verified, count) : [];
  let steps = 0;
  for (let i = 0; i < rows.length && Date.now() < deadline; i++) {
    const item = rows[i];
    const entry = item.kind === 'folder' ? validateFolder_(item, state.categories, deadline) :
      DriveApp.getFileById(item.id);
    if (item.kind === 'file') {
      const parent = DriveApp.getFolderById(item.parentId);
      validateFolder_({ id: item.parentId, categoryNumber: item.categoryNumber,
        path: item.path.slice(0, -(item.name.length + 3)) }, state.categories, deadline);
      if (!isChild_(entry, parent.getId())) throw new Error('เอกสารถูกย้ายหรือถูกลบระหว่างสแกน');
    }
    if (entry.getName() !== item.name || entry.getLastUpdated().toISOString() !== item.updatedAt ||
        (item.kind === 'file' && entry.getMimeType() !== item.mimeType)) {
      throw new Error('เอกสารเปลี่ยนระหว่างสแกน ต้องเริ่มใหม่');
    }
    state.verified++;
    steps++;
  }
  if (state.verified === state.count) state.phase = 'complete';
  return { steps: steps };
}

/** Revalidate all ancestors each time a queued folder is resumed. */
function validateFolder_(frame, categories, deadline) {
  const category = categories.find(function(value) {
    return value.number === frame.categoryNumber && value.available;
  });
  if (!category) throw new Error('หมวดนี้ไม่เปิดใช้งาน');
  const folder = DriveApp.getFolderById(frame.id);
  let current = folder;
  const names = [];
  const seen = Object.create(null);
  while (current) {
    checkDeadline_(deadline);
    const id = current.getId();
    if (seen[id] || current.isTrashed() || id === CATALOG_CONFIG.ROOT_FOLDER_ID) break;
    seen[id] = true;
    names.unshift(current.getName());
    if (names.length > 200) throw new Error('โครงสร้างโฟลเดอร์ลึกเกินกำหนด');
    if (id === category.id) {
      if (!isChild_(current, CATALOG_CONFIG.ROOT_FOLDER_ID) || names.join(' / ') !== frame.path) break;
      if (frame.parentId && !isChild_(folder, frame.parentId)) break;
      return folder;
    }
    const parents = current.getParents();
    current = parents.hasNext() ? parents.next() : null;
  }
  throw new Error('โฟลเดอร์ถูกย้าย เปลี่ยนชื่อ หรืออยู่นอกหมวดที่อนุญาต');
}

function isChild_(entry, parentId) {
  if (entry.isTrashed()) return false;
  const parents = entry.getParents();
  while (parents.hasNext()) if (parents.next().getId() === parentId) return true;
  return false;
}

function checkDeadline_(deadline) {
  if (Date.now() < deadline) return;
  const error = new Error('ทำต่อในการเรียกครั้งถัดไป');
  error.code = 'CATALOG_BUDGET';
  throw error;
}

function makeItem_(entry, kind, parentId, path, categoryNumber) {
  const id = entry.getId();
  const name = entry.getName();
  const mimeType = kind === 'folder' ? 'application/vnd.google-apps.folder' : entry.getMimeType();
  let url = kind === 'folder' ? 'https://drive.google.com/drive/folders/' + encodeURIComponent(id) :
    'https://drive.google.com/open?id=' + encodeURIComponent(id);
  const key = entry.getResourceKey();
  if (key) url += (kind === 'folder' ? '?' : '&') + 'resourcekey=' + encodeURIComponent(key);
  return { id: id, name: name, kind: kind, mimeType: mimeType,
    typeLabel: typeLabel_(mimeType, name), updatedAt: entry.getLastUpdated().toISOString(),
    url: url, path: path, parentId: parentId, categoryNumber: categoryNumber };
}

function typeLabel_(mimeType, name) {
  const labels = {
    'application/vnd.google-apps.folder': 'Folder', 'application/pdf': 'PDF',
    'application/vnd.google-apps.document': 'Google Docs',
    'application/vnd.google-apps.spreadsheet': 'Google Sheets',
    'application/vnd.google-apps.presentation': 'Google Slides',
    'application/msword': 'Word',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.ms-word.document.macroEnabled.12': 'Word',
    'application/vnd.ms-excel': 'Excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'image/jpeg': 'JPG', 'image/png': 'PNG', 'image/webp': 'WEBP',
    'image/gif': 'GIF', 'image/heic': 'HEIC', 'image/heif': 'HEIC'
  };
  if (Object.prototype.hasOwnProperty.call(labels, mimeType)) return labels[mimeType];
  const extension = name.match(/\.([a-z0-9]+)$/i);
  const extensions = { pdf: 'PDF', doc: 'Word', docx: 'Word', docm: 'Word',
    xls: 'Excel', xlsx: 'Excel', jpg: 'JPG', jpeg: 'JPG', png: 'PNG', webp: 'WEBP' };
  const suffix = extension && extension[1].toLowerCase();
  return suffix && Object.prototype.hasOwnProperty.call(extensions, suffix) ? extensions[suffix] : 'ไฟล์อื่น ๆ';
}

function appendItems_(book, state, items) {
  if (!items.length) return;
  if (state.count + items.length > CATALOG_CONFIG.MAX_ITEMS) throw new Error('สารบัญมีรายการเกินขนาดที่รองรับ');
  const rows = items.map(function(item) {
    const value = JSON.stringify(item);
    if (value.length > CATALOG_CONFIG.CHUNK_SIZE) throw new Error('ชื่อหรือเส้นทางเอกสารยาวเกินกำหนด');
    return [value];
  });
  writeRows_(book.getSheetByName('Catalog_Staging'), state.count + 1, rows);
  state.count += rows.length;
}

function readItems_(book, offset, count) {
  if (!count) return [];
  return book.getSheetByName('Catalog_Staging').getRange(offset + 1, 1, count, 1)
    .getValues().map(function(row) { return JSON.parse(row[0]); });
}

function writeRows_(sheet, start, rows) {
  const required = start + rows.length - 1;
  if (required > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), required - sheet.getMaxRows());
  sheet.getRange(start, 1, rows.length, 1).setNumberFormat('@').setValues(rows);
}

function digest_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    text, Utilities.Charset.UTF_8));
}

function writeJson_(book, sheetName, value) {
  const text = JSON.stringify(value);
  const rows = [];
  // JSON-encode every chunk so even a chunk beginning '=' remains inert Sheet text.
  for (let i = 0; i < text.length; i += CATALOG_CONFIG.CHUNK_SIZE) {
    rows.push([JSON.stringify(text.slice(i, i + CATALOG_CONFIG.CHUNK_SIZE))]);
  }
  writeRows_(book.getSheetByName(sheetName), 1, rows);
  SpreadsheetApp.flush();
  const pointer = { sheet: sheetName, count: rows.length, hash: digest_(text) };
  readJson_(book, pointer); // Read-back must succeed before committing a pointer.
  return pointer;
}

function readJson_(book, pointer) {
  if (!pointer || !CATALOG_CONFIG.TABS.includes(pointer.sheet) ||
      !Number.isInteger(pointer.count) || pointer.count < 1) throw new Error('สถานะสารบัญไม่ถูกต้อง');
  const text = book.getSheetByName(pointer.sheet).getRange(1, 1, pointer.count, 1).getValues()
    .map(function(row) { return JSON.parse(row[0]); }).join('');
  if (digest_(text) !== pointer.hash) throw new Error('สารบัญเขียนไม่ครบ กรุณาสแกนใหม่');
  return JSON.parse(text);
}

function saveCheckpoint_(book, state) {
  const pointer = writeJson_(book, 'Catalog_Checkpoint', state);
  properties_().setProperty('CATALOG_CHECKPOINT', JSON.stringify(pointer));
}

function readCheckpoint_(book) {
  const raw = properties_().getProperty('CATALOG_CHECKPOINT');
  if (!raw) return null;
  return readJson_(book, JSON.parse(raw));
}

function publishSnapshot_(book, state) {
  const items = readItems_(book, 0, state.count);
  const ids = Object.create(null);
  items.forEach(function(item) {
    if (ids[item.id] || item.id === CATALOG_CONFIG.ROOT_FOLDER_ID) throw new Error('พบรายการซ้ำหรือรหัสโฟลเดอร์หลัก');
    ids[item.id] = item;
  });
  items.forEach(function(item) {
    if (item.parentId && (!ids[item.parentId] || ids[item.parentId].kind !== 'folder')) {
      throw new Error('โครงสร้างสารบัญไม่ครบ');
    }
  });
  const snapshot = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    app: { name: CATALOG_CONFIG.APP_NAME, year: CATALOG_CONFIG.YEAR, institution: CATALOG_CONFIG.INSTITUTION },
    criteria: { categoryCount: 7, topicCount: 24, indicatorCount: 65 },
    categories: state.categories,
    warnings: state.categories.filter(function(category) { return !category.available; })
      .map(function(category) { return category.name + ': ' + category.issue; }),
    items: items
  };
  const active = properties_().getProperty('CATALOG_ACTIVE_SNAPSHOT');
  const target = active && JSON.parse(active).sheet === 'Catalog_Snapshot_A' ? 'Catalog_Snapshot_B' : 'Catalog_Snapshot_A';
  const pointer = writeJson_(book, target, snapshot);
  properties_().setProperty('CATALOG_ACTIVE_SNAPSHOT', JSON.stringify(pointer));
}
