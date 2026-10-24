// ============================================================
//  platform.js — ผู้ใช้/ล็อกอิน, หลายบริษัท, License (เดิม: Platfrom.gs)
// ============================================================
const crypto = require('crypto');
const { uuid, fail, clean, todayStr, ymdParse, daysBetween, addMonths, dayShift, thDate, safeFolderName, localeTh } = require('./util');
const { getSetting, setSetting } = require('./db');
const storage = require('./storage');
const { sendMail } = require('./mail');

const ROLES = ['admin', 'audit', 'staff', 'viewer'];
const ROLE_RANK = { viewer: 1, staff: 2, audit: 3, admin: 4 };
const HASH_ROUNDS = 400, HASH_ROUNDS_V2 = 3000, HASH_V2_PREFIX = 'v2$';
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const LOGIN_MAX_FAIL = 5, LOGIN_LOCK_SEC = 600;
const EXPENSE_CATEGORIES = ['ค่าเช่า', 'ค่าน้ำ/ค่าไฟ', 'ค่าโทรศัพท์/อินเทอร์เน็ต', 'เงินเดือน/ค่าแรง', 'ค่าวัตถุดิบ/สินค้า', 'ค่าขนส่ง',
  'ค่าโฆษณา/การตลาด', 'ค่าซ่อมบำรุง', 'ค่าบริการวิชาชีพ', 'ค่าเดินทาง', 'วัสดุสำนักงาน', 'ภาษี/ค่าธรรมเนียม', 'อื่นๆ'];

// ---------- ตัวนับล็อกอินผิด (ในหน่วยความจำ: ต่อ IP · ในฐานข้อมูล: ต่อชื่อผู้ใช้ ทนการรีสตาร์ท/การแจก IP) ----------
const LOGIN_ACCOUNT_MAX_FAIL = Number(process.env.LOGIN_ACCOUNT_MAX_FAIL || 20);   // ต่อ 15 นาที ต่อ 1 ชื่อผู้ใช้/อีเมล (นับรวมทุก IP)
const FAILS = new Map();
function failCount(k) { const v = FAILS.get(k); if (!v || v.exp < Date.now()) { FAILS.delete(k); return 0; } return v.n; }
function failAdd(k) { FAILS.set(k, { n: failCount(k) + 1, exp: Date.now() + LOGIN_LOCK_SEC * 1000 }); }
// ล้างรายการที่หมดเวลาแล้ว (กันหน่วยความจำโตเมื่อถูกยิงด้วยชื่อผู้ใช้สุ่ม)
setInterval(() => { const now = Date.now(); for (const [k, v] of FAILS) if (v.exp < now) FAILS.delete(k); }, 300e3).unref();
const IP_MAX_FAIL = Number(process.env.LOGIN_IP_MAX_FAIL || 50);

// ---------- รหัสผ่าน (อัลกอริทึมเดียวกับระบบเดิม ย้ายแฮชเดิมมาใช้ต่อได้) ----------
function hashRounds(pw, salt, rounds) {
  const sb = Buffer.from(String(salt), 'utf8');
  let h = Buffer.from(salt + '|' + pw, 'utf8');
  for (let i = 0; i < rounds; i++) h = crypto.createHash('sha256').update(Buffer.concat([h, sb])).digest();
  return h.toString('hex');
}
// รุ่นปัจจุบัน: scrypt (ทนการเดารหัสด้วยการ์ดจอได้ดีกว่า SHA-256 วนรอบมาก) · แฮชรุ่นเก่ายังตรวจได้ และอัปเกรดให้เองตอนล็อกอิน
const HASH_V3_PREFIX = 'v3$';
const scryptHex = (pw, salt) => crypto.scryptSync(String(pw), 'docflow|' + String(salt), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
const hashPw = (pw, salt) => HASH_V3_PREFIX + scryptHex(pw, salt);
function safeEq(a, b) { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); }
function verifyPw(pw, u) {
  const h = String(u.passwordHash || ''), salt = String(u.salt);
  if (h.indexOf(HASH_V3_PREFIX) === 0) return safeEq(hashPw(pw, salt), h);
  return h.indexOf(HASH_V2_PREFIX) === 0 ? safeEq(HASH_V2_PREFIX + hashRounds(pw, salt, HASH_ROUNDS_V2), h) : safeEq(hashRounds(pw, salt, HASH_ROUNDS), h);
}
const newSalt = () => crypto.randomBytes(16).toString('hex');
const newSid = () => crypto.randomBytes(8).toString('hex');
// ค่าปลอมสำหรับ "soak" เวลาไม่พบบัญชี — ให้เวลาตรวจรหัสใกล้เคียงกัน (กัน account-enumeration จากช่วงเวลาที่วัดได้)
const DUMMY_SALT = '00000000000000000000000000000000';
const DUMMY_HASH = hashPw('docflow-timing-soak', DUMMY_SALT);
function checkPw(pw, username) {
  pw = String(pw || '');
  if (pw.length < 8) fail('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (pw.length > 100) fail('รหัสผ่านยาวเกินไป');
  if (username && pw.toLowerCase() === String(username).toLowerCase()) fail('รหัสผ่านต้องไม่ตรงกับชื่อผู้ใช้');
}

// ---------- token ----------
// ความปลอดภัย (Security Review 2.1): คีย์เซ็น Session Token ต้องอยู่จากไฟล์ .env เท่านั้น
// ไม่สร้าง/เก็บสำเนาในตาราง app_settings อีกต่อไป (ค่าที่เคยเก็บไว้ใน DB หลุดไปกับไฟล์สำรองไม่ได้แล้ว)
// เดิม: TOKEN_SECRET ว่าง → สุ่มแล้วเก็บในฐานข้อมูล
let SECRET = process.env.TOKEN_SECRET || '';
let SECRET_ROW_PURGED = false;
async function initSecret(ctx) {
  if (!SECRET) throw new Error('TOKEN_SECRET ยังไม่ได้ตั้งค่าในไฟล์ .env — สร้างค่าด้วย: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))" แล้วรีสตาร์ท (ดู README หัวข้อ ความปลอดภัย)');
  if (!SECRET_ROW_PURGED) {   // ล้างสำเนาเก่า (ถ้ามี) ที่เคยถูกเก็บใน DB → ไม่อยู่ในไฟล์สำรองอีก
    SECRET_ROW_PURGED = true;
    await ctx.exec("DELETE FROM app_settings WHERE key = 'TOKEN_SECRET'");
  }
}
const sign = p => crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
function makeToken(u) {
  const p = String(u.id) + '|' + (Date.now() + SESSION_HOURS * 3600 * 1000) + '|' + String(u.sessionId || '');
  return Buffer.from(p).toString('base64url') + '.' + sign(p);
}
// คืน { user } หรือ { why: 'expired' | 'replaced' }
async function authUser(ctx, token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return { why: 'expired' };
    const p = Buffer.from(parts[0], 'base64url').toString();
    if (!safeEq(parts[1], sign(p))) return { why: 'expired' };
    const f = p.split('|');
    const uid = f[0], exp = f[1];
    const legacyHp = f.length >= 4 ? f[2] : '';   // รองรับ token รูปแบบเก่า (มี 10 ตัวแรกของ password hash) จนกว่าจะหมดอายุ
    const sid = f[f.length - 1];
    if (Date.now() > Number(exp)) return { why: 'expired' };
    const u = await ctx.one("SELECT * FROM users WHERE id = $1 AND status = 'active'", [uid]);
    if (!u || (legacyHp && String(u.passwordHash).slice(0, 10) !== legacyHp)) return { why: 'expired' };
    if (String(u.sessionId || '') !== String(sid || '')) return { why: 'replaced' };
    return { user: u };
  } catch (e) { return { why: 'expired' }; }
}
// ออกจากระบบจากฝั่งผู้ใช้: สุ่ม session_id ใหม่ → token เดิมใช้ไม่ได้ทันที (ทั้งเครื่องนั้นถูกบังคับล็อกอินใหม่)
async function logout(ctx) {
  await ctx.exec('UPDATE users SET session_id = $1 WHERE id = $2', [newSid(), ctx.user.id]);
  await ctx.log('USER:' + ctx.user.id, 'LOGOUT', String(ctx.user.username));
  return { success: true };
}
// ---------- ตั๋วผ่านประตูสำหรับ SSE (EventSource ส่ง header ไม่ได้ จึงไม่ให้ใส่ token ใน URL) ----------
// client เรียก chat.streamTicket (ผ่าน API ปกติที่มี Bearer) → ได้ลิงก์ /api/chat/stream?t=... ใช้ได้ครั้งเดียว อายุสั้น
const STREAM_TICKETS = new Map();   // t → { uid, exp }
function issueStreamTicket(userId) {
  const t = crypto.randomBytes(18).toString('hex');
  STREAM_TICKETS.set(t, { uid: String(userId), exp: Date.now() + 15000 });
  const now = Date.now(); for (const [k, v] of STREAM_TICKETS) if (v.exp < now) STREAM_TICKETS.delete(k);
  return 'api/chat/stream?t=' + t;
}
function takeStreamTicket(t) {
  const v = STREAM_TICKETS.get(String(t)); STREAM_TICKETS.delete(String(t));
  return v && v.exp > Date.now() ? v : null;
}
async function streamTicket(ctx) { return { url: issueStreamTicket(ctx.user.id) }; }

// ---------- Super Admin ----------
// มีผู้ใช้ is_super = true → ใช้ตามนั้น ; ไม่พบเลย = fail-closed (ไม่ยกระดับ admin ธรรมดาเป็น Super อัตโนมัติ)
// การ bootstrap Super คนแรกต้องทำผ่านหน้า createFirstAdmin หรือ scripts/create-admin.js เท่านั้น
async function superIds(ctx) {
  if (ctx._super) return ctx._super;
  const set = new Set((await ctx.all('SELECT id FROM users WHERE is_super')).map(r => String(r.id)));
  return (ctx._super = set);
}
async function isSuper(ctx, u) { return !!u && (await superIds(ctx)).has(String(u.id)); }
async function superOnly(ctx) { if (!(await isSuper(ctx, ctx.user))) fail('เฉพาะ Super Admin เท่านั้น'); }

// ---------- License ----------
const LIC_PLANS = ['monthly', 'yearly', 'custom', 'none'];
const LIC_SOON_DAYS = 30, LIC_MARKS = [30, 14, 7, 3, 1, 0];
function licExpireFor(start, plan) {
  if (plan === 'monthly') return dayShift(addMonths(start, 1), -1);
  if (plan === 'yearly') return dayShift(addMonths(start, 12), -1);
  return '';
}
function licenseOf(u, sup) {
  const plan = String(u.licensePlan || '');
  const o = { plan: plan || 'none', start: String(u.licenseStart || ''), expire: String(u.licenseExpire || ''), note: String(u.licenseNote || ''), daysLeft: null, state: 'none' };
  if (sup || !plan || plan === 'none' || !ymdParse(o.expire)) return o;
  o.daysLeft = daysBetween(todayStr(), o.expire);
  o.state = o.daysLeft < 0 ? 'expired' : (o.daysLeft <= LIC_SOON_DAYS ? 'soon' : 'active');
  return o;
}
const licMsg = l => /ทดลองใช้/.test(l.note) ? 'ช่วงทดลองใช้งานฟรีของบัญชีนี้สิ้นสุดเมื่อ ' + thDate(l.expire) + ' กรุณาติดต่อเจ้าหน้าที่เพื่อเปิดใช้งานต่อ'
  : 'ใบอนุญาตใช้งานของบัญชีนี้หมดอายุเมื่อ ' + thDate(l.expire) + ' กรุณาติดต่อผู้ดูแลระบบ (Super Admin) เพื่อต่ออายุ';
function licenseRow(u, sup) {
  const l = licenseOf(u, sup);
  return { userId: String(u.id), username: String(u.username), displayName: String(u.displayName || ''), email: String(u.email || ''), role: String(u.role), status: String(u.status),
    isSuper: !!sup, licenseKey: String(u.licenseKey || ''), plan: l.plan, start: l.start, expire: l.expire, note: l.note, daysLeft: l.daysLeft, state: sup ? 'super' : l.state };
}
async function licenseAlerts(ctx) {
  const sup = await superIds(ctx);
  return (await ctx.all("SELECT * FROM users WHERE status = 'active'")).map(u => licenseRow(u, sup.has(String(u.id))))
    .filter(r => r.state === 'soon' || r.state === 'expired').sort((a, b) => a.daysLeft - b.daysLeft);
}
async function contactInfo(ctx) {
  const sup = await superIds(ctx);
  const admins = (await ctx.all("SELECT * FROM users WHERE status = 'active'")).filter(u => sup.has(String(u.id)))
    .map(u => ({ name: String(u.displayName || u.username), email: String(u.email || '') }));
  return { text: await getSetting(ctx, 'CONTACT_INFO'), admins };
}

// ---------- บริษัท ----------
async function tenantsList(ctx) { return ctx.all("SELECT * FROM tenants WHERE status <> 'disabled' ORDER BY created_at, company_name"); }
async function allowedTenants(ctx, u) {
  const all = (await tenantsList(ctx)).map(t => ({ id: String(t.id), name: String(t.companyName) }));
  if (String(u.tenantIds).trim() === '*') return all;
  const ids = String(u.tenantIds || '').split(',').map(s => s.trim()).filter(Boolean);
  return all.filter(t => ids.includes(t.id));
}
// เตรียมข้อมูลตั้งต้นของบริษัท (เดิม: setupDatabase_) — โปรไฟล์บริษัท + หมวดค่าใช้จ่ายเริ่มต้น
const READY = new Set();
async function ensureTenant(ctx, tenantId) {
  if (READY.has(tenantId)) return;
  const t = await ctx.one('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (!t) fail('ไม่พบบริษัท');
  let created = false;
  if (!(await ctx.one('SELECT id FROM company_profiles WHERE tenant_id = $1', [tenantId]))) {
    await ctx.insert('company_profiles', { tenantId, companyName: t.companyName, vatRegistered: 'yes', createdAt: new Date(), updatedAt: new Date() }); created = true;
  }
  if (!(await ctx.one('SELECT id FROM expense_categories WHERE tenant_id = $1 LIMIT 1', [tenantId]))) {
    let i = 0; for (const n of EXPENSE_CATEGORIES) await ctx.insert('expense_categories', { tenantId, name: n, sort: ++i, status: 'active', createdAt: new Date() });
    created = true;
  }
  if (!created) READY.add(tenantId);   // จำไว้เฉพาะเมื่อข้อมูลมีอยู่แล้วจริง (กรณีเพิ่งสร้าง transaction อาจยังถูกยกเลิกได้)
}
async function setTenant(ctx, tenantId) {
  const t = (await allowedTenants(ctx, ctx.user)).find(x => x.id === String(tenantId));
  if (!t) fail('ไม่มีสิทธิ์เข้าถึงบริษัทนี้');
  ctx.tenantId = t.id;
  await ensureTenant(ctx, t.id);
}
async function sessionInfo(ctx, u, token) {
  const sup = await isSuper(ctx, u);
  return {
    token: token || '',
    user: { id: String(u.id), username: String(u.username), displayName: String(u.displayName || u.username), role: String(u.role), email: String(u.email || ''), avatar: avatarUrl(u) },
    contact: await contactInfo(ctx), isSuper: sup, license: licenseOf(u, sup), alerts: sup ? await licenseAlerts(ctx) : [],
    expiredMsg: licenseOf(u, sup).state === 'expired' ? licMsg(licenseOf(u, sup)) : '',
    tenants: await allowedTenants(ctx, u)
  };
}
async function syncTenantName(ctx, name) { await ctx.exec('UPDATE tenants SET company_name = $1 WHERE id = $2', [name, ctx.tenantId]); }

// ---------- ฟังก์ชันสาธารณะ (ไม่ต้องล็อกอิน) ----------
// ค่าเริ่มต้นจาก .env (อ่านสด) · ค่าจริงเก็บใน app_settings (Super Admin แก้ได้ · ถ้ายังไม่เคยตั้ง = ใช้ค่า .env)
// ความปลอดภัย: ค่าเริ่มต้น "ปิด" สมัครเอง — ต้องตั้ง ALLOW_SIGNUP=on ใน .env หรือเปิดจากหน้า Super Admin เท่า่นั้น (fail-closed)
const signupOnEnv = () => /^(1|true|on|yes)$/i.test(process.env.ALLOW_SIGNUP || '');
const trialDaysEnv = () => Math.max(1, Number(process.env.TRIAL_DAYS || 7));
const quotaDefEnv = () => Math.max(1, Number(process.env.SIGNUP_USER_QUOTA || 1));
const coQuotaDefEnv = () => Math.max(1, Number(process.env.SIGNUP_COMPANY_QUOTA || 1));
async function signupConfig(ctx) {
  const d = await getSetting(ctx, 'SIGNUP_TRIAL_DAYS'), on = await getSetting(ctx, 'SIGNUP_ALLOW'), q = await getSetting(ctx, 'SIGNUP_USER_QUOTA'), cq = await getSetting(ctx, 'SIGNUP_COMPANY_QUOTA');
  return { days: d ? Math.max(1, Math.min(3650, Number(d) || trialDaysEnv())) : trialDaysEnv(),
    on: on != null && on !== '' ? on === '1' : signupOnEnv(),
    quota: q ? Math.max(1, Math.min(9999, Number(q) || quotaDefEnv())) : quotaDefEnv(),
    companyQuota: cq ? Math.max(1, Math.min(9999, Number(cq) || coQuotaDefEnv())) : coQuotaDefEnv() };
}
// จำนวนผู้ใช้สูงสุดที่ "ผู้สร้าง" คนนี้สร้างได้ (Super = ไม่จำกัด) · และจำนวนที่สร้างไปแล้ว
async function createLimitOf(ctx, creator) {
  if (await isSuper(ctx, creator)) return Infinity;
  const q = creator.userQuota;
  if (q === -1) return Infinity;
  if (q != null && Number(q) > 0) return Number(q);
  return (await signupConfig(ctx)).quota;
}
// จำนวนบริษัทสูงสุดที่ "เจ้าของบัญชี" คนนี้สร้างได้
async function companyLimitOf(ctx, owner) {
  if (await isSuper(ctx, owner)) return Infinity;
  const q = owner.companyQuota;
  if (q === -1) return Infinity;
  if (q != null && Number(q) > 0) return Number(q);
  return (await signupConfig(ctx)).companyQuota;
}
const createdCount = (ctx, uid) => ctx.one('SELECT count(*)::int AS n FROM users WHERE created_by = $1', [uid]).then(r => r.n);
const companyCount = (ctx, uid) => ctx.one('SELECT count(*)::int AS n FROM tenants WHERE created_by = $1', [uid]).then(r => r.n);
async function authStatus(ctx) { const needsSetup = !(await ctx.one('SELECT id FROM users LIMIT 1')); const cfg = await signupConfig(ctx); return { needsSetup, setupKeyRequired: needsSetup && !!process.env.BOOTSTRAP_ADMIN_KEY, allowSignup: !needsSetup && cfg.on, trialDays: cfg.days }; }
// ข้อความติดต่อเจ้าหน้าที่ (แสดงตอนล็อกอินไม่ได้เพราะหมดอายุ)
async function contactLine(ctx) { const c = await contactInfo(ctx); const t = c.text || c.admins.filter(a => a.email).map(a => a.name + ' ' + a.email).join(', '); return t ? '\nติดต่อเจ้าหน้าที่: ' + t : ''; }

// ---------- สมัครใช้งานฟรี (ทดลองใช้ TRIAL_DAYS วัน) ----------
// อีเมล = ชื่อผู้ใช้ · ได้สิทธิ์ "ผู้ตรวจสอบ (Admin Audit)" + บริษัทของตัวเอง 1 บริษัท (เพิ่มบริษัท/ผู้ใช้ของตัวเองได้ ไม่เห็นของคนอื่น)
async function signup(ctx, email, phone, password) {
  const cfg = await signupConfig(ctx);
  if (!cfg.on) fail('ขณะนี้ปิดรับสมัครใช้งาน กรุณาติดต่อเจ้าหน้าที่');
  const TRIAL = cfg.days;
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('รูปแบบอีเมลไม่ถูกต้อง');
  if (!/^[a-z0-9._@-]{3,50}$/.test(email)) fail('อีเมลใช้ได้เฉพาะ a-z 0-9 . _ - และยาวไม่เกิน 50 ตัวอักษร');
  phone = String(phone || '').replace(/[\s-]/g, '');
  if (!/^0\d{8,9}$/.test(phone)) fail('กรุณากรอกเบอร์โทรศัพท์ 9-10 หลัก ขึ้นต้นด้วย 0');
  checkPw(password, email);
  await ctx.lock('registry');
  if (!(await ctx.one('SELECT id FROM users LIMIT 1'))) fail('ระบบยังไม่ได้ตั้งค่าผู้ดูแลคนแรก');
  if (await ctx.one('SELECT id FROM users WHERE lower(username) = $1 OR lower(email) = $1', [email])) fail('อีเมลนี้สมัครใช้งานแล้ว กรุณาเข้าสู่ระบบ');
  const t = await createTenantRaw(ctx, 'บริษัทของ ' + email.split('@')[0]);
  const salt = newSalt(), start = todayStr(), sid = newSid();
  const u = { id: uuid(), username: email, displayName: email.split('@')[0], email, phone, role: 'audit', tenantIds: t.id, status: 'active',
    salt, passwordHash: hashPw(String(password), salt), licensePlan: 'custom', licenseStart: start, licenseExpire: dayShift(start, TRIAL - 1),
    licenseNote: 'ทดลองใช้ฟรี ' + TRIAL + ' วัน (สมัครเอง)', sessionId: sid, createdAt: new Date(), signupAt: new Date(), lastLogin: new Date() };
  await ctx.insert('users', u);
  await ctx.exec('UPDATE tenants SET created_by = $1 WHERE id = $2', [u.id, t.id]);
  await logEvent(ctx, u, true, 'signup');
  await ctx.log('USER:' + u.id, 'SIGNUP', email + ' / ' + phone);
  // แจ้ง Super Admin ทางอีเมล (ถ้าตั้งค่า SMTP ไว้)
  const sup = await superIds(ctx);
  const supers = (await ctx.all("SELECT * FROM users WHERE status = 'active'")).filter(x => sup.has(String(x.id)) && x.email);
  for (const s of supers) sendMail(String(s.email), '[DocFlow] มีผู้สมัครทดลองใช้ใหม่: ' + email, 'อีเมล: ' + email + '\nโทร: ' + phone + '\nทดลองใช้ถึง: ' + thDate(u.licenseExpire) + '\n').catch(() => {});
  return sessionInfo(ctx, u, makeToken(u));
}

async function logEvent(ctx, u, ok, note) {
  const m = ctx.meta || {};
  await ctx.exec('INSERT INTO login_events (user_id, username, ok, ip, agent, note) VALUES ($1,$2,$3,$4,$5,$6)', [u.id, String(u.username), ok, String(m.ip || '').slice(0, 80) || null, String(m.agent || '').slice(0, 300) || null, note]);
  await ctx.exec('UPDATE users SET last_seen = now(), last_ip = COALESCE($2, last_ip), last_agent = COALESCE($3, last_agent) WHERE id = $1', [u.id, String(m.ip || '').slice(0, 80) || null, String(m.agent || '').slice(0, 300) || null]);
}
// หาผู้ใช้จากชื่อผู้ใช้ หรืออีเมล (ชื่อผู้ใช้ตรงกันก่อน · อีเมลที่ผูกกับหลายบัญชี = ไม่ยอมเดา)
async function findLoginUser(ctx, name, extra) {
  const u = await ctx.one('SELECT * FROM users WHERE lower(username) = $1' + (extra || ''), [name]);
  if (u) return u;
  const l = await ctx.all("SELECT * FROM users WHERE lower(email) = $1 AND email <> ''" + (extra || '') + ' LIMIT 2', [name]);
  if (l.length > 1) fail('อีเมลนี้ผูกกับหลายบัญชี กรุณาเข้าสู่ระบบด้วยชื่อผู้ใช้');
  return l[0] || null;
}
async function login(ctx, username, password) {
  username = String(username || '').trim().toLowerCase().slice(0, 100);
  // (1) นับรหัสผิดต่อ (IP + ชื่อผู้ใช้) และต่อ IP — คนอื่นจึงล็อกบัญชีของเราจากเครื่องของเขาไม่ได้
  const ip = String((ctx.meta && ctx.meta.ip) || '-'), fk = 'fail_' + ip + '|' + username, ik = 'ipfail_' + ip;
  if (failCount(fk) >= LOGIN_MAX_FAIL || failCount(ik) >= IP_MAX_FAIL) fail('ใส่รหัสผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่');
  // (2) นับต่อ "บัญชี" จาก login_events (ข้ามทุก IP + ทนการรีสตาร์ท) — กัน distributed password spraying
  const recentFail = await ctx.one("SELECT count(*)::int AS n FROM login_events WHERE ok = false AND at > now() - interval '15 minutes' AND lower(username) = $1", [username]);
  if (recentFail && recentFail.n >= LOGIN_ACCOUNT_MAX_FAIL) fail('มีการพยายามเข้าสู่ระบบบัญชีนี้ผิดพลาดหลายครั้งจากหลายแหล่ง กรุณารอสักครู่แล้วลองใหม่ หรือเปลี่ยนรหัสผ่านผ่านผู้ดูแลระบบ');
  const u = await findLoginUser(ctx, username);
  const ok = !!u && u.status === 'active' && verifyPw(String(password || ''), u);
  if (!u) verifyPw(String(password || ''), { salt: DUMMY_SALT, passwordHash: DUMMY_HASH });   // soak เวลาให้ใกล้เคียงกรณีพบบัญชี
  if (!ok) { failAdd(fk); failAdd(ik); fail('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้องหรือยังไม่อนุมัติ'); }
  FAILS.delete(fk);
  const lic = licenseOf(u, await isSuper(ctx, u));
  // License หมดอายุ: ยังเข้าสู่ระบบได้ แต่ใช้ได้เฉพาะแชทติดต่อเจ้าหน้าที่ / กรอก License Key (ตรวจที่ api.js)
  const sid = newSid();
  let pwHash = String(u.passwordHash);
  if (pwHash.indexOf(HASH_V3_PREFIX) !== 0) pwHash = hashPw(String(password || ''), String(u.salt));   // อัปเกรดแฮชรุ่นเก่าเป็น scrypt
  await ctx.exec('UPDATE users SET last_login = now(), session_id = $1, password_hash = $2 WHERE id = $3', [sid, pwHash, u.id]);   // ผู้ที่ล็อกอินไว้ก่อนหน้าจะถูกเด้งออก
  await logEvent(ctx, u, true, lic.state === 'expired' ? 'login (หมดอายุ)' : 'login');
  const u2 = Object.assign({}, u, { sessionId: sid, passwordHash: pwHash });
  return sessionInfo(ctx, u2, makeToken(u2));
}

async function createFirstAdmin(ctx, username, password, displayName, bootstrapKey) {
  await ctx.lock('registry');
  if (await ctx.one('SELECT id FROM users LIMIT 1')) fail('ระบบมีผู้ใช้แล้ว ไม่สามารถสร้างผู้ดูแลคนแรกได้');
  // สำหรับเครื่องที่เปิดสู่อินเทอร์เน็ต: ตั้ง BOOTSTRAP_ADMIN_KEY ใน .env เพื่อบังคับกรอกรหัสยืนยันตรงกันก่อนสร้าง Super คนแรก
  // (หรือข้ามหน้าเว็บทั้งหมด ด้วย CLI: node scripts/create-admin.js) — ค่าสุด = ไม่บังคับ (ค่าเริ่มต้นสำหรับการติดตั้งในเครื่อง)
  const bootKey = String(process.env.BOOTSTRAP_ADMIN_KEY || '');
  if (bootKey && !safeEq(String(bootstrapKey || ''), bootKey)) fail('รหัสยืนยันการตั้งค่าไม่ถูกต้อง (BOOTSTRAP_ADMIN_KEY จากไฟล์ .env ของเซิร์ฟเวอร์)');
  username = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._@-]{3,50}$/.test(username)) fail('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ @ - ความยาว 3-50 ตัวอักษร');
  checkPw(password, username);
  if (!(await ctx.one('SELECT id FROM tenants LIMIT 1'))) await createTenantRaw(ctx, 'บริษัทหลัก');
  const salt = newSalt();
  const rec = { id: uuid(), username, displayName: clean(displayName, 100) || username, passwordHash: hashPw(String(password), salt), salt, role: 'admin', tenantIds: '*',
    status: 'active', isSuper: true, sessionId: newSid(), createdAt: new Date(), lastLogin: new Date() };
  await ctx.insert('users', rec);
  ctx._super = null;
  return sessionInfo(ctx, rec, makeToken(rec));
}

async function getSession(ctx) { return sessionInfo(ctx, ctx.user, ''); }

async function changeMyPassword(ctx, oldPw, newPw) {
  const u = ctx.user;
  const fk = 'pwchange_' + String(u.id);
  if (failCount(fk) >= LOGIN_MAX_FAIL) fail('ใส่รหัสเดิมผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่');
  if (!verifyPw(String(oldPw || ''), u)) { failAdd(fk); fail('รหัสผ่านเดิมไม่ถูกต้อง'); }
  FAILS.delete(fk);
  checkPw(newPw, u.username);
  const salt = newSalt(), sid = newSid();   // เปลี่ยน session_id ด้วย → token เดิม (ของคนอื่นที่อาจถูกขโมย) ตายทุกตัว; เครื่องนี้ได้ token ใหม่คืนกลับไปทันที
  const next = Object.assign({}, u, { salt, passwordHash: hashPw(String(newPw), salt), sessionId: sid });
  await ctx.update('users', u.id, { salt, passwordHash: next.passwordHash, sessionId: sid });
  await ctx.log('USER:' + u.id, 'PASSWORD_CHANGE', String(u.username));
  return { success: true, token: makeToken(next) };
}

// ---------- License: จัดการโดย Super Admin ----------
async function listLicenses(ctx) {
  await superOnly(ctx);
  const sup = await superIds(ctx);
  const rows = (await ctx.all('SELECT * FROM users ORDER BY created_at, username')).map(u => licenseRow(u, sup.has(String(u.id))));
  const c = { total: rows.length, active: 0, soon: 0, expired: 0, none: 0 };
  rows.forEach(r => { if (r.state === 'active') c.active++; else if (r.state === 'soon') c.soon++; else if (r.state === 'expired') c.expired++; else c.none++; });
  const cfg = await signupConfig(ctx);
  return { rows, counts: c, today: todayStr(), contactText: await getSetting(ctx, 'CONTACT_INFO'), signup: { allow: cfg.on, trialDays: cfg.days, envDays: trialDaysEnv() } };
}
async function saveSignupSettings(ctx, input) {
  await superOnly(ctx);
  input = input || {};
  if (input.allow !== undefined) await setSetting(ctx, 'SIGNUP_ALLOW', input.allow ? '1' : '0');
  if (input.trialDays !== undefined) {
    const d = Math.floor(Number(input.trialDays));
    if (!Number.isFinite(d) || d < 1 || d > 3650) fail('จำนวนวันทดลองใช้ต้องอยู่ระหว่าง 1 ถึง 3650 วัน');
    await setSetting(ctx, 'SIGNUP_TRIAL_DAYS', String(d));
  }
  if (input.userQuota !== undefined) {
    const q = Math.floor(Number(input.userQuota));
    if (!Number.isFinite(q) || q < 1 || q > 9999) fail('โควตาผู้ใช้ต้องอยู่ระหว่าง 1 ถึง 9999');
    await setSetting(ctx, 'SIGNUP_USER_QUOTA', String(q));
  }
  if (input.companyQuota !== undefined) {
    const q = Math.floor(Number(input.companyQuota));
    if (!Number.isFinite(q) || q < 1 || q > 9999) fail('โควตาบริษัทต้องอยู่ระหว่าง 1 ถึง 9999');
    await setSetting(ctx, 'SIGNUP_COMPANY_QUOTA', String(q));
  }
  return await signupConfig(ctx);
}
async function saveContactInfo(ctx, text) { await superOnly(ctx); await setSetting(ctx, 'CONTACT_INFO', clean(text, 500)); return { success: true }; }

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genKey(plan) {
  const pre = plan === 'yearly' ? 'DFY' : (plan === 'monthly' ? 'DFM' : 'DFC');
  const b = crypto.randomBytes(15); let g = '';
  for (let i = 0; i < 15; i++) g += KEY_ALPHABET[b[i] % KEY_ALPHABET.length];
  return pre + '-' + g.slice(0, 5) + '-' + g.slice(5, 10) + '-' + g.slice(10, 15);
}
async function uniqueKey(ctx, plan) {
  for (let n = 0; n < 20; n++) { const k = genKey(plan); if (!(await ctx.one('SELECT 1 FROM license_keys WHERE license_key = $1', [k]))) return k; }
  fail('สร้าง License Key ไม่สำเร็จ กรุณาลองใหม่');
}
const keyMonths = plan => (plan === 'yearly' ? 12 : 1);
async function userById(ctx, id) { const u = await ctx.one('SELECT * FROM users WHERE id::text = $1', [String(id || '')]); if (!u) fail('ไม่พบผู้ใช้'); return u; }

async function saveLicense(ctx, input) {
  await superOnly(ctx); input = input || {};
  await ctx.lock('registry');
  const u = await userById(ctx, input.userId);
  if (await isSuper(ctx, u)) fail('Super Admin ไม่มีวันหมดอายุ ไม่ต้องกำหนด License');
  const plan = LIC_PLANS.includes(String(input.plan)) ? String(input.plan) : 'none';
  const rec = {};
  if (plan === 'none') { rec.licensePlan = ''; rec.licenseStart = ''; rec.licenseExpire = ''; }
  else {
    const start = ymdParse(input.start) ? String(input.start).slice(0, 10) : todayStr();
    let expire = String(input.expire || '').slice(0, 10);
    if (plan !== 'custom' || !expire) expire = licExpireFor(start, plan === 'custom' ? 'monthly' : plan);
    if (!ymdParse(expire)) fail('วันหมดอายุไม่ถูกต้อง');
    if (daysBetween(start, expire) < 0) fail('วันหมดอายุต้องไม่ก่อนวันเริ่มต้น');
    Object.assign(rec, { licensePlan: plan, licenseStart: start, licenseExpire: expire });
    const same = String(u.licensePlan) === plan && String(u.licenseStart) === start && String(u.licenseExpire) === expire && u.licenseKey;
    if (!same) {   // กำหนด/เปลี่ยนแผน → ออก License Key ใหม่อัตโนมัติ
      rec.licenseKey = await uniqueKey(ctx, plan);
      await ctx.insert('license_keys', { licenseKey: rec.licenseKey, plan, months: plan === 'yearly' ? 12 : (plan === 'monthly' ? 1 : ''), status: 'active', userId: u.id, username: u.username,
        issuedAt: todayStr(), issuedBy: ctx.username(), activatedAt: todayStr(), startDate: start, expiresAt: expire, note: clean(input.note, 300) });
    }
  }
  rec.licenseNote = clean(input.note, 300);
  if (input.email !== undefined) {   // อีเมลใช้เข้าสู่ระบบได้ → ต้องไม่ซ้ำกับบัญชีอื่น
    const em = clean(input.email, 200).toLowerCase();
    if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) fail('รูปแบบอีเมลไม่ถูกต้อง');
    if (em && await ctx.one('SELECT id FROM users WHERE id <> $1 AND (lower(email) = $2 OR lower(username) = $2)', [u.id, em])) fail('อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว');
    rec.email = em;
  }
  rec.licenseNotified = '';
  await ctx.update('users', u.id, rec);
  const merged = Object.assign({}, u, rec);
  return { success: true, row: licenseRow(merged, false), licenseKey: String(merged.licenseKey || '') };
}
function extendUser(u, plan) {
  const today = todayStr(), cur = String(u.licenseExpire || '');
  const live = ymdParse(cur) && daysBetween(today, cur) >= 0 && String(u.licensePlan || '') && String(u.licensePlan) !== 'none';
  const start = live ? dayShift(cur, 1) : today;
  return { licensePlan: plan, licenseStart: live && u.licenseStart ? String(u.licenseStart) : start, licenseExpire: licExpireFor(start, plan), licenseNotified: '' };
}
async function renewLicense(ctx, userId, plan) {
  await superOnly(ctx);
  plan = String(plan);
  if (plan !== 'monthly' && plan !== 'yearly') fail('แผนไม่ถูกต้อง');
  await ctx.lock('registry');
  const u = await userById(ctx, userId);
  if (await isSuper(ctx, u)) fail('Super Admin ไม่มีวันหมดอายุ');
  const rec = extendUser(u, plan);
  rec.licenseKey = await uniqueKey(ctx, plan);
  await ctx.insert('license_keys', { licenseKey: rec.licenseKey, plan, months: keyMonths(plan), status: 'active', userId: u.id, username: u.username, issuedAt: todayStr(), issuedBy: ctx.username(),
    activatedAt: todayStr(), startDate: rec.licenseStart, expiresAt: rec.licenseExpire, note: 'ต่ออายุโดย Super Admin' });
  await ctx.update('users', u.id, rec);
  return { success: true, row: licenseRow(Object.assign({}, u, rec), false), licenseKey: rec.licenseKey };
}
async function createLicenseKey(ctx, input) {
  await superOnly(ctx); input = input || {};
  const plan = String(input.plan);
  if (plan !== 'monthly' && plan !== 'yearly') fail('แผนไม่ถูกต้อง');
  const qty = Math.max(1, Math.min(50, Math.floor(Number(input.qty)) || 1));
  let uid = '', uname = '';
  if (input.userId) { const u = await userById(ctx, input.userId); uid = String(u.id); uname = String(u.username); }
  await ctx.lock('registry');
  const keys = [];
  for (let i = 0; i < qty; i++) {
    const k = await uniqueKey(ctx, plan); keys.push(k);
    await ctx.insert('license_keys', { licenseKey: k, plan, months: keyMonths(plan), status: 'unused', userId: uid, username: uname, issuedAt: todayStr(), issuedBy: ctx.username(), note: clean(input.note, 300) });
  }
  return { success: true, keys };
}
const normKey = k => String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(DF[MYC])/, '$1-').replace(/^(DF[MYC]-)(.{5})(.{5})(.{5}).*$/, '$1$2-$3-$4');
async function redeemKey(ctx, user, key) {
  const nk = normKey(key);
  if (!/^DF[MYC]-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(nk)) fail('รูปแบบ License Key ไม่ถูกต้อง');
  await ctx.lock('registry');
  const row = await ctx.one('SELECT * FROM license_keys WHERE license_key = $1 FOR UPDATE', [nk]);
  if (!row) fail('ไม่พบ License Key นี้');
  if (row.status === 'revoked') fail('License Key นี้ถูกยกเลิกแล้ว');
  if (row.status !== 'unused') fail('License Key นี้ถูกใช้งานไปแล้ว');
  if (row.userId && String(row.userId) !== String(user.id)) fail('License Key นี้ออกให้ผู้ใช้อื่น');
  if (row.plan !== 'monthly' && row.plan !== 'yearly') fail('License Key นี้ไม่รองรับการต่ออายุ');
  const u = await ctx.one('SELECT * FROM users WHERE id = $1', [user.id]);
  if (!u || u.status !== 'active') fail('บัญชีนี้ไม่พร้อมใช้งาน');
  if (await isSuper(ctx, u)) fail('Super Admin ไม่มีวันหมดอายุ');
  const rec = extendUser(u, row.plan); rec.licenseKey = nk;
  await ctx.exec("UPDATE license_keys SET status = 'used', user_id = $2, username = $3, activated_at = $4, start_date = $5, expires_at = $6 WHERE license_key = $1",
    [nk, u.id, u.username, todayStr(), rec.licenseStart, rec.licenseExpire]);
  await ctx.update('users', u.id, rec);
  return { success: true, expire: rec.licenseExpire, plan: row.plan };
}
async function redeemLicenseKey(ctx, key) { return redeemKey(ctx, ctx.user, key); }
async function activateLicense(ctx, username, key) {
  username = String(username || '').trim().toLowerCase().slice(0, 100);
  const fk = 'lfail_' + username;
  if (failCount(fk) >= LOGIN_MAX_FAIL) fail('ลองผิดหลายครั้ง กรุณารอ 10 นาทีแล้วลองใหม่');
  try {
    const u = await findLoginUser(ctx, username, " AND status = 'active'");
    if (!u) fail('ไม่พบชื่อผู้ใช้นี้');
    const r = await redeemKey(ctx, u, key);
    FAILS.delete(fk); return r;
  } catch (e) { failAdd(fk); throw e; }
}
async function listLicenseKeys(ctx) {
  await superOnly(ctx);
  const today = todayStr();
  const rows = (await ctx.all('SELECT * FROM license_keys ORDER BY created_at DESC')).map(r => ({ licenseKey: r.licenseKey, plan: r.plan, months: r.months, status: r.status, username: r.username,
    issuedAt: r.issuedAt, issuedBy: r.issuedBy, activatedAt: r.activatedAt, startDate: r.startDate, expiresAt: r.expiresAt, note: r.note,
    state: (r.status === 'revoked' || r.status === 'unused') ? r.status : (r.expiresAt && daysBetween(today, r.expiresAt) < 0 ? 'expired' : r.status) }));
  return { rows, url: '' };
}
async function revokeLicenseKey(ctx, key) {
  await superOnly(ctx);
  const row = await ctx.one('SELECT * FROM license_keys WHERE license_key = $1', [String(key)]);
  if (!row) fail('ไม่พบ License Key');
  if (row.status !== 'unused') fail('ยกเลิกได้เฉพาะ Key ที่ยังไม่ถูกใช้');
  await ctx.exec("UPDATE license_keys SET status = 'revoked' WHERE license_key = $1", [row.licenseKey]);
  return { success: true };
}
async function deleteLicenseKey(ctx, key) {
  await superOnly(ctx);
  const r = await ctx.exec('DELETE FROM license_keys WHERE license_key = $1', [String(key)]);
  if (!r.rowCount) fail('ไม่พบ License Key (อาจถูกลบไปแล้ว)');
  return { success: true };
}
// ---------- แจ้งเตือน License ทางอีเมล (cron ทุกวัน 08:00) ----------
async function licenseNotices(ctx) {
  const sup = await superIds(ctx);
  const all = await ctx.all('SELECT * FROM users ORDER BY created_at');
  const supers = all.filter(u => u.status === 'active' && sup.has(String(u.id)) && String(u.email || '').trim());
  const todo = []; let sent = 0;
  for (const u of all.filter(x => x.status === 'active' && !sup.has(String(x.id)))) {
    const l = licenseOf(u, false); if (l.state === 'none' || l.state === 'active') continue;
    const mark = l.daysLeft < 0 ? 'x' : LIC_MARKS.filter(m => l.daysLeft <= m).sort((a, b) => a - b)[0];
    if (mark === undefined) continue;
    const key = l.expire + ':' + mark;
    if (String(u.licenseNotified || '') === key) continue;
    const when = l.daysLeft < 0 ? 'หมดอายุแล้วเมื่อ ' + thDate(l.expire) : (l.daysLeft === 0 ? 'จะหมดอายุวันนี้' : 'จะหมดอายุในอีก ' + l.daysLeft + ' วัน (' + thDate(l.expire) + ')');
    if (String(u.email || '').trim()) {
      try {
        if (await sendMail(String(u.email).trim(), '[DocFlow] ใบอนุญาตใช้งาน' + (l.daysLeft < 0 ? 'หมดอายุแล้ว' : 'ใกล้หมดอายุ'),
          'เรียน ' + (u.displayName || u.username) + '\n\nใบอนุญาตใช้งาน DocFlow ของคุณ ' + when + '\nกรุณาติดต่อผู้ดูแลระบบเพื่อต่ออายุ เพื่อให้ใช้งานต่อเนื่อง\n')) sent++;
      } catch (e) { console.error('ส่งอีเมลผู้ใช้ไม่สำเร็จ:', e.message); }
    }
    todo.push(u.username + ' (' + (u.displayName || '') + ') ' + when);
    await ctx.exec('UPDATE users SET license_notified = $1 WHERE id = $2', [key, u.id]);
  }
  if (todo.length) {
    for (const s of supers) {
      try { if (await sendMail(String(s.email).trim(), '[DocFlow] สรุปผู้ใช้ที่ License ใกล้หมดอายุ/หมดอายุ (' + todo.length + ' ราย)', todo.join('\n') + '\n')) sent++; }
      catch (e) { console.error('ส่งอีเมล Super Admin ไม่สำเร็จ:', e.message); }
    }
  }
  return { due: todo.length, sent, supers: supers.length };
}
async function sendLicenseNotices(ctx) { await superOnly(ctx); return licenseNotices(ctx); }

// ---------- จัดการผู้ใช้ ----------
// Super Admin: เห็น/จัดการผู้ใช้ทุกคน
// Admin / ผู้ตรวจสอบ (Admin Audit): เห็น/จัดการเฉพาะผู้ใช้ที่ตนสร้าง (รวมที่ผู้ใช้เหล่านั้นสร้างต่อ)
//   - ให้สิทธิ์ได้ต่ำกว่าตัวเองเท่านั้น (Admin → ผู้ตรวจสอบ/พนักงาน/ดูอย่างเดียว · ผู้ตรวจสอบ → พนักงาน/ดูอย่างเดียว)
//   - ผูกผู้ใช้ได้เฉพาะบริษัทที่ตนเองเข้าถึงได้
async function managedIds(ctx) {   // null = ทุกคน (Super Admin)
  if (await isSuper(ctx, ctx.user)) return null;
  const rows = await ctx.all(`WITH RECURSIVE t AS (SELECT id FROM users WHERE created_by = $1 UNION SELECT u.id FROM users u JOIN t ON u.created_by = t.id) SELECT id FROM t`, [ctx.user.id]);
  return new Set(rows.map(r => String(r.id)));
}
function assignableRoles(me, sup) { return sup ? ROLES.slice() : ROLES.filter(r => ROLE_RANK[r] < (ROLE_RANK[String(me.role)] || 0)); }
async function listUsers(ctx) {
  const sup = await superIds(ctx), meSuper = sup.has(String(ctx.user.id)), ids = await managedIds(ctx);
  const rows = (await ctx.all('SELECT * FROM users ORDER BY created_at, username')).filter(u => !ids || ids.has(String(u.id)) || String(u.id) === String(ctx.user.id));
  const tenants = meSuper ? (await tenantsList(ctx)).map(t => ({ id: String(t.id), name: String(t.companyName) })) : await allowedTenants(ctx, ctx.user);
  const myLimit = await createLimitOf(ctx, ctx.user), myUsed = await createdCount(ctx, ctx.user.id);
  const createdBy = {}, madeCo = {};
  if (meSuper) {
    (await ctx.all('SELECT created_by AS c, count(*)::int AS n FROM users WHERE created_by IS NOT NULL GROUP BY created_by')).forEach(r => { createdBy[String(r.c)] = r.n; });
    (await ctx.all('SELECT created_by AS c, count(*)::int AS n FROM tenants WHERE created_by IS NOT NULL GROUP BY created_by')).forEach(r => { madeCo[String(r.c)] = r.n; });
  }
  const cfg = await signupConfig(ctx), defQuota = cfg.quota, defCompanyQuota = cfg.companyQuota;
  const myCoLimit = await companyLimitOf(ctx, ctx.user), myCoUsed = await companyCount(ctx, ctx.user.id);
  return {
    users: rows.map(u => ({ userId: String(u.id), username: String(u.username), displayName: String(u.displayName || ''), role: String(u.role),
      tenantIds: String(u.tenantIds || ''), status: String(u.status), lastLogin: u.lastLogin ? new Date(u.lastLogin).toISOString() : '', email: String(u.email || ''), isSuper: sup.has(String(u.id)), avatar: avatarUrl(u),
      isMe: String(u.id) === String(ctx.user.id),
      licensePlan: String(u.licensePlan || ''), licenseStart: String(u.licenseStart || ''), licenseExpire: String(u.licenseExpire || ''), licenseKey: String(u.licenseKey || ''),
      createdById: u.createdBy ? String(u.createdBy) : '',
      userQuota: (u.userQuota == null ? '' : String(u.userQuota)), createdUsers: createdBy[String(u.id)] || 0,
      companyQuota: (u.companyQuota == null ? '' : String(u.companyQuota)), createdCompanies: madeCo[String(u.id)] || 0 })),
    tenants, roles: assignableRoles(ctx.user, meSuper), canAll: meSuper || String(ctx.user.tenantIds).trim() === '*',
    myQuota: { used: myUsed, limit: myLimit === Infinity ? -1 : myLimit, unlimited: myLimit === Infinity },
    myCompanyQuota: { used: myCoUsed, limit: myCoLimit === Infinity ? -1 : myCoLimit, unlimited: myCoLimit === Infinity },
    defQuota, defCompanyQuota, meSuper
  };
}
async function managedUser(ctx, id) {
  const u = await ctx.one('SELECT * FROM users WHERE id::text = $1', [String(id || '')]);
  if (!u) fail('ไม่พบผู้ใช้ (อาจถูกลบไปแล้ว)');
  const ids = await managedIds(ctx);
  if (ids && !ids.has(String(u.id))) fail('ไม่มีสิทธิ์จัดการผู้ใช้นี้');
  return u;
}
async function deleteUser(ctx, userId) {
  await ctx.lock('registry');
  const old = await managedUser(ctx, userId);
  if (String(old.id) === String(ctx.user.id)) fail('ลบบัญชีที่กำลังใช้งานอยู่ไม่ได้');
  if (await isSuper(ctx, old)) fail('ลบบัญชี Super Admin ไม่ได้');
  if (old.role === 'admin' && !(await isSuper(ctx, ctx.user))) fail('การลบผู้ดูแลระบบทำได้เฉพาะ Super Admin');
  const other = await ctx.one("SELECT id FROM users WHERE id <> $1 AND role = 'admin' AND status = 'active' LIMIT 1", [old.id]);
  if (!other) fail('ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน');
  await ctx.exec('UPDATE users SET created_by = $1 WHERE created_by = $2', [ctx.user.id, old.id]);   // ผู้ใช้ที่คนนี้สร้างไว้ → ย้ายมาอยู่กับผู้ลบ
  await ctx.exec('DELETE FROM users WHERE id = $1', [old.id]);
  await ctx.exec("UPDATE license_keys SET status = 'revoked' WHERE user_id = $1 AND status IN ('unused','active')", [old.id]);
  return { success: true, username: String(old.username), archived: false };
}
// รูปโปรไฟล์: รับ data URL (png/jpeg/webp) ขนาดไม่เกิน ~400KB · '' = ลบรูป
function parseAvatar(dataUrl) {
  const v = String(dataUrl || '');
  if (!v) return { clear: true };
  const m = v.match(/^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) fail('รูปโปรไฟล์ไม่ถูกต้อง (รองรับ PNG, JPG, WEBP)');
  const buf = Buffer.from(m[3], 'base64');
  if (!buf.length) fail('รูปโปรไฟล์ไม่ถูกต้อง');
  if (buf.length > 400 * 1024) fail('รูปโปรไฟล์ใหญ่เกินไป กรุณาเลือกรูปที่เล็กลง');
  return { buf, mime: m[1] };
}
const avatarUrl = u => (u && u.avatar) ? 'data:' + (u.avatarMime || 'image/jpeg') + ';base64,' + Buffer.from(u.avatar).toString('base64') : '';
// ผู้ใช้ตั้งรูปโปรไฟล์ของตัวเอง
async function setMyAvatar(ctx, dataUrl) {
  const a = parseAvatar(dataUrl);
  await ctx.exec('UPDATE users SET avatar = $2, avatar_mime = $3 WHERE id = $1', [ctx.user.id, a.clear ? null : a.buf, a.clear ? null : a.mime]);
  return { avatar: a.clear ? '' : 'data:' + a.mime + ';base64,' + a.buf.toString('base64') };
}
async function saveUser(ctx, input) {
  input = input || {};
  await ctx.lock('registry');
  const meSuper = await isSuper(ctx, ctx.user);
  const old = input.userId ? await managedUser(ctx, input.userId) : null;
  if (old && !meSuper && String(old.id) === String(ctx.user.id)) fail('แก้ไขสิทธิ์ของบัญชีตัวเองไม่ได้ (เปลี่ยนรหัสผ่านได้ที่ "บัญชีของฉัน")');
  const username = old ? String(old.username) : String(input.username || '').trim().toLowerCase();
  if (!old) {
    if (!/^[a-z0-9._@-]{3,50}$/.test(username)) fail('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z 0-9 . _ @ - ความยาว 3-50 ตัวอักษร');
    if (await ctx.one("SELECT id FROM users WHERE lower(username) = $1 OR (lower(email) = $1 AND email <> '')", [username])) fail('ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  }
  const oldSuper = old ? await isSuper(ctx, old) : false;
  if (oldSuper && !meSuper) fail('แก้ไขบัญชี Super Admin ได้เฉพาะ Super Admin');
  const role = String(input.role || ''), status = String(input.status || 'active');
  if (oldSuper && (role !== 'admin' || status !== 'active')) fail('Super Admin ต้องเป็นผู้ดูแลระบบที่ใช้งานอยู่เสมอ');
  if (!ROLES.includes(role)) fail('สิทธิ์ไม่ถูกต้อง');
  if (!assignableRoles(ctx.user, meSuper).includes(role)) fail('กำหนดสิทธิ์นี้ไม่ได้ (ให้สิทธิ์ได้ต่ำกว่าสิทธิ์ของตัวเองเท่านั้น)');
  if (!['active', 'disabled'].includes(status)) fail('สถานะไม่ถูกต้อง');
  // บริษัทที่ผูกได้: Super Admin = ทุกบริษัท · คนอื่น = เฉพาะบริษัทที่ตนเข้าถึงได้
  const myAll = meSuper || String(ctx.user.tenantIds).trim() === '*';
  const valid = (meSuper ? (await tenantsList(ctx)).map(t => String(t.id)) : (await allowedTenants(ctx, ctx.user)).map(t => t.id));
  let tenantIds;
  if (String(input.tenantIds).trim() === '*') { if (!myAll) fail('เลือก "ทุกบริษัท" ไม่ได้ กรุณาเลือกบริษัทที่ต้องการ'); tenantIds = '*'; }
  else tenantIds = String(input.tenantIds || '').split(',').map(s => s.trim()).filter(id => valid.includes(id)).join(',');
  if (!meSuper && !tenantIds) fail('กรุณาเลือกบริษัทที่ผู้ใช้เข้าถึงได้อย่างน้อย 1 บริษัท');
  if (old && !meSuper && String(old.tenantIds).trim() !== '*') {   // คงบริษัทเดิมที่ผู้แก้ไขมองไม่เห็นไว้ (ไม่ลบสิทธิ์ที่ผู้อื่นให้ไว้)
    const keep = String(old.tenantIds).split(',').map(x => x.trim()).filter(x => x && !valid.includes(x));
    if (keep.length && tenantIds !== '*') tenantIds = [...new Set(tenantIds.split(',').filter(Boolean).concat(keep))].join(',');
  }
  if (!old && !input.password) fail('กรุณากำหนดรหัสผ่าน');
  if (input.password) checkPw(input.password, username);
  const other = await ctx.one("SELECT id FROM users WHERE ($1::uuid IS NULL OR id <> $1) AND role = 'admin' AND status = 'active' LIMIT 1", [old ? old.id : null]);
  if (!other && !(role === 'admin' && status === 'active')) fail('ต้องมีผู้ดูแลระบบที่ใช้งานอยู่อย่างน้อย 1 คน');
  if (!old && !meSuper) {
    const limit = await createLimitOf(ctx, ctx.user), used = await createdCount(ctx, ctx.user.id);
    if (used >= limit) fail(`สร้างผู้ใช้ได้สูงสุด ${limit} คน (สร้างไปแล้ว ${used}) หากต้องการสร้างเพิ่ม กรุณาติดต่อ Super Admin`);
  }
  const rec = old ? {} : { id: uuid(), username, createdAt: new Date(), createdBy: ctx.user.id };
  if (!old && !meSuper) {   // ผู้ใช้ที่ Admin/ผู้ตรวจสอบสร้าง = License เท่ากับของผู้สร้าง (Super Admin ปรับภายหลังได้)
    const my = ctx.user; rec.licensePlan = my.licensePlan || ''; rec.licenseStart = my.licenseStart || ''; rec.licenseExpire = my.licenseExpire || '';
  }
  // อีเมล: ใช้เข้าสู่ระบบแทนชื่อผู้ใช้ได้ จึงต้องไม่ซ้ำกับอีเมลหรือชื่อผู้ใช้ของบัญชีอื่น · Admin / ผู้ตรวจสอบ ต้องมีอีเมล
  let email = input.email !== undefined ? clean(input.email, 200).toLowerCase() : String((old && old.email) || '').toLowerCase();
  if (!email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(username)) email = username;   // ชื่อผู้ใช้เป็นอีเมลอยู่แล้ว
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail('รูปแบบอีเมลไม่ถูกต้อง');
  if (!email && (role === 'admin' || role === 'audit')) fail('กรุณากรอกอีเมลสำหรับผู้ดูแลระบบ / ผู้ตรวจสอบ');
  if (email && await ctx.one("SELECT id FROM users WHERE ($1::uuid IS NULL OR id <> $1) AND (lower(email) = $2 OR lower(username) = $2)", [old ? old.id : (rec.id || null), email])) fail('อีเมลนี้ถูกใช้กับบัญชีอื่นแล้ว');
  rec.email = email;
  if (input.avatarData !== undefined) { const a = parseAvatar(input.avatarData); rec.avatar = a.clear ? null : a.buf; rec.avatarMime = a.clear ? null : a.mime; }
  if (meSuper && input.userQuota !== undefined) {   // Super Admin กำหนดโควตาการสร้างผู้ใช้
    const v = String(input.userQuota);
    if (v === '' || v === 'default') rec.userQuota = null;
    else if (v === 'unlimited' || v === '-1') rec.userQuota = -1;
    else { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 1 || n > 9999) fail('โควตาผู้ใช้ต้องอยู่ระหว่าง 1 ถึง 9999'); rec.userQuota = n; }
  }
  if (meSuper && input.companyQuota !== undefined) {   // Super Admin กำหนดโควตาการสร้างบริษัท
    const v = String(input.companyQuota);
    if (v === '' || v === 'default') rec.companyQuota = null;
    else if (v === 'unlimited' || v === '-1') rec.companyQuota = -1;
    else { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 1 || n > 9999) fail('โควตาบริษัทต้องอยู่ระหว่าง 1 ถึง 9999'); rec.companyQuota = n; }
  }
  rec.displayName = clean(input.displayName, 100) || username;
  rec.role = role; rec.status = status; rec.tenantIds = tenantIds;
  if (input.password) { rec.salt = newSalt(); rec.passwordHash = hashPw(String(input.password), rec.salt); }
  if (old) await ctx.update('users', old.id, rec); else await ctx.insert('users', rec);
  return { success: true, userId: String(old ? old.id : rec.id) };
}

// Super Admin ปรับโควตาการสร้างผู้ใช้ของผู้ใช้รายเดียว (จากหน้า "ผู้ใช้งานระบบ")
async function setUserQuota(ctx, userId, value) {
  await superOnly(ctx);
  const u = await ctx.one('SELECT * FROM users WHERE id = $1', [String(userId || '')]);
  if (!u) fail('ไม่พบผู้ใช้');
  if (!['admin', 'audit'].includes(u.role)) fail('กำหนดโควตาได้เฉพาะเจ้าของบัญชี (ผู้ดูแล/ผู้ตรวจสอบ) เท่านั้น');
  const v = String(value);
  let q;
  if (v === '' || v === 'default') q = null;
  else if (v === 'unlimited' || v === '-1') q = -1;
  else { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 1 || n > 9999) fail('โควตาผู้ใช้ต้องอยู่ระหว่าง 1 ถึง 9999'); q = n; }
  await ctx.update('users', u.id, { userQuota: q });
  const used = await createdCount(ctx, u.id), def = (await signupConfig(ctx)).quota;
  const limit = q == null ? def : (q === -1 ? -1 : q);
  ctx.afterCommit(() => { try { require('./hub').toUser(String(u.id), { type: 'quota', limit, used }); } catch (e) {} });
  return { userId: String(u.id), userQuota: q == null ? '' : String(q), createdUsers: used, defQuota: def };
}

// ---------- บริษัท ----------
async function createTenantRaw(ctx, name) {
  const id = uuid();
  await ctx.insert('tenants', { id, companyName: name, status: 'active', createdAt: new Date() });
  await ensureTenant(ctx, id);
  return { id };
}
async function createTenant(ctx, name, ownerId) {
  name = clean(name, 250);
  if (!name) fail('กรุณากรอกชื่อบริษัท');
  await ctx.lock('registry');
  const meSuper = await isSuper(ctx, ctx.user);
  // Super Admin สร้างบริษัทให้เจ้าของบัญชีคนอื่นได้ (เลือกจากหน้า "ติดตามผู้ใช้งาน")
  let owner = ctx.user;
  if (meSuper && ownerId && String(ownerId) !== String(ctx.user.id)) {
    const o = await ctx.one('SELECT * FROM users WHERE id::text = $1', [String(ownerId)]);
    if (!o) fail('ไม่พบเจ้าของบัญชีที่เลือก');
    owner = o;
  } else if (!meSuper) {
    // บังคับโควตาจำนวนบริษัทของผู้ใช้ทั่วไป
    const limit = await companyLimitOf(ctx, ctx.user), used = await companyCount(ctx, ctx.user.id);
    if (used >= limit) fail(`สร้างบริษัทได้สูงสุด ${limit} บริษัท (สร้างไปแล้ว ${used}) หากต้องการเพิ่ม กรุณาติดต่อ Super Admin หรือกดปุ่ม "ขอเพิ่มบริษัท"`);
  }
  const t = await createTenantRaw(ctx, name);
  await ctx.exec('UPDATE tenants SET created_by = $1 WHERE id = $2', [owner.id, t.id]);
  // ให้สิทธิ์เจ้าของเข้าถึงบริษัทใหม่
  if (String(owner.tenantIds).trim() !== '*') {
    const ids = (String(owner.tenantIds) ? owner.tenantIds + ',' : '') + t.id;
    await ctx.update('users', owner.id, { tenantIds: ids });
    if (String(owner.id) === String(ctx.user.id)) ctx.user = Object.assign({}, ctx.user, { tenantIds: ids });
  }
  return { success: true, id: t.id, name, ownerId: String(owner.id), url: '', tenants: await allowedTenants(ctx, ctx.user) };
}
// Super Admin กำหนดโควตาจำนวนบริษัทของผู้ใช้รายเดียว
async function setCompanyQuota(ctx, userId, value) {
  await superOnly(ctx);
  const u = await ctx.one('SELECT * FROM users WHERE id = $1', [String(userId || '')]);
  if (!u) fail('ไม่พบผู้ใช้');
  if (!['admin', 'audit'].includes(u.role)) fail('กำหนดโควตาบริษัทได้เฉพาะเจ้าของบัญชี (ผู้ดูแล/ผู้ตรวจสอบ) เท่านั้น');
  const v = String(value);
  let q;
  if (v === '' || v === 'default') q = null;
  else if (v === 'unlimited' || v === '-1') q = -1;
  else { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 1 || n > 9999) fail('โควตาบริษัทต้องอยู่ระหว่าง 1 ถึง 9999'); q = n; }
  await ctx.update('users', u.id, { companyQuota: q });
  const used = await companyCount(ctx, u.id), def = (await signupConfig(ctx)).companyQuota;
  const limit = q == null ? def : (q === -1 ? -1 : q);
  ctx.afterCommit(() => { try { require('./hub').toUser(String(u.id), { type: 'quota', scope: 'company', limit, used }); } catch (e) {} });
  return { userId: String(u.id), companyQuota: q == null ? '' : String(q), createdCompanies: used, defCompanyQuota: def };
}
// ข้อมูลโควตาบริษัทของผู้ใช้ปัจจุบัน (สำหรับหน้า "บริษัทของฉัน")
async function companyQuotaInfo(ctx) {
  if (await isSuper(ctx, ctx.user)) return { used: 0, limit: -1, unlimited: true, isSuper: true };
  const limit = await companyLimitOf(ctx, ctx.user), used = await companyCount(ctx, ctx.user.id);
  return { used, limit: limit === Infinity ? -1 : limit, unlimited: limit === Infinity, isSuper: false };
}
// ลบบริษัทถาวร (เฉพาะ Super Admin): ข้อมูลทุกตารางของบริษัท + ไฟล์ใน Storage
// - สำรองข้อมูลทั้งระบบอัตโนมัติก่อนลบ (กู้คืนได้จาก Storage/03 สำรองข้อมูล)
// - ผู้ใช้ไม่ถูกลบ แต่จะถูกถอดสิทธิ์เข้าถึงบริษัทนี้
async function deleteTenant(ctx, tenantId, confirmName) {
  await superOnly(ctx);
  await ctx.lock('registry');
  const t = await ctx.one('SELECT * FROM tenants WHERE id::text = $1', [String(tenantId || '')]);
  if (!t) fail('ไม่พบบริษัท');
  const prof = await ctx.one('SELECT company_name FROM company_profiles WHERE tenant_id = $1', [t.id]);
  const name = String((prof && prof.companyName) || t.companyName);
  if (String(confirmName || '').trim() !== name.trim()) fail('ชื่อบริษัทที่พิมพ์ยืนยันไม่ตรงกัน');
  const n = await ctx.one('SELECT count(*)::int AS n FROM tenants');
  if (n.n <= 1) fail('ลบไม่ได้: ระบบต้องมีบริษัทอย่างน้อย 1 บริษัท');
  // 1) สำรองข้อมูลทั้งระบบก่อนลบ
  let backup = null;
  try { backup = await require('./backup').backupToStorage(require('./db').pool); } catch (e) { fail('สำรองข้อมูลก่อนลบไม่สำเร็จ จึงยกเลิกการลบ: ' + e.message); }
  // 2) ไฟล์ของบริษัทใน Storage (ไฟล์อัพโหลด, PDF, ไฟล์ในถังขยะ)
  const files = [
    ...(await ctx.all("SELECT file_id FROM uploads WHERE tenant_id = $1 AND status <> 'deleted'", [t.id])).map(r => r.fileId),
    ...(await ctx.all('SELECT file_id FROM pdf_backups WHERE tenant_id = $1', [t.id])).map(r => r.fileId),
    ...(await ctx.all("SELECT trash_file_id AS file_id FROM trash_items WHERE tenant_id = $1 AND status = 'trashed'", [t.id])).map(r => r.fileId)
  ].filter(Boolean);
  // 3) ลบข้อมูลในฐานข้อมูล (ตารางที่ผูกกับบริษัทถูกลบตามอัตโนมัติ — ON DELETE CASCADE)
  await ctx.exec('DELETE FROM trash_items WHERE tenant_id = $1', [t.id]);
  await ctx.exec('DELETE FROM audit_log WHERE tenant_id = $1', [t.id]);
  await ctx.exec('DELETE FROM tenants WHERE id = $1', [t.id]);
  // 4) ถอดบริษัทออกจากสิทธิ์ของผู้ใช้
  let users = 0;
  for (const u of await ctx.all("SELECT id, tenant_ids FROM users WHERE tenant_ids LIKE $1", ['%' + t.id + '%'])) {
    const ids = String(u.tenantIds).split(',').map(x => x.trim()).filter(x => x && x !== String(t.id)).join(',');
    await ctx.exec('UPDATE users SET tenant_ids = $1 WHERE id = $2', [ids, u.id]); users++;
  }
  await ctx.exec('INSERT INTO audit_log (tenant_id, document_id, action, detail, username) VALUES (NULL,$1,$2,$3,$4)',
    ['TENANT:' + t.id, 'TENANT_DELETE', name + ' (ไฟล์ ' + files.length + ' · สำรองก่อนลบ: ' + (backup ? backup.file : '-') + ')', ctx.username()]);
  // 5) ลบไฟล์หลังบันทึกฐานข้อมูลสำเร็จ
  ctx.afterCommit(() => { (async () => { for (const f of files) { try { await storage.purge(String(f)); } catch (e) { console.warn('delete tenant file:', e.message); } } })(); });
  return { success: true, name, files: files.length, usersUpdated: users, backup: backup ? backup.file : '', tenants: await allowedTenants(ctx, ctx.user) };
}
async function listCompanies(ctx) {
  const allowed = await allowedTenants(ctx, ctx.user);
  if (!allowed.length) return [];
  const rows = await ctx.all('SELECT tenant_id, company_name, company_tax_id, company_phone, company_email, company_address, signatory_name, branch FROM company_profiles WHERE tenant_id = ANY($1::uuid[])', [allowed.map(t => t.id)]);
  return allowed.map(t => {
    const p = rows.find(r => String(r.tenantId) === t.id) || {};
    return { id: t.id, name: p.companyName || t.name, taxId: p.companyTaxId || '', phone: p.companyPhone || '', email: p.companyEmail || '', address: p.companyAddress || '',
      signatory: p.signatoryName || '', branch: p.branch || '', url: '' };
  });
}
module.exports = {
  managedIds, superIdsPublic: superIds, allowedTenantsPublic: allowedTenants, safeEq,
  setMyAvatar, avatarUrl,
  saveSignupSettings, licMsgFor: licMsg, contactLine,
  ROLES, ROLE_RANK, hashPw, newSalt, newSid, checkPw, makeToken, authUser, initSecret, isSuper, superOnly, licenseOf, licMsg,
  allowedTenants, setTenant, ensureTenant, syncTenantName, createTenantRaw, localeTh,
  authStatus, signup, login, createFirstAdmin, activateLicense, getSession, changeMyPassword, logout, streamTicket, takeStreamTicket,
  listLicenses, saveLicense, renewLicense, saveContactInfo, createLicenseKey, listLicenseKeys, revokeLicenseKey, deleteLicenseKey, redeemLicenseKey, sendLicenseNotices, licenseNotices,
  listUsers, saveUser, setUserQuota, setCompanyQuota, companyQuotaInfo, companyLimitOf, companyCount,
  createLimitOfPublic: createLimitOf, createdCountPublic: createdCount, signupConfigPublic: signupConfig,
  deleteUser, createTenant, deleteTenant, listCompanies
};
