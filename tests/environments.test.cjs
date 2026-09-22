'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { FILES } = require('../scripts/build-site.cjs');
const { buildEnvironments } = require('../scripts/build-environments.cjs');
const project = path.resolve(__dirname, '..');

test('SIT and PRD use independent frontend files, with a test banner only in SIT and no private files', async t => {
  const root = await fs.mkdtemp(path.join(project, '.local/env-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sitRoot = path.join(root, '.local/sit-source');
  for (const [directory, marker] of [[root, 'PRD'], [sitRoot, 'SIT']]) {
    for (const [source] of FILES) {
      const target = path.join(directory, source);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (source === 'site/catalog.js') await fs.copyFile(path.join(project, source), target);
      else await fs.writeFile(target, source === 'site/index.html' ? '<html><head><title>' + marker + '</title></head><body>' + marker + '</body></html>' : marker);
    }
    await fs.mkdir(path.join(directory, '.local'), { recursive: true });
    await fs.mkdir(path.join(directory, 'scripts'), { recursive: true });
    for (const script of ['build-site.cjs', 'fetch-catalog.cjs']) await fs.copyFile(path.join(project, 'scripts', script), path.join(directory, 'scripts', script));
    await fs.writeFile(path.join(directory, '.env'), 'PRIVATE');
  }
  const snapshot = { schemaVersion: 1, generatedAt: new Date().toISOString(), app: { name: 'Green Office', year: '2569', institution: 'ENVI' },
    criteria: { categoryCount: 7, topicCount: 24, indicatorCount: 65 },
    categories: Array.from({ length: 7 }, (_, index) => ({ number: index + 1, name: 'หมวด' + (index + 1), title: 'หมวด', id: null, available: false, issue: 'ไม่มีข้อมูล' })), items: [], warnings: [] };
  await fs.writeFile(path.join(root, '.local/catalog.json'), JSON.stringify(snapshot));
  await buildEnvironments({ root, sitRoot });
  assert.equal(await fs.readFile(path.join(root, 'dist/app.js'), 'utf8'), 'PRD');
  assert.equal(await fs.readFile(path.join(root, 'dist/sit/app.js'), 'utf8'), 'SIT');
  const prd = await fs.readFile(path.join(root, 'dist/index.html'), 'utf8');
  assert.equal(prd, '<html><head><title>PRD</title></head><body>PRD</body></html>');
  const sit = await fs.readFile(path.join(root, 'dist/sit/index.html'), 'utf8');
  assert.match(sit, /SIT · เว็บทดสอบ/);
  assert.match(sit, /noindex,nofollow/);
  assert.match(sit, /href="\.\.\/"/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'dist/sit/data/catalog.json'), 'utf8')), JSON.parse(await fs.readFile(path.join(root, 'dist/data/catalog.json'), 'utf8')));
  await assert.rejects(fs.access(path.join(root, 'dist/.env')));
  await assert.rejects(fs.access(path.join(root, 'dist/sit/.env')));
  await assert.rejects(buildEnvironments({ root, sitRoot: root }), /separate checkout/);
});
