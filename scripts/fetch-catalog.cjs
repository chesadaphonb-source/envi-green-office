'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;

function checkedEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('CATALOG_EXPORT_URL is missing or invalid.'); }
  if (url.origin !== 'https://script.google.com' || url.username || url.password ||
      url.search || url.hash || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname)) {
    throw new Error('CATALOG_EXPORT_URL must be the canonical Apps Script /macros/s/.../exec URL.');
  }
  return url.href;
}

function checkedRedirect(value, previous) {
  let url;
  try { url = new URL(value, previous); } catch { throw new Error('Catalog export returned an invalid redirect.'); }
  if (url.origin !== 'https://script.googleusercontent.com' || url.username || url.password || url.hash) {
    throw new Error('Catalog export redirected outside the approved Google Content Service host.');
  }
  return url.href;
}

function checkedFreshness(snapshot, now = Date.now()) {
  const generated = Date.parse(snapshot.generatedAt);
  if (!Number.isFinite(generated) || generated > now + 5 * 60 * 1000 || now - generated > MAX_AGE_MS) {
    throw new Error('Catalog snapshot must have a valid generatedAt from the last 48 hours. Run the catalog indexer again.');
  }
  return snapshot;
}

async function limitedText(response, signal, maxBytes = MAX_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Catalog export is too large.');
  if (!response.body) throw new Error('Catalog export returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error('Catalog export is too large.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchCatalog({ url, token, fetchImpl = fetch, now = Date.now(), timeoutMs = 60000, validate } = {}) {
  let destination = checkedEndpoint(url);
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[\r\n]/.test(token)) {
    throw new Error('CATALOG_EXPORT_TOKEN must contain between 32 and 512 characters.');
  }
  validate ||= require('../site/catalog.js').validateCatalog;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let method = 'POST';
  try {
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetchImpl(destination, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ token }) } : {}),
        redirect: 'manual',
        signal: controller.signal
      });
      if (response.status === 302 || response.status === 303) {
        await response.body?.cancel();
        if (redirects === 3) throw new Error('Catalog export returned too many redirects.');
        const location = response.headers.get('location');
        if (!location) throw new Error('Catalog export returned a redirect without a location.');
        destination = checkedRedirect(location, destination);
        // Content Service redirects to a one-time GET URL. Never forward the POST token.
        method = 'GET';
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Catalog export failed. Check its deployment, token and indexer status.');
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
        await response.body?.cancel();
        throw new Error('Catalog export did not return JSON. Check the web app deployment access.');
      }
      const body = await limitedText(response, controller.signal);
      let raw;
      try { raw = JSON.parse(body); } catch { throw new Error('Catalog export returned invalid JSON.'); }
      let snapshot;
      try { snapshot = validate(raw); } catch { throw new Error('Catalog export failed validation. Check the completed snapshot in the indexer.'); }
      return checkedFreshness(snapshot, now);
    }
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Catalog export timed out. The previous catalog was preserved.');
    // Network errors can contain the private redirect URL; only our own fixed messages are exposed by the CLI.
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function writeCatalog(snapshot, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function main() {
  const snapshot = await fetchCatalog({ url: process.env.CATALOG_EXPORT_URL, token: process.env.CATALOG_EXPORT_TOKEN });
  await writeCatalog(snapshot, path.resolve(__dirname, '../.local/catalog.json'));
  console.log('Validated catalog saved locally. Snapshot: ' + snapshot.generatedAt);
}

if (require.main === module) main().catch(error => {
  const safe = /^(CATALOG_EXPORT_|Catalog (export|snapshot))/.test(error.message || '');
  console.error(safe ? error.message : 'Catalog export failed. Check the deployment and network connection; the previous catalog was preserved.');
  process.exitCode = 1;
});

module.exports = { checkedEndpoint, checkedRedirect, checkedFreshness, fetchCatalog, writeCatalog, MAX_BYTES };
