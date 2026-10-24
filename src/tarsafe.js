// ============================================================
//  tarsafe.js — ตรวจรายชื่อสมาชิกใน archive (tar) ว่าปลอดภัยก่อนแตกไฟล์ลงดิสก์
//  แยกจาก fullbackup.js เพื่อให้ทดสอบได้โดยไม่ต้องเชื่อมต่อฐานข้อมูล
//  (Security Review H1: ปฏิเสธ symlink/device/absolute-path/'..' เพื่อไม่ให้หลบหนีออกจากโฟลเดอร์ปลายทาง)
// ============================================================
const { fail } = require('./util');

// รับ output ของ 'tar -tvf' — อักขระแรกของแต่ละบรรทัดคือชนิดสมาชิก
// อนุญาตเฉพาะ regular file ('-') และ directory ('d') เท่านั้น (symlink 'l' ก็ถูกปฏิเสธด้วย)
function assertTypes(listingTv) {
  for (const ln of String(listingTv).split('\n').filter(Boolean)) {
    const first = ln.trim().split(/\s+/)[0] || '-';
    const t = first[0];
    if (t !== '-' && t !== 'd') fail('ไฟล์สำรองต้องมีเฉพาะไฟล์/โฟลเดอร์ปกติ (พบสมาชิกชนิดพิเศษ): ' + ln.slice(0, 120));
  }
}
// รับ output ของ 'tar -tf' — ชื่อ path ต้องสัมพัทธ์ ไม่มี '..' ('./' = root entry ของ tar อนุญาต)
function assertPaths(namesT) {
  for (const raw of String(namesT).split('\n').filter(Boolean)) {
    if (raw.startsWith('/')) fail('ไฟล์สำรองมี path ไม่ปลอดภัย: ' + raw.slice(0, 160));
    const rel = raw.replace(/^\.\//, '').trim();
    if (!rel || rel === '.') continue;                       // './' หรือ '.' = root ของโฟลเดอร์ ปลอดภัย
    if (rel.split('/').includes('..')) fail('ไฟล์สำรองมี path ไม่ปลอดภัย: ' + raw.slice(0, 160));
  }
}
module.exports = { assertTypes, assertPaths };
