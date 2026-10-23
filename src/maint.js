// ============================================================
//  maint.js — งานดูแลฐานข้อมูลประจำวัน + ตรวจพื้นที่ดิสก์
//  - ลบประวัติการเข้าสู่ระบบ (login_events) ที่เก่ากว่า LOGIN_LOG_DAYS วัน (ค่าเริ่มต้น 180)
//  - ลบประกาศที่หมดเวลา/หยุดแสดงเกิน 1 ปี
//  - เตือนใน log เมื่อพื้นที่ดิสก์เหลือน้อยกว่า DISK_WARN_PCT % (ค่าเริ่มต้น 10) — ถ้าดิสก์เต็ม PostgreSQL จะหยุดทำงาน
//  ประวัติการแก้ไขเอกสาร (audit_log) เก็บไว้ทั้งหมด เพราะใช้ตรวจสอบย้อนหลัง
// ============================================================
const fs = require('fs');
const path = require('path');

const STORAGE_DIR = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'Storage'));
async function diskInfo() {
  try {
    const st = await fs.promises.statfs(STORAGE_DIR);
    const total = st.blocks * st.bsize, free = st.bavail * st.bsize;
    return { totalGB: +(total / 1e9).toFixed(1), freeGB: +(free / 1e9).toFixed(1), freePct: total ? Math.round(free / total * 100) : 0 };
  } catch (e) { return null; }
}
async function dailyMaintenance(ctx) {
  const days = Math.max(30, Number(process.env.LOGIN_LOG_DAYS || 180));
  const a = await ctx.exec(`DELETE FROM login_events WHERE at < now() - ($1 || ' days')::interval`, [String(days)]);
  const b = await ctx.exec(`DELETE FROM announcements WHERE (stopped_at IS NOT NULL AND stopped_at < now() - interval '365 days') OR (ends_at IS NOT NULL AND ends_at < now() - interval '365 days')`);
  const exportsExpired = await require('./coexport').purgeExpired().catch(() => 0);
  await ctx.exec("DELETE FROM telegram_links WHERE created_at < now() - interval '180 days'");
  const disk = await diskInfo();
  if (disk && disk.freePct < Number(process.env.DISK_WARN_PCT || 10)) console.warn(`⚠️ พื้นที่ดิสก์เหลือน้อย: ว่าง ${disk.freeGB} GB (${disk.freePct}%) จาก ${disk.totalGB} GB`);
  return { exportsExpired, loginEventsRemoved: a.rowCount, announcementsRemoved: b.rowCount, disk };
}
// ---------- ตรวจที่เก็บไฟล์ (สำคัญเมื่อใช้ดิสก์ลูกที่ 2 / NAS) ----------
// ถ้าดิสก์หรือ NAS ยังไม่ได้ mount โฟลเดอร์จะว่างเปล่า → ระบบจะเตือนแทนการเขียนไฟล์ลงที่ผิดเงียบ ๆ
// ไฟล์ .docflow-storage ถูกสร้างไว้ในโฟลเดอร์ Storage ครั้งแรก ใช้ยืนยันว่าเป็นโฟลเดอร์ตัวจริง
const MARKER = '.docflow-storage';
let STORAGE_STATE = { ok: true, msg: '' };
async function storageCheck(pool) {
  const mk = path.join(STORAGE_DIR, MARKER);
  try {
    await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
    const has = fs.existsSync(mk);
    if (!has) {
      // ไม่มีไฟล์ยืนยัน → สุ่มตรวจไฟล์ที่ฐานข้อมูลอ้างถึง ถ้าไม่พบเลยสักไฟล์ = น่าจะยังไม่ได้ mount ดิสก์/NAS
      let refs = [];
      try { refs = (await pool.query("SELECT file_id FROM (SELECT file_id, uploaded_at AS t FROM uploads WHERE file_id IS NOT NULL AND file_id <> '' UNION ALL SELECT file_id, created_at FROM pdf_backups) x ORDER BY t DESC LIMIT 20")).rows.map(r => String(r.file_id)); } catch (e) {}
      const found = refs.filter(f => { try { return fs.existsSync(path.resolve(STORAGE_DIR, f)); } catch (e) { return false; } }).length;
      const files = refs.length;
      if (files > 0 && found === 0) {
        STORAGE_STATE = { ok: false, msg: `ไม่พบไฟล์ของระบบในโฟลเดอร์เก็บไฟล์ (สุ่มตรวจ ${files} ไฟล์ล่าสุด ไม่พบเลย) — ดิสก์/NAS อาจยังไม่ได้เชื่อมต่อ (mount) กรุณาตรวจสอบ ระบบจะตรวจซ้ำทุก 1 นาที` };
        console.error('⚠️ ' + STORAGE_STATE.msg + ' [' + STORAGE_DIR + ']');
        return STORAGE_STATE;
      }
    }
    const t = path.join(STORAGE_DIR, '.write-test-' + process.pid);
    await fs.promises.writeFile(t, 'ok'); await fs.promises.unlink(t);
    if (!has) await fs.promises.writeFile(mk, 'DocFlow storage folder — อย่าลบไฟล์นี้ (ใช้ตรวจว่าเชื่อมต่อดิสก์/NAS ถูกต้อง)\n');
    STORAGE_STATE = { ok: true, msg: '' };
  } catch (e) {
    STORAGE_STATE = { ok: false, msg: 'เขียนไฟล์ลงโฟลเดอร์เก็บไฟล์ไม่ได้ (' + e.code + ') — ตรวจสิทธิ์การเขียนของดิสก์/NAS' };
    console.error('⚠️ ' + STORAGE_STATE.msg + ' [' + STORAGE_DIR + ']');
  }
  return STORAGE_STATE;
}
const storageState = () => STORAGE_STATE;
async function diskOf(dir) { try { const st = await fs.promises.statfs(dir); return { totalGB: +(st.blocks * st.bsize / 1e9).toFixed(1), freeGB: +(st.bavail * st.bsize / 1e9).toFixed(1) }; } catch (e) { return null; } }
module.exports = { dailyMaintenance, diskInfo, storageCheck, storageState, diskOf };
