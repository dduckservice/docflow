// นำเข้าข้อมูลจากไฟล์ JSON (ลบข้อมูลเดิมทั้งหมด!): node scripts/restore.js <ไฟล์.json|ไฟล์.json.gz> --yes
require('dotenv').config();
const fs = require('fs'), zlib = require('zlib');
const { pool, migrate } = require('../src/db');
const { importAll } = require('../src/backup');
const file = process.argv[2];
if (!file || !process.argv.includes('--yes')) { console.log('ใช้: node scripts/restore.js <ไฟล์.json|.json.gz> --yes   (ข้อมูลปัจจุบันจะถูกแทนที่ทั้งหมด)'); process.exit(1); }
(async () => {
  await migrate();
  let buf = fs.readFileSync(file); if (file.endsWith('.gz')) buf = zlib.gunzipSync(buf);
  const c = await pool.connect();
  try { await c.query('BEGIN'); await importAll(c, JSON.parse(buf.toString('utf8'))); await c.query('COMMIT'); console.log('นำเข้าเรียบร้อย'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
