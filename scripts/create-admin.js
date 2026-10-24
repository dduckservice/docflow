// สร้างผู้ดูแลระบบ (Super Admin) จาก command line
// วิธีใช้:  DOCFLOW_PASSWORD='รหัสผ่าน' node scripts/create-admin.js <username> [password] [ชื่อที่แสดง]
// แนะนำส่งรหัสผ่านผ่านตัวแปรแวดล้อม DOCFLOW_PASSWORD เพื่อไม่ให้ปรากฏใน ps / shell history (Security Review L9)
const run = require('./_ctx');
const { createFirstAdmin, hashPw, newSalt, checkPw } = require('../src/platform');
const { uuid } = require('../src/util');
const [username, pwArg, name] = process.argv.slice(2);
const password = pwArg || process.env.DOCFLOW_PASSWORD;
if (!username || !password) { console.log('ใช้: DOCFLOW_PASSWORD=<รหัสผ่าน> node scripts/create-admin.js <username> [password] [ชื่อที่แสดง]'); process.exit(1); }
if (pwArg) console.warn('⚠️  รหัสผ่านที่ใส่ใน command line มองเห็นได้จาก ps — แนะนำใช้ตัวแปรแวดล้อม DOCFLOW_PASSWORD');
run(async ctx => {
  if (!(await ctx.one('SELECT id FROM users LIMIT 1'))) { const s = await createFirstAdmin(ctx, username, password, name || username, process.env.BOOTSTRAP_ADMIN_KEY || ''); return 'สร้าง Super Admin "' + s.user.username + '" แล้ว'; }
  const u = username.toLowerCase(); checkPw(password, u);
  if (await ctx.one('SELECT id FROM users WHERE lower(username) = $1', [u])) throw new Error('ชื่อผู้ใช้นี้มีอยู่แล้ว');
  const salt = newSalt();
  await ctx.insert('users', { id: uuid(), username: u, displayName: name || u, passwordHash: hashPw(password, salt), salt, role: 'admin', tenantIds: '*', status: 'active', createdAt: new Date() });
  return 'สร้างผู้ดูแลระบบ "' + u + '" แล้ว';
});
