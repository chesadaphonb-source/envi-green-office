const CATALOG_CONFIG = {
  ROOT_FOLDER_ID: '1DnHxbbw2B4Ow6_Odf8mCmzbsAJYuwYRx',
  APP_NAME: 'Green Office คณะสิ่งแวดล้อม',
  YEAR: '2569',
  INSTITUTION: 'คณะสิ่งแวดล้อม มหาวิทยาลัยเกษตรศาสตร์',
  BUDGET_MS: 210000,
  BATCH_SIZE: 100,
  MAX_STEPS: 3000,
  CHUNK_SIZE: 16000,
  MAX_ITEMS: 50000,
  MAX_JOB_AGE_MS: 5 * 24 * 60 * 60 * 1000,
  TABS: ['Catalog_Staging', 'Catalog_Checkpoint', 'Catalog_Snapshot_A', 'Catalog_Snapshot_B']
};

function categoryDefinitions_() {
  return [
    'การกำหนดนโยบาย การวางแผนการดำเนินงานสำนักงานสีเขียว',
    'การสื่อสารและสร้างจิตสำนึก',
    'การใช้ทรัพยากรและพลังงาน',
    'การจัดการของเสีย',
    'สภาพแวดล้อมและความปลอดภัย',
    'การจัดซื้อและจัดจ้าง',
    'การดำเนินงานสำนักงานสีเขียวเพื่อความต่อเนื่อง'
  ].map(function(title, index) {
    return { number: index + 1, name: 'หมวด ' + (index + 1), title: title };
  });
}
