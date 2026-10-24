// นำเข้าข้อมูลจากไฟล์ JSON (ลบข้อมูลเดิมทั้งหมด!): node scripts/restore.js <ไฟล์.json|ไฟล์.json.gz|ไฟล์.json.enc> --yes
require('dotenv').config();
const fs = require('fs'), zlib = require('zlib');
const { pool, migrate } = require('../src/db');
const { importAll } = require('../src/backup');
const CB = require('../src/cryptbox');
const file = process.argv[2];
if (!file || !process.argv.includes('--yes')) { console.log('ใช้: node scripts/restore.js <ไฟล์.json|.json.gz|.json.enc> --yes   (ข้อมูลปัจจุบันจะถูกแทนที่ทั้งหมด)'); process.exit(1); }
(async () => {
  await migrate();
  let buf = fs.readFileSync(file);
  if (CB.isEnc(buf)) {
    const pass = CB.backupPass();
    if (!pass) throw new Error('ไฟล์นี้เข้ารหัสไว้ — ต้องตั้ง BACKUP_PASSPHRASE (หรือ TOKEN_SECRET) ใน .env ให้ตรงกับตอนสำรอง');
    buf = CB.decrypt(buf, pass);
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);   // ระบุได้จาก gzip magic: .gz / .enc (หลังแกะ) / .json ตรง ๆ
  const c = await pool.connect();
  try { await c.query('BEGIN'); await importAll(c, JSON.parse(buf.toString('utf8'))); await c.query('COMMIT'); console.log('นำเข้าเรียบร้อย'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
