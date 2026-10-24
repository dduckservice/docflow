// ============================================================
//  cryptbox.js — ห่อ/แกะไฟล์สำรองด้วยรหัสผ่าน (AES-256-GCM)
//  รูปแบบไฟล์: "DFCB1" | salt(16) | iv(12) | authTag(16) | data...
//  ใช้กับ database.json.gz ในไฟล์สำรองทั้งระบบ และไฟล์ JSON รายวัน
//  รหัสผ่านมาจาก BACKUP_PASSPHRASE ใน .env (ถ้าไม่ตั้ง ใช้ TOKEN_SECRET แทน)
// ============================================================
const crypto = require('crypto');
const MAGIC = 'DFCB1';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function keyOf(pass, salt) { return crypto.scryptSync(String(pass), salt, 32, SCRYPT); }
function encrypt(buf, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(pass, salt), iv);
  const data = Buffer.concat([c.update(buf), c.final(), ]);
  const tag = c.getAuthTag();
  return Buffer.concat([Buffer.from(MAGIC, 'ascii'), salt, iv, tag, data]);
}
function isEnc(buf) { return Buffer.isBuffer(buf) && buf.length > 49 && buf.slice(0, 5).toString('ascii') === MAGIC; }
function decrypt(buf, pass) {
  if (!isEnc(buf)) throw new Error('ไม่ใช่ไฟล์สำรองเข้ารหัส (cryptbox)');
  let o = 5;
  const salt = buf.slice(o, o += 16), iv = buf.slice(o, o += 12), tag = buf.slice(o, o += 16), data = buf.slice(o);
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(pass, salt), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);   // รหัสผ่านผิด → GCM tag ไม่ตรง → โยน error
}
function backupPass() { return String(process.env.BACKUP_PASSPHRASE || process.env.TOKEN_SECRET || ''); }

module.exports = { encrypt, decrypt, isEnc, backupPass, MAGIC };
