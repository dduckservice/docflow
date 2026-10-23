// รีเซ็ตรหัสผ่าน (แทน adminResetPassword เดิม): node scripts/reset-password.js <username> <รหัสผ่านใหม่>
const run = require('./_ctx');
const { hashPw, newSalt, checkPw } = require('../src/platform');
const [username, password] = process.argv.slice(2);
if (!username || !password) { console.log('ใช้: node scripts/reset-password.js <username> <รหัสผ่านใหม่>'); process.exit(1); }
run(async ctx => {
  const u = await ctx.one('SELECT * FROM users WHERE lower(username) = $1', [username.toLowerCase()]);
  if (!u) throw new Error('ไม่พบผู้ใช้ ' + username);
  checkPw(password, u.username);
  const salt = newSalt();
  await ctx.update('users', u.id, { salt, passwordHash: hashPw(password, salt), status: 'active' });
  return 'รีเซ็ตรหัสผ่านของ ' + u.username + ' แล้ว';
});
