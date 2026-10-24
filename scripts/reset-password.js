// รีเซ็ตรหัสผ่าน (แทน adminResetPassword เดิม)
// วิธีใช้:  DOCFLOW_PASSWORD='รหัสผ่านใหม่' node scripts/reset-password.js <username> [--enable]
//   --enable = ปล-status บัญชี disabled ให้กลับใช้งานได้ (ค่าเริ่มต้น: ไม่เปลี่ยนสถานะ — Security Review L9)
// แนะนำส่งรหัสผ่านผ่านตัวแปรแวดล้อม DOCFLOW_PASSWORD เพื่อไม่ให้ปรากฏใน ps / shell history
const run = require('./_ctx');
const { hashPw, newSalt, checkPw } = require('../src/platform');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = process.argv.slice(2).filter(a => a.startsWith('--'));
const username = args[0];
const password = process.env.DOCFLOW_PASSWORD || args[1];
if (!username || !password) { console.log('ใช้: DOCFLOW_PASSWORD=<รหัสผ่านใหม่> node scripts/reset-password.js <username> [--enable]'); process.exit(1); }
if (args[1]) console.warn('⚠️  รหัสผ่านที่ใส่ใน command line มองเห็นได้จาก ps — แนะนำใช้ตัวแปรแวดล้อม DOCFLOW_PASSWORD');
run(async ctx => {
  const u = await ctx.one('SELECT * FROM users WHERE lower(username) = $1', [username.toLowerCase()]);
  if (!u) throw new Error('ไม่พบผู้ใช้ ' + username);
  checkPw(password, u.username);
  const salt = newSalt();
  const upd = { salt, passwordHash: hashPw(password, salt), sessionId: require('crypto').randomBytes(8).toString('hex') };   // session เดิมตายทั้งหมด (กัน token เก่าที่อาจรั่ว)
  if (flags.includes('--enable')) upd.status = 'active';
  await ctx.update('users', u.id, upd);
  await ctx.log('USER:' + u.id, 'PASSWORD_RESET', 'โดย CLI reset-password: ' + u.username + (upd.status ? ' (ปลดล็อกบัญชี)' : ''));
  return 'รีเซ็ตรหัสผ่านของ ' + u.username + ' แล้ว (บัญชีอื่นที่ล็อกอินด้วย user นี้ถูกบังคับออกทุกคน)';
});
