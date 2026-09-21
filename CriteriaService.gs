/** Renewal / upgrade criteria supplied for Green Office 2569. */
function getCriteria_() {
  return { categoryCount: 7, topicCount: 24, indicatorCount: 65 };
}

function getCategoryDefinitions_() {
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
