// ส่งออกข้อมูลทั้งหมดเป็น JSON: node scripts/backup.js [ไฟล์.json|ไฟล์.json.gz]   (ไม่ระบุไฟล์ = เก็บที่ Storage/03 สำรองข้อมูล/[วันที่]/)
require('dotenv').config();
const fs = require('fs'), zlib = require('zlib');
const { pool, migrate } = require('../src/db');
const { exportAll, backupToStorage } = require('../src/backup');
(async () => {
  await migrate();
  const out = process.argv[2];
  if (!out) console.log(await backupToStorage(pool));
  else {
    const c = await pool.connect(); let data; try { await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query('SET LOCAL statement_timeout = 0'); data = await exportAll(c); await c.query('COMMIT'); } finally { c.release(); }
    const buf = Buffer.from(JSON.stringify(data, null, out.endsWith('.gz') ? 0 : 1));
    fs.writeFileSync(out, out.endsWith('.gz') ? zlib.gzipSync(buf) : buf);
    console.log('บันทึก ' + out + ' แล้ว (' + Object.entries(data.tables).map(([k, v]) => k + ':' + v.length).join(', ') + ')');
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
