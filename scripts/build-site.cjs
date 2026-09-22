'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkedFreshness, MAX_BYTES } = require('./fetch-catalog.cjs');

const FILES = [
  ['site/index.html', 'index.html'],
  ['site/styles.css', 'styles.css'],
  ['site/app.js', 'app.js'],
  ['site/catalog.js', 'catalog.js'],
  ['assets/images/logo.png', 'assets/images/logo.png'],
  ['assets/images/green-office-building.png', 'assets/images/green-office-building.png']
];

async function buildSite({ root = path.resolve(__dirname, '..'), catalogPath, preview = false } = {}) {
  root = await fs.realpath(root);
  const output = path.join(root, 'dist');
  const stagingRoot = path.join(root, '.local');
  await fs.mkdir(stagingRoot, { recursive: true });
  if ((await fs.realpath(stagingRoot)) !== stagingRoot) throw new Error('The local staging directory must not be a symbolic link.');
  const existing = await fs.lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error('The dist output must be an ordinary directory.');

  let catalog;
  if (!preview) {
    const input = path.resolve(catalogPath || path.join(root, '.local/catalog.json'));
    let raw;
    try {
      if ((await fs.stat(input)).size > MAX_BYTES) throw new Error('Too large');
      raw = JSON.parse(await fs.readFile(input, 'utf8'));
      catalog = checkedFreshness(require(path.join(root, 'site/catalog.js')).validateCatalog(raw));
    } catch {
      throw new Error('A valid catalog snapshot from the last 48 hours is required. Run npm run catalog:fetch, or use npm run preview:build for layout preview only.');
    }
  }

  const sources = [];
  for (const [source, destination] of FILES) {
    const absolute = path.join(root, source);
    const resolved = await fs.realpath(absolute);
    if (!resolved.startsWith(root + path.sep) || !(await fs.lstat(absolute)).isFile()) {
      throw new Error('A build input is missing or is not an ordinary project file.');
    }
    sources.push([absolute, destination]);
  }

  const staging = await fs.mkdtemp(path.join(stagingRoot, 'site-build-'));
  const backup = path.join(stagingRoot, 'site-previous-' + crypto.randomUUID());
  let movedPrevious = false;
  try {
    for (const [source, destination] of sources) {
      const target = path.join(staging, destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    await fs.writeFile(path.join(staging, '.nojekyll'), '');
    if (catalog) {
      await fs.mkdir(path.join(staging, 'data'));
      await fs.writeFile(path.join(staging, 'data/catalog.json'), JSON.stringify(catalog) + '\n');
    }
    // Preview deliberately has no catalog.json, so the app shows the real setup/unavailable state.
    if (existing) {
      await fs.rename(output, backup);
      movedPrevious = true;
    }
    try { await fs.rename(staging, output); }
    catch (error) {
      if (movedPrevious) await fs.rename(backup, output);
      movedPrevious = false;
      throw error;
    }
    if (movedPrevious) await fs.rm(backup, { recursive: true, force: true });
    return { output, preview, generatedAt: catalog?.generatedAt || null };
  } finally {
    // Both paths are created beneath the verified project-local staging root above.
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--preview') options.preview = true;
    else if (args[i] === '--catalog' && args[i + 1] && !args[i + 1].startsWith('--')) options.catalogPath = args[++i];
    else throw new Error('Usage: node scripts/build-site.cjs [--catalog path] [--preview]');
  }
  if (options.preview && options.catalogPath) throw new Error('Choose either --preview or --catalog.');
  return options;
}

if (require.main === module) {
  Promise.resolve().then(() => buildSite(parseArguments(process.argv.slice(2)))).then(result => {
    console.log(result.preview ? 'Layout preview built in dist/. No document catalog is included.' : 'Production site built in dist/.');
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { buildSite, parseArguments, FILES };
