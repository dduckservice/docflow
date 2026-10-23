// สำรอง/นำเข้าข้อมูลทั้งหมดเป็น JSON
// ไฟล์สำรองเก็บที่: Storage / 03 สำรองข้อมูล / yyyy-MM-dd / docflow-backup-HHmmss.json.gz  (เก็บย้อนหลัง BACKUP_KEEP_DAYS วัน)
const zlib = require('zlib');
const storage = require('./storage');
const { todayStr, partsOf, dayShift } = require('./util');

// เรียงตามลำดับ foreign key (นำเข้าตามลำดับนี้)
const TABLES = ['tenants', 'users', 'license_keys', 'app_settings', 'company_profiles', 'documents', 'document_items', 'audit_log', 'uploads', 'pdf_backups',
  'contacts', 'products', 'expense_categories', 'expenses', 'expense_items', 'purchase_docs', 'purchase_items', 'trash_items', 'chat_threads', 'chat_messages', 'login_events', 'announcements', 'announcement_reads', 'delete_requests', 'company_exports', 'upgrade_requests'];
const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);

async function exportAll(client) {
  const out = { app: 'docflow', version: 1, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of TABLES) {
    const { rows } = await client.query(`SELECT * FROM ${t}`);
    out.tables[t] = rows.map(r => { const o = {}; for (const k of Object.keys(r)) { const v = r[k]; o[k] = Buffer.isBuffer(v) ? { $base64: v.toString('base64') } : v; } return o; });
  }
  return out;
}
// นำเข้าไฟล์ JSON ทั้งก้อน (ลบข้อมูลเดิมทั้งหมดก่อน) — ใช้ย้ายเซิร์ฟเวอร์/กู้คืน
async function importAll(client, data) {
  if (!data || data.app !== 'docflow' || !data.tables) throw new Error('ไฟล์สำรองไม่ถูกต้อง');
  await client.query('SET LOCAL statement_timeout = 0');   // นำเข้าข้อมูลจำนวนมากใช้เวลานาน
  await client.query(`TRUNCATE ${TABLES.slice().reverse().join(', ')} RESTART IDENTITY CASCADE`);
  // รองรับไฟล์สำรองจากเวอร์ชันอื่น: ใช้เฉพาะคอลัมน์ที่มีอยู่ในฐานข้อมูลปัจจุบัน
  const have = {};
  for (const r of (await client.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()")).rows) (have[r.table_name] = have[r.table_name] || new Set()).add(r.column_name);
  for (const t of TABLES) {
    if (!have[t]) continue;
    for (const r of data.tables[t] || []) {
      const cols = Object.keys(r).filter(k => have[t].has(k));
      if (!cols.length) continue;
      const vals = cols.map(k => (r[k] && typeof r[k] === 'object' && r[k].$base64 !== undefined) ? Buffer.from(r[k].$base64, 'base64') : (r[k] && typeof r[k] === 'object' && !(r[k] instanceof Date) ? JSON.stringify(r[k]) : r[k]));
      await client.query(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
    }
    if (['audit_log', 'pdf_backups', 'chat_messages', 'login_events', 'announcements', 'delete_requests', 'company_exports', 'upgrade_requests'].includes(t)) await client.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT max(id) FROM ${t}), 0) + 1, false)`);
  }
}
async function backupToStorage(pool) {
  const client = await pool.connect();
  let data;
  // อ่านทุกตารางจาก snapshot เดียวกัน (ข้อมูลสอดคล้องกันแม้มีคนบันทึกระหว่างสำรอง) และไม่จำกัดเวลา
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL statement_timeout = 0');
    data = await exportAll(client);
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
  const day = todayStr(), p = partsOf();
  const folder = await storage.path('backup', [day]);
  const name = 'docflow-backup-' + p.hour + p.minute + p.second + '.json.gz';
  const f = await storage.put(folder, name, 'application/gzip', zlib.gzipSync(Buffer.from(JSON.stringify(data))));
  // ลบชุดสำรองที่เก่ากว่า KEEP_DAYS วัน
  const cutoff = dayShift(day, -KEEP_DAYS);
  const base = await storage.root('backup');
  let removed = 0;
  for (const d of await storage.listFolders(base)) if (/^\d{4}-\d{2}-\d{2}$/.test(d.name) && d.name < cutoff) { await storage.trashFolder(d.ref); removed++; }
  return { file: name, id: f.id, removed };
}
module.exports = { exportAll, importAll, backupToStorage, TABLES };
