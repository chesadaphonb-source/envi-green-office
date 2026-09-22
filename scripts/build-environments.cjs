'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildSite } = require('./build-site.cjs');

async function buildEnvironments({ root = path.resolve(__dirname, '..'), sitRoot = path.join(root, '.local/sit-source'), catalogPath = path.join(root, '.local/catalog.json') } = {}) {
  root = await fs.realpath(root);
  sitRoot = await fs.realpath(sitRoot);
  if (root === sitRoot || !sitRoot.startsWith(root + path.sep)) throw new Error('SIT must use a separate checkout inside the build workspace.');
  const production = await buildSite({ root, catalogPath });
  const sitBuilder = require(path.join(sitRoot, 'scripts/build-site.cjs'));
  const sit = await sitBuilder.buildSite({ root: sitRoot, catalogPath });
  const destination = path.join(production.output, 'sit');
  await fs.cp(sit.output, destination, { recursive: true, errorOnExist: true, force: false });
  const indexPath = path.join(destination, 'index.html');
  const html = await fs.readFile(indexPath, 'utf8');
  if (!html.includes('<head>') || !html.includes('<body>')) throw new Error('SIT page is missing its document structure.');
  const banner = '<aside aria-label="เว็บไซต์ทดสอบ" style="padding:12px 20px;background:#fff2cc;color:#573e00;border-bottom:2px solid #b7891a;font:600 18px/1.6 Tahoma,sans-serif;text-align:center">SIT · เว็บทดสอบ — ใช้สำหรับทดลองฟังก์ชันใหม่ <a href="../" style="color:#174b36;text-decoration:underline;margin-left:12px">ไปเว็บใช้งานจริง (PRD)</a></aside>';
  await fs.writeFile(indexPath, html.replace('<head>', '<head>\n  <meta name="robots" content="noindex,nofollow">').replace('<body>', '<body>\n  ' + banner));
  return { production: production.output, sit: destination };
}

if (require.main === module) buildEnvironments().then(() => console.log('Built main as PRD and the sit checkout under /sit/.'))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildEnvironments };
