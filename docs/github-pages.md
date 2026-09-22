# ย้าย Green Office ไป GitHub Pages

หน้าเว็บใหม่อยู่ใน `site/` เป็น HTML/CSS/JavaScript ปกติ เปิดหน้า ค้นหา และเปลี่ยนหมวดจากสารบัญชุดเดียวบน GitHub Pages ส่วน PDF รูปภาพ และ Word ยังอยู่ใน Google Drive ตามเดิม รูปตกแต่งหน้าเว็บอยู่ใน `assets/images/` ไม่ฝังภาพขนาดใหญ่เป็น Base64 แล้ว

```text
Google Drive → Apps Script จัดทำสารบัญ → Google Sheet ส่วนตัว
                                              ↓
                             GitHub Actions ดึง snapshot ที่สำเร็จ
                                              ↓
                         GitHub Pages: หน้าเว็บ + data/catalog.json
                                              ↓
                          ผู้ชมเปิด PDF / รูปภาพจาก Drive ตามสิทธิ์
```

เว็บ Apps Script เดิมยังใช้ได้ระหว่างการย้าย ไม่ต้องอัปโหลดไฟล์ HTML รุ่นใหม่ทับโปรเจกต์เดิม คู่มือส่วนนี้ยังไม่หมายความว่าเว็บใหม่ถูกเผยแพร่แล้ว

## ทดลองในเครื่อง

ติดตั้ง Node.js 24 ขึ้นไป แล้วเปิด Terminal ที่ `D:\green-office-envi` โครงการไม่ต้องติดตั้งแพ็กเกจเพิ่ม

```powershell
npm.cmd test
npm.cmd run preview:build
npm.cmd run preview -- --base /green-office-envi/
```

เปิด `http://127.0.0.1:4173/green-office-envi/` การทดลองนี้แสดงหน้าตาจริงและสถานะที่ยังไม่มีสารบัญ ไม่สร้างชื่อเอกสารสมมติ หากต้องการดูข้อมูลจริง ให้ตั้งค่าการส่งออกด้านล่างแล้วรัน `npm.cmd run catalog:fetch` และ `npm.cmd run build` แทน `preview:build`

`preview:build` สร้าง `dist/` ใหม่สำหรับดูหน้าตา และเอาสารบัญที่เคยสร้างใน `dist/` ออก จึงควรใช้ `build` อีกครั้งเมื่อต้องการดูข้อมูลจริง ข้อมูลต้นฉบับใน Drive, Sheet และ `.local/catalog.json` ไม่ได้รับผลกระทบ

## เชื่อมสารบัญจาก Drive และ Sheet

ทำตาม [คู่มือโปรเจกต์จัดทำสารบัญ](../catalog-sync/README.md) โดยสร้าง Apps Script แยกจากเว็บเดิม และ Google Sheet ใหม่สำหรับเก็บสารบัญโดยเฉพาะ

ตั้ง `CATALOG_SHEET_ID` ใน Script Properties แล้วรัน `setupCatalogSync` และ `syncCatalog` ด้วยบัญชีที่อ่าน Drive ต้นทางได้ ตัวจัดทำสารบัญจะทยอยทำงานและเผยแพร่ snapshot ต่อเมื่อสแกนครบทั้งรอบ Sheet ไม่ต้องแชร์สาธารณะหรือ Publish to web

ก่อนเปิดส่งออก ต้องยืนยันว่ารายการชื่อเอกสาร ชื่อโฟลเดอร์ รหัสไฟล์ เส้นทาง และลิงก์ในสารบัญเปิดให้บุคคลทั่วไปเห็นได้ เพราะ `data/catalog.json` บนเว็บนี้เป็นไฟล์สาธารณะ การเก็บ repository เป็น private ไม่ได้ทำให้เว็บ Pages ทั่วไปเป็นระบบล็อกอิน และสิทธิ์ดูเนื้อหาใน Drive ยังเป็นอีกส่วนหนึ่ง หากต้องการจำกัดผู้ชมเฉพาะมหาวิทยาลัย ต้องเลือกระบบโฮสต์ที่ตรวจสิทธิ์ผู้ใช้แทนโครงสร้าง Pages สาธารณะนี้ [ข้อมูล GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

เมื่อตรวจรายการแล้ว ตั้ง Script Properties ดังนี้:

| ชื่อ | ค่า |
| --- | --- |
| `CATALOG_EXPORT_TOKEN` | ค่าสุ่มที่เดายากอย่างน้อย 32 ตัวอักษร ใช้ตรงกันกับ GitHub Actions |
| `CATALOG_PUBLISH_ENABLED` | `true` |

Deploy โปรเจกต์จัดทำสารบัญเป็น Web app ตามคู่มือ แล้วเก็บ URL รูปแบบ `https://script.google.com/macros/s/รหัสDeployment/exec` ไว้ใช้เป็น secret ห้ามใส่ token ลง URL, HTML, JavaScript, Sheet หรือ Git

ระบบดึงข้อมูลใช้ POST ส่ง token ไปยัง URL นี้เท่านั้น และเปลี่ยนเป็น GET ที่ไม่มี token เมื่อตาม redirect ของ Google Content Service ไปยัง `script.googleusercontent.com` [พฤติกรรม Content Service](https://developers.google.com/apps-script/guides/content)

## ตั้งค่า GitHub และเผยแพร่

ต้องมี repository ในบัญชีหรือองค์กร GitHub ของผู้ดูแลก่อน โค้ดพร้อมให้เชื่อม repository แต่ไม่มีการสร้าง repository หรือเผยแพร่ให้อัตโนมัติจากคู่มือนี้ ตรวจไฟล์ที่จะ commit ให้แน่ใจว่าไม่มี `.env`, `.clasprc.json`, `.local/`, `dist/` หรือ `catalog-sync/.clasp.json` ติดไปด้วย

1. นำโค้ดเข้า repository ที่เลือก และเลือก default branch เป็น `main` หรือ `master`
2. ใน repository ไปที่ **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. ไปที่ **Settings → Secrets and variables → Actions → Secrets** เพิ่ม repository secrets:

   | Secret | ค่า |
   | --- | --- |
   | `CATALOG_EXPORT_URL` | URL `/exec` ของ Apps Script จัดทำสารบัญโปรเจกต์ใหม่ |
   | `CATALOG_EXPORT_TOKEN` | ค่าเดียวกับ Script Property |

4. ในแท็บ **Variables** เพิ่ม `PAGES_PUBLISH_ENABLED` เป็น `true` เมื่อพร้อมให้ metadata ในสารบัญเป็นสาธารณะ ก่อนตั้งค่านี้ workflow จะข้ามการเผยแพร่
5. ตรวจ Environment `github-pages` ให้ deploy ได้เฉพาะ default branch ที่เลือก จากนั้นเปิด **Actions → Publish Green Office → Run workflow** โดยเลือก default branch
6. เมื่อ job `deploy` สำเร็จ ใช้ลิงก์จาก Environment หรือ Settings → Pages เป็นลิงก์เว็บไซต์ใหม่ ตรวจหน้าแรก หมวด โฟลเดอร์ การค้นหา PDF รูปหลายใบ และปุ่มย้อนกลับก่อนเปลี่ยนลิงก์ที่แจกผู้ใช้

workflow ทดสอบโค้ดทุกครั้งที่ push แม้ยังไม่เปิดเผยแพร่เว็บ เมื่อเปิดเผยแพร่แล้วจึงดึงสารบัญ สร้างเฉพาะไฟล์หน้าเว็บที่อนุญาต และอัปโหลดเฉพาะ `dist/` ส่วน Apps Script, credentials, Sheet และไฟล์สำรองไม่อยู่ในเว็บไซต์ที่เผยแพร่ ขั้น checks และ build ใช้ `contents: read` ส่วนขั้น deploy ใช้ `pages: write` กับ `id-token: write` [การใช้ GitHub Actions กับ Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)

โครงการไม่มี npm dependencies และใช้ Node.js 24 ผ่าน `actions/setup-node` โดยปิด package cache [คู่มือ setup-node](https://github.com/actions/setup-node)

## เมื่อเพิ่มหรือแก้เอกสาร

เพิ่มไฟล์ใน Drive ตามโฟลเดอร์เดิม Apps Script ถูกตั้งให้ทำงานทุก 15 นาที ส่วน workflow ถูกตั้งให้ทำงานนาทีที่ 17 ของทุกชั่วโมง รวมถึงเมื่อ push `main`/`master` และเมื่อกด Run workflow ข้อมูลมากอาจต้องสแกนหลายรอบ จึงไม่ได้อัปเดตบนเว็บทันทีเมื่ออัปโหลดไฟล์

หากต้องการอัปเดตเร็ว ให้รัน `syncCatalog` จนรอบสำเร็จ แล้วกด Run workflow บน GitHub ตารางเวลาของ GitHub อาจล่าช้า และ scheduled workflows ใน public repository อาจหยุดหลังไม่มี repository activity 60 วัน ควรตรวจหน้า Actions และวันที่อัปเดตสารบัญเป็นระยะ [ข้อจำกัด schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

การโหลดข้อมูลใหม่ในหน้าเว็บจะอ่าน snapshot ที่ GitHub Pages มีอยู่ ไม่ได้สั่งสแกน Drive หรือรัน Apps Script

## ถ้าระบบอัปเดตไม่สำเร็จ

| อาการ | จุดตรวจ |
| --- | --- |
| Workflow ถูกข้าม | `PAGES_PUBLISH_ENABLED` ใน Actions Variables ต้องเป็นข้อความ `true` |
| Catalog export did not return JSON | URL ต้องเป็น `/exec` ของโปรเจกต์ใหม่ และ Web app ต้องเข้าถึงได้ตามที่คู่มือกำหนด |
| Catalog export failed validation | ตรวจ token, `CATALOG_PUBLISH_ENABLED` และว่ามี snapshot ที่สแกนครบแล้ว |
| Catalog snapshot must have ... last 48 hours | ตรวจ Apps Script Executions และ trigger จากนั้นรัน `syncCatalog` ใหม่ |
| PDF หรือรูปขึ้นขอสิทธิ์ | ตรวจสิทธิ์ของไฟล์ Drive นั้น เว็บไซต์ไม่ได้เพิ่มสิทธิ์ให้อัตโนมัติ |

การดึงข้อมูลแต่ละครั้งมีเวลาสูงสุด 60 วินาที และลองใหม่ได้สูงสุด 3 ครั้งเมื่อ Google ตอบกลับไม่สำเร็จ ทุกครั้งเริ่มจาก URL ที่กำหนดและตรวจ redirect ตามเดิม รับข้อมูลขนาดสูงสุด 20 MiB และยอมรับเฉพาะ snapshot ที่สร้างไม่เกิน 48 ชั่วโมง หากดึง ตรวจข้อมูล หรือ build ไม่ผ่าน workflow จะไม่ deploy เว็บรุ่นก่อนยังอยู่ ส่วนสารบัญในเครื่องจะเขียนทับเมื่อดาวน์โหลดและตรวจสอบสำเร็จแล้วเท่านั้น

การปิด `CATALOG_PUBLISH_ENABLED` หรือ `PAGES_PUBLISH_ENABLED` หยุดการอัปเดตครั้งถัดไป แต่ไม่ถอน `catalog.json` ที่เผยแพร่แล้ว หากต้องถอดข้อมูลเร่งด่วน ต้องเอาข้อมูลออกและเผยแพร่ใหม่ หรือปิด Pages ด้วย

## ไฟล์ที่ต้องดูแล

| ไฟล์/โฟลเดอร์ | หน้าที่ |
| --- | --- |
| `site/index.html`, `site/styles.css`, `site/app.js` | หน้าตาและการใช้งานเว็บใหม่ |
| `site/catalog.js` | ตรวจรูปแบบสารบัญและค้นหาข้อมูลในเบราว์เซอร์ |
| `assets/images/` | โลโก้และรูปหน้าแรก |
| `catalog-sync/` | Apps Script จัดทำสารบัญลง Sheet |
| `scripts/fetch-catalog.cjs` | ดึงสารบัญโดยใช้ Actions secrets |
| `scripts/build-site.cjs` | สร้างไฟล์ที่จะเผยแพร่ใน `dist/` |
| `.github/workflows/pages.yml` | ทดสอบ อัปเดตข้อมูล และ deploy |

พื้นที่กราฟพลังงานยังเว้นไว้ตามที่ตกลง เมื่อพร้อมสามารถเพิ่มแท็บข้อมูลพลังงานและ export แยกในภายหลัง โดยไม่ต้องนำ Apps Script กลับมาเป็นตัวให้บริการหน้าเว็บ
