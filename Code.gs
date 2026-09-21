function doGet(e) {
  const template = HtmlService.createTemplateFromFile('index');

  template.appName = CONFIG.APP_NAME;
  template.year = CONFIG.YEAR;
  template.institution = CONFIG.INSTITUTION;
  template.criteria = getCriteria_();
  const serviceUrl = ScriptApp.getService().getUrl() || '';
  // Workspace can return /a/domain/macros/s/...; share the canonical web-app URL.
  const deployment = serviceUrl.match(/^https:\/\/script\.google\.com\/(?:a\/[^/]+\/)?macros\/s\/([A-Za-z0-9_-]+)\/(exec|dev)$/);
  template.appUrl = deployment ? 'https://script.google.com/macros/s/' + deployment[1] + '/' + deployment[2] : '';
  template.initialRoute = JSON.stringify((e && e.parameter) || {});

  return template.evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  // Only reviewed static frontend fragments may be returned by this helper.
  if (['css', 'js', 'branding', 'hero-image'].indexOf(filename) === -1) {
    throw new Error('ไม่พบส่วนประกอบของหน้าเว็บ');
  }
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
