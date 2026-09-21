# สารบัญ Drive → Sheet สำหรับเว็บ GitHub Pages

โปรเจกต์ Apps Script **แยกจากเว็บเดิม** อ่าน Drive แล้วบันทึกสารบัญไว้ใน Google Sheet ส่วนหน้าเว็บอ่าน `data/catalog.json` ที่ GitHub Actions ส่งออกมา จึงไม่สแกน Drive ทุกครั้งที่เปิดหน้าเว็บ

## ตั้งค่าครั้งแรก

1. สร้าง Google Sheet ใหม่สำหรับสารบัญโดยเฉพาะ เก็บเป็นส่วนตัว ไม่ต้อง Publish to web และไม่ต้องเปลี่ยนสิทธิ์ไฟล์ Drive
2. สร้าง Apps Script ใหม่ในบัญชีที่อ่านโฟลเดอร์ Drive ของ Green Office ได้ ห้ามใช้ Script ID ของเว็บเดิม
3. คัดลอก `.clasp.example.json` เป็น `.clasp.json` ในโฟลเดอร์นี้ ใส่ Script ID ใหม่ แล้วรัน `clasp.cmd push` จาก `catalog-sync` เท่านั้น หรือคัดลอกไฟล์ `.gs` และ manifest ลงโปรเจกต์ใหม่ผ่านหน้า Apps Script
4. ใน Project Settings → Script Properties ตั้ง `CATALOG_SHEET_ID` เป็นรหัสของ Sheet ใหม่
5. รัน `setupCatalogSync` และอนุญาตสิทธิ์อ่าน Drive, เขียน Sheet และสร้าง trigger ฟังก์ชันจะสร้างแท็บ `Catalog_Staging`, `Catalog_Checkpoint`, `Catalog_Snapshot_A`, `Catalog_Snapshot_B` และ trigger ทุก 15 นาทีเพียงหนึ่งตัว ไม่เปลี่ยนสิทธิ์การแชร์
6. รัน `syncCatalog` เพื่อเริ่มทันที ถ้าข้อมูลมาก รอบถัดไปจะทำต่อจากจุดเดิม ดู `CATALOG_LAST_STATUS` ใน Script Properties หรือหน้า Executions หากเกิดข้อผิดพลาด
7. ตรวจ snapshot และยืนยันว่าชื่อเอกสาร เส้นทางโฟลเดอร์ รหัสไฟล์ และลิงก์ทั้งหมดที่จะส่งออกเผยแพร่ต่อบุคคลทั่วไปได้ **GitHub Pages และ `catalog.json` เป็นข้อมูลสาธารณะ** แม้เนื้อหาไฟล์ Drive จะยังจำกัดสิทธิ์อยู่ก็ตาม
8. เมื่อตรวจเรียบร้อย ตั้ง `CATALOG_EXPORT_TOKEN` เป็นค่าสุ่มที่เดายากอย่างน้อย 32 ตัวอักษร และตั้ง `CATALOG_PUBLISH_ENABLED` เป็น `true` เอง โค้ดจะไม่เปิดสวิตช์นี้ให้อัตโนมัติ
9. Deploy โปรเจกต์ใหม่นี้เป็น Web app: Execute as เจ้าของโปรเจกต์, Who has access Anyone ใช้ URL `/exec` เป็น GitHub Actions secret `CATALOG_EXPORT_URL` และ token เดียวกันเป็น `CATALOG_EXPORT_TOKEN` ตามคู่มือ migration หลัก ห้ามใส่ token ลง HTML/JS, URL, Sheet หรือ Git

## การทำงานและการตรวจสอบ

- อ่านเฉพาะหมวด 1–7 ที่เป็นโฟลเดอร์ลูกโดยตรงของรากที่กำหนด ชื่อหมวดซ้ำจะไม่เผยแพร่ทั้งหมวดนั้น ไม่ติดตามหรือส่งออก Drive shortcuts
- ข้อมูลในแท็บเป็น JSON ที่แบ่งเป็นแถวเพื่อหลีกเลี่ยงข้อจำกัดขนาดเซลล์ ห้ามแก้แท็บที่ระบบสร้างเอง ใช้ Sheet แยกอีกแท็บ/ไฟล์สำหรับข้อมูลพลังงานในอนาคต
- บันทึกความคืบหน้าเป็นชุดใน Sheet และตรวจ hash ก่อนยอมรับจุดบันทึก ระหว่างสแกน/ตรวจสอบ เว็บไซต์ยังใช้ snapshot ที่สำเร็จล่าสุด
- ตรวจเส้นทางกลับไปยังหมวดเมื่อทำโฟลเดอร์ต่อ และตรวจรายการทุกชิ้นก่อนเผยแพร่ หากรายการเปลี่ยนระหว่างสแกน จะเก็บ snapshot เดิมและเริ่มสแกนใหม่ในรอบถัดไป ไฟล์ที่ลบจะหายจากสารบัญเมื่อสแกนครบรอบใหม่
- ล็อกป้องกันงานซ้อนกัน แต่ละรอบจำกัดประมาณ 3.5 นาที/3,000 ขั้นตอน งานขนาดใหญ่ใช้หลายรอบ การอัปเดตจึงอาจใช้เกิน 15 นาที รวมเวลารอ GitHub Actions ด้วย
- snapshot ใหม่เขียนลงอีกแท็บ ตรวจอ่านกลับครบก่อนสลับ pointer เดียว หากเขียนไม่สำเร็จ snapshot ที่ใช้งานอยู่จะไม่ถูกแทนที่
- Drive ไม่มี transaction ครอบการสแกนทั้งหมด จึงควรลดการย้าย/เปลี่ยนชื่อจำนวนมากระหว่างสแกน หากเปลี่ยนสิทธิ์หรือถอดเอกสารเร่งด่วน ให้ปิด export และเอาไฟล์ออกจากเว็บที่เผยแพร่ด้วย เพราะ snapshot สาธารณะเก่าไม่ได้ถูกถอนทันที
- API `GET` แสดงเพียงสถานะบริการ ส่วน `POST` รับ JSON `{"token":"..."}` ส่งคืน snapshot schemaVersion 1 หรือ `{ "ok": false, "error": "..." }` ข้อผิดพลาดของ ContentService ยังตอบ HTTP 200 ฝั่ง Actions จึงต้องตรวจ schema เสมอ
- ปิดการส่งออกได้ทันทีด้วย `CATALOG_PUBLISH_ENABLED=false` การปิดนี้ไม่ลบ `catalog.json` ที่ GitHub Pages เผยแพร่ไปแล้ว

ทดสอบในเครื่อง: `node --test tests/catalog-sync.test.cjs` จากราก repository

เอกสารอ้างอิง: [Drive iterators](https://developers.google.com/apps-script/reference/drive/file-iterator), [Installable triggers](https://developers.google.com/apps-script/guides/triggers/installable), [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
