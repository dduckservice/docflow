// ที่เก็บไฟล์: โฟลเดอร์ Storage ในระบบ (STORAGE_DIR)
const impl = require('./local');

// สร้าง/หาโฟลเดอร์ตามลำดับชื่อ ใต้โฟลเดอร์หลัก เช่น path('upload', ['บริษัท', 'ลูกค้า', '2026', '10 ตุลาคม'])
impl.path = async function (which, names) {
  let ref = await impl.root(which);
  for (const n of names) ref = await impl.folder(ref, n);
  return ref;
};
module.exports = impl;
