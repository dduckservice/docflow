// ตั้ง Super Admin (แทน setSuperAdmin เดิม): node scripts/set-super.js <username>
const run = require('./_ctx');
const [username] = process.argv.slice(2);
if (!username) { console.log('ใช้: node scripts/set-super.js <username>'); process.exit(1); }
run(async ctx => {
  const u = await ctx.one('SELECT * FROM users WHERE lower(username) = $1', [username.toLowerCase()]);
  if (!u) throw new Error('ไม่พบผู้ใช้ ' + username);
  if (u.role !== 'admin' || u.status !== 'active') throw new Error('Super Admin ต้องเป็นผู้ดูแลระบบที่ใช้งานอยู่');
  await ctx.exec('UPDATE users SET is_super = (id = $1)', [u.id]);
  return 'ตั้ง ' + u.username + ' เป็น Super Admin แล้ว';
});
