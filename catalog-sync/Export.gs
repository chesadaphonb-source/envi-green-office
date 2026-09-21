/** Health only: never expose metadata, secrets, or configuration via GET. */
function doGet() {
  return jsonResponse_({ service: 'green-office-catalog', ok: true });
}

/** GitHub Actions calls POST server-to-server. No browser/API key in frontend. */
function doPost(event) {
  try {
    const props = properties_();
    const expected = props.getProperty('CATALOG_EXPORT_TOKEN');
    if (props.getProperty('CATALOG_PUBLISH_ENABLED') !== 'true' ||
        !expected || expected.length < 32) return jsonResponse_({ ok: false, error: 'export_disabled' });
    const body = event && event.postData && event.postData.contents;
    if (typeof body !== 'string' || body.length > 4096) return jsonResponse_({ ok: false, error: 'unauthorized' });
    let input;
    try { input = JSON.parse(body); } catch (error) { return jsonResponse_({ ok: false, error: 'unauthorized' }); }
    if (!input || !tokensEqual_(input.token, expected)) return jsonResponse_({ ok: false, error: 'unauthorized' });
    const book = catalogBook_();
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = props.getProperty('CATALOG_ACTIVE_SNAPSHOT');
      if (!raw) return jsonResponse_({ ok: false, error: 'catalog_not_ready' });
      try {
        const snapshot = readJson_(book, JSON.parse(raw));
        if (raw === props.getProperty('CATALOG_ACTIVE_SNAPSHOT')) return jsonResponse_(snapshot);
      } catch (error) {
        if (raw === props.getProperty('CATALOG_ACTIVE_SNAPSHOT')) throw error;
      }
    }
    return jsonResponse_({ ok: false, error: 'catalog_busy' });
  } catch (error) {
    // Never return Drive/Sheet IDs or internals in errors from the anonymous endpoint.
    return jsonResponse_({ ok: false, error: 'catalog_unavailable' });
  }
}

function tokensEqual_(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return difference === 0;
}

function jsonResponse_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
