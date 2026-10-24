// ============================================================
//  DocFlow — Express server
//  GET  /                    หน้าเว็บ (public/index.html)
//  POST /api/call/:fn        JSON API ที่ต้องล็อกอิน  (Authorization: Bearer <token>, X-Tenant-Id: <บริษัท>, body: {"args": [...]})
//  POST /api/public/:fn      authStatus, login, createFirstAdmin, activateLicense
//  GET  /api/i18n/en         พจนานุกรมไทย→อังกฤษ (JSON)
//  GET  /healthz             ตรวจสถานะ
// ============================================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { pool, migrate, withCtx } = require('./db');
const { callApi, callPublic } = require('./api');
const { licenseNotices, initSecret } = require('./platform');
const { backupToStorage } = require('./backup');
const { purgeExpired } = require('./trash');
const { dailyMaintenance, storageCheck, storageState } = require('./maint');
const FB = require('./fullbackup');
const storage = require('./storage');
const { TZ } = require('./util');
const hub = require('./hub');
const P = require('./platform');

const PORT = Number(process.env.PORT || 3000);
const PUB = path.join(__dirname, '..', 'public');
// อ่าน index.html ใหม่เมื่อไฟล์เปลี่ยน (วางไฟล์ใหม่ทับแล้วรีเฟรชหน้าเว็บได้เลย ไม่ต้อง build ใหม่)
let INDEX = '', INDEX_MT = 0;
function indexHtml() {
  const f = path.join(PUB, 'index.html'), mt = fs.statSync(f).mtimeMs;
  if (mt !== INDEX_MT) { INDEX = fs.readFileSync(f, 'utf8'); INDEX_MT = mt; }
  return INDEX;
}
const EN = fs.readFileSync(path.join(__dirname, 'i18n', 'en.json'), 'utf8');

const app = express();
app.disable('x-powered-by');
// เชื่อ X-Forwarded-For เฉพาะเมื่อคำขอมาจากเครือข่ายภายใน (เช่น cloudflared / reverse proxy ใน Docker) — คำขอจากอินเทอร์เน็ตตรง ๆ ปลอม IP ไม่ได้
// M8 (Security Review): รับค่า TRUST_PROXY จาก .env เฉพาะรูปแบบ network ที่ปลอดภัย (loopback/CIDR) เท่านั้น
// ค่ากว้างอย่าง true/* ถูกปฏิเสธ → ผู้โจมตีปลอม X-Forwarded-For เพื่อหลุดจากการนับ rate-limit ต่อ IP ไม่ได้
const tpAllow = /^(loopback|linklocal|uniquelocal|127(\.\d+){1,3}\/\d+|10(\.\d+){1,3}\/\d+|192\.168\.\d+\/\d+|172\.(1[6-9]|[23]\d)\.\d+\/\d+|::1\/\d+|f[cd][0-9a-f]{2}:[0-9a-f:]+\/\d+)(\s*,\s*(loopback|linklocal|uniquelocal|127(\.\d+){1,3}\/\d+|10(\.\d+){1,3}\/\d+|192\.168\.\d+\/\d+|172\.(1[6-9]|[23]\d)\.\d+\/\d+|::1\/\d+|f[cd][0-9a-f]{2}:[0-9a-f:]+\/\d+))*$/i;
const tpEnv = String(process.env.TRUST_PROXY || '').trim();
if (tpEnv && !tpAllow.test(tpEnv)) console.warn('TRUST_PROXY ค่าไม่ปลอดภัย/ไม่ถูกต้อง ("' + tpEnv + '") — ใช้ค่าเริ่มต้น loopback,linklocal,uniquelocal แทน');
app.set('trust proxy', tpAllow.test(tpEnv) ? tpEnv : 'loopback, linklocal, uniquelocal');
const isPrivateIp = ip => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i.test(ip);
function clientIp(req) {
  const remote = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (!isPrivateIp(remote)) return remote;                       // มาจากอินเทอร์เน็ตตรง ๆ → ใช้ IP จริงของการเชื่อมต่อ
  const cf = String(req.get('cf-connecting-ip') || '').trim();   // ผ่าน Cloudflare Tunnel
  return (cf || String(req.ip || '') || remote).replace(/^::ffff:/, '');
}
// Content-Security-Policy: อนุญาตให้หน้าเว็บโหลด/ส่งข้อมูลได้เฉพาะเซิร์ฟเวอร์นี้ (+ Google Fonts) กันสคริปต์แปลกปลอมส่ง token ออกไปข้างนอก
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob:", "connect-src 'self'", "frame-src 'self' blob: data:",
  "media-src 'self' blob: data:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'"].join('; ');
app.use(express.json({ limit: process.env.BODY_LIMIT || '25mb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  next();
});

// ถ้าตั้ง ACCESS_KEY ไว้ ต้องเปิดหน้าเว็บด้วย ?key=... ที่ตรงกัน (เหมือนระบบเดิม) — เปรียบเทียบแบบ timing-safe
app.get('/', (req, res) => {
  if (process.env.ACCESS_KEY && !P.safeEq(String(req.query.key || ''), process.env.ACCESS_KEY)) return res.status(403).type('text').send('ไม่มีสิทธิ์เข้าถึง');
  res.set('Cache-Control', 'no-store').type('html').send(indexHtml());
});
app.use(express.static(PUB, { index: false, maxAge: '1d' }));
app.get('/api/i18n/en', (req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text').send(EN));
app.get('/healthz', async (req, res) => {
  // M5 (Security Review): endpoint สาธารณะตอบเท่าที่monitor จำเป็น — boolean เท่านั้น ไม่มี path/ขนาด disk/ข้อความรายละเอียด
  const st = storageState();
  try { await pool.query('SELECT 1'); const ok = st.ok; res.status(ok ? 200 : 503).json({ ok, storageOk: !!st.ok }); }
  catch (e) { res.status(500).json({ ok: false }); }
});

const bearer = req => String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
// ออกจากระบบ (ยกเลิกเซสชันทันที): ส่ง Bearer → สุ่ม session_id ใหม่ → token เดิมใช้ไม่ได้ (Security Review: เพิ่ม logout ฝั่งเซิร์ฟเวอร์)
app.post('/api/logout', async (req, res) => {
  try {
    await withCtx(async ctx => { await P.initSecret(ctx); const r = await P.authUser(ctx, bearer(req)); if (r.user) await ctx.exec('UPDATE users SET session_id = $1 WHERE id = $2', [require('crypto').randomBytes(8).toString('hex'), r.user.id]); });
  } catch (e) {}
  res.json({ ok: true });
});
const send = (res, p) => p.then(result => res.json({ result: result === undefined ? null : result }))
  .catch(e => {
    const msg = String(e && e.message || e);
    // ข้อความภาษาไทย / รหัสที่หน้าเว็บรู้จัก = ข้อผิดพลาดตามเงื่อนไขทางธุรกิจ → ส่งให้ผู้ใช้ได้
    // ข้อผิดพลาดทางเทคนิค (เช่น SQL) → ไม่ส่งรายละเอียดออกไป บันทึกใน log พร้อมรหัสอ้างอิงแทน
    if (/^(SESSION_|LICENSE_|EDIT_REASON)/.test(msg) || /[฀-๿]/.test(msg)) return res.status(400).json({ error: msg });
    const ref = Date.now().toString(36).slice(-6).toUpperCase();
    console.error('[ERR ' + ref + ']', e);
    res.status(e && e.code === '57014' ? 503 : 500).json({ error: (e && e.code === '57014' ? 'ระบบใช้เวลาประมวลผลนานเกินไป กรุณาลองใหม่อีกครั้ง' : 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่อีกครั้ง') + ' (รหัสอ้างอิง ' + ref + ')' });
  });
// แจ้งเตือนแชทแบบทันที (Server-Sent Events) — EventSource ส่ง header ไม่ได้
// จึงใช้ "ตั๋วใช้ครั้งเดียว" (chatStreamTicket) แทนการเอา token ไปค้างใน query string/proxy log (Security Review M9)
app.get('/api/chat/stream', async (req, res) => {
  const vt = P.takeStreamTicket(req.query.t);
  if (!vt) return res.status(401).end();
  let a = null;
  try { a = await withCtx(async ctx => { await P.initSecret(ctx); const u = await ctx.one("SELECT * FROM users WHERE id = $1 AND status = 'active'", [vt.uid]); return u ? { id: u.id, sup: await P.isSuper(ctx, u) } : null; }); }
  catch (e) { a = null; }
  if (!a) return res.status(401).end();
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 5000\n\n');
  const off = hub.add(a.id, a.sup, res);
  req.on('close', off);
});
// ดาวน์โหลดไฟล์สำรอง (ลิงก์ใช้ครั้งเดียวจาก backupTicket) และดูสถานะงานสำรอง/กู้คืน (id สุ่มยาว เดาไม่ได้ — ใช้ต่อได้แม้ต้องล็อกอินใหม่หลังกู้คืน)
app.get('/api/backup/download/:t', (req, res) => {
  const f = FB.takeTicket(req.params.t);
  if (!f || !fs.existsSync(f)) return res.status(404).type('text').send('ลิงก์หมดอายุหรือไม่พบไฟล์ กรุณากดดาวน์โหลดใหม่');
  res.set('Cache-Control', 'no-store'); res.download(f, path.basename(f));
});
app.get('/api/export/download/:t', async (req, res) => {
  const f = await require('./coexport').takeTicket(req.params.t).catch(() => null);
  if (!f) return res.status(404).type('text').send('ลิงก์หมดอายุหรือไม่พบไฟล์ กรุณากดดาวน์โหลดใหม่');
  res.set('Cache-Control', 'no-store'); res.download(f.file, f.name);
});
app.get('/api/backup/job/:id', async (req, res) => {
  const j = FB.jobStatus(req.params.id); if (!j) return res.status(404).json({ error: 'ไม่พบงาน' });
  // M5 (Security Review): job id เป็น capability สุ่ม 128-bit — ให้เจ้าของ(_SUPER_)/ผู้ล็อกอินเห็น log เต็ม แต่ caller นิรนามเห็นแค่ summary เพื่อไม่ให้รั่ว raw PG/path error ขณะยังpoll ต่อได้หลังกู้คืน
  let privileged = false;
  try { privileged = !!(await withCtx(async ctx => { await P.initSecret(ctx); const r = await P.authUser(ctx, bearer(req)); return r.user && await P.isSuper(ctx, r.user); })); } catch (e) { privileged = false; }
  const out = privileged ? j : { id: j.id, type: j.type, state: j.state, step: j.step, startedAt: j.startedAt, finishedAt: j.finishedAt, file: j.file, source: j.source, error: j.error ? 'เกิดข้อผิดพลาดในการสำรอง/กู้คืน (ติดต่อ Super Admin เพื่อดูรายละเอียด)' : '' };
  res.set('Cache-Control', 'no-store').json(out);
});
const meta = req => ({ ip: clientIp(req), agent: String(req.get('user-agent') || '').slice(0, 300) });
app.post('/api/call/:fn', (req, res) => send(res, callApi(bearer(req), String(req.get('x-tenant-id') || ''), req.params.fn, (req.body || {}).args, meta(req))));
// กันสมัครถี่เกินไป: 1 IP สมัครได้ไม่เกิน SIGNUP_PER_HOUR ครั้ง/ชั่วโมง (ค่าเริ่มต้น 5)
const SIGNUPS = new Map();
function signupLimited(ip) {
  const now = Date.now(), lim = Number(process.env.SIGNUP_PER_HOUR || 5), l = (SIGNUPS.get(ip) || []).filter(t => now - t < 3600e3);
  if (l.length >= lim) return true; l.push(now); SIGNUPS.set(ip, l); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of SIGNUPS) if (!l.some(t => now - t < 3600e3)) SIGNUPS.delete(k); }, 600e3).unref();
app.post('/api/public/:fn', (req, res) => {
  if (req.params.fn === 'signup' && signupLimited(clientIp(req))) return res.status(429).json({ error: 'สมัครบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
  send(res, callPublic(req.params.fn, (req.body || {}).args, meta(req)));
});
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

async function start() {
  // fail-fast: ตัวเซ็น session token ต้องมากจาก .env เท่านั้น (Security Review C2 — ไม่เก็บสำเนาในฐานข้อมูล/ไฟล์สำรองอีก)
  if (!/^[0-9a-f]{64,128}$/i.test(String(process.env.TOKEN_SECRET || ''))) {
    console.error('ไม่สามารถเริ่มระบบได้: ยังไม่ได้ตั้งค่า TOKEN_SECRET ในไฟล์ .env (hex ยาว 64-128 ตัว)\n  สร้างค่าใหม่ด้วย: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"  แล้ววางใน .env และรีสตาร์ท — ดู README หัวข้อ ความปลอดภัย');
    process.exit(1);
  }
  await migrate();
  await withCtx(ctx => initSecret(ctx));   // ล้างสำเนาเก่าใน app_settings (ถ้ามี) + เตรียมคีย์
  // ตรวจก่อนว่าดิสก์/NAS เชื่อมต่อแล้ว (ถ้ายังไม่ได้ mount จะไม่สร้างโฟลเดอร์ลงดิสก์ผิดลูก)
  if ((await storageCheck(pool)).ok) console.log('Storage', await storage.check().catch(e => 'ERROR ' + e.message));
  setInterval(() => { const was = storageState().ok; storageCheck(pool).then(r => { if (r.ok && !was) { console.log('Storage กลับมาใช้งานได้'); storage.check().catch(() => {}); } }).catch(() => {}); }, 60e3).unref();   // ตรวจซ้ำทุก 1 นาที (NAS หลุด/กลับมา)
  if (!/^(0|false|off)$/i.test(process.env.CRON || '')) {
    // แจ้งเตือน License ทุกวัน 08:00 (เดิม: installLicenseTrigger)
    cron.schedule(process.env.LICENSE_CRON || '0 8 * * *', () => withCtx(ctx => licenseNotices(ctx)).then(r => console.log('license notices', r)).catch(e => console.error('license cron', e)), { timezone: TZ });
    // สำรองข้อมูลเป็น JSON ทุกวัน 02:00 (เดิม: installBackupTrigger)
    // ลบไฟล์ในถังขยะที่เก็บครบ TRASH_KEEP_DAYS วันแล้ว ทุกวัน 03:00
    cron.schedule(process.env.TRASH_CRON || '0 3 * * *', () => withCtx(ctx => purgeExpired(ctx)).then(r => console.log('trash purge', r)).catch(e => console.error('trash cron', e)), { timezone: TZ });
    // สำรองข้อมูลทั้งระบบ (ฐานข้อมูล + Storage) ลง Backups/full ตามเวลาที่ตั้งในหน้าเว็บ (ค่าเริ่มต้นจาก FULL_BACKUP_CRON = ทุกคืน 01:00)
    FB.startScheduler();
    cron.schedule(process.env.MAINT_CRON || '30 3 * * *', () => withCtx(ctx => dailyMaintenance(ctx)).then(r => console.log('maintenance', JSON.stringify(r))).catch(e => console.error('maintenance cron', e)), { timezone: TZ });
    cron.schedule(process.env.BACKUP_CRON || '0 2 * * *', () => backupToStorage(pool).then(r => console.log('backup', r)).catch(e => console.error('backup cron', e)), { timezone: TZ });
  }
  const server = app.listen(PORT, () => console.log('DocFlow listening on :' + PORT));
  // ปิดระบบอย่างนุ่มนวล (docker compose stop / restart): หยุดรับคำขอใหม่ รอคำขอที่ค้างเสร็จ แล้วปิดการเชื่อมต่อฐานข้อมูล
  // (ใน Docker แอปเป็น PID 1 ถ้าไม่ดักสัญญาณนี้ Docker จะรอ 10 วินาทีแล้วบังคับปิด)
  let stopping = false;
  const shutdown = sig => {
    if (stopping) return; stopping = true;
    console.log('ได้รับ ' + sig + ' — กำลังปิดระบบ…');
    try { require('./telegram').stop(); } catch (e) {}
    setTimeout(() => process.exit(0), 8000).unref();
    server.close(() => Promise.resolve().then(() => pool.end()).catch(() => {}).finally(() => process.exit(0)));
    for (const s of hub.sockets ? hub.sockets() : []) { try { s.end(); } catch (e) {} }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  require('./telegram').start();   // แจ้งเตือน/ตอบแชทผ่าน Telegram (ถ้าตั้ง TELEGRAM_BOT_TOKEN)
}
start().catch(e => { console.error(e); process.exit(1); });
