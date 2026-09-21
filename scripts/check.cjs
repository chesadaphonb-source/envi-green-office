'use strict';

// No dependencies: parse the V8 backend and browser scripts without executing them.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const backend = ['Config.gs', 'CriteriaService.gs', 'DriveService.gs', 'Code.gs', 'SheetService.gs'];
new vm.Script(backend.map(read).join('\n'), { filename: 'apps-script-bundle.gs' });
const client = read('js.html');
assert.match(client, /^\s*<script>[\s\S]*<\/script>\s*$/);
new vm.Script(client.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, ''), { filename: 'js.html' });
const manifest = JSON.parse(read('appsscript.json'));
assert.equal(manifest.runtimeVersion, 'V8');
assert.equal(manifest.timeZone, 'Asia/Bangkok');
assert.deepEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/drive.readonly']);
const clasp = JSON.parse(read('.clasp.json'));
assert.ok(clasp.scriptId);
const index = read('index.html');
const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique');
for (const match of client.matchAll(/(?:getElementById|byId)\(['"]([^'"]+)['"]\)/g)) {
  assert.ok(ids.includes(match[1]), 'Missing HTML element #' + match[1]);
}
assert.doesNotMatch(client, /\.innerHTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/, 'Drive data must use safe DOM rendering');
const branding = read('branding.html');
const logo = branding.match(/src="data:image\/jpeg;base64,([A-Za-z0-9+/=]+)"/);
assert.ok(logo, 'Packaged institutional logo is missing');
assert.deepEqual(Buffer.from(logo[1], 'base64'), fs.readFileSync(path.join(root, 'assets/images/KU copy.jpg')), 'Packaged logo must match the supplied original');
const heroImage = read('hero-image.html').match(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/);
assert.ok(heroImage, 'Packaged hero image is missing');
assert.deepEqual(Buffer.from(heroImage[1], 'base64'), fs.readFileSync(path.join(root, 'assets/images/green-office-building.png')), 'Packaged hero image must match the supplied original');
assert.match(index, /include\('hero-image'\)/, 'Homepage must include the supplied hero image');
console.log('PASS: backend/browser syntax, manifest, DOM IDs, and safe rendering checks');
