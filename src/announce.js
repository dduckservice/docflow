// ============================================================
//  announce.js — ประกาศจาก Super Admin ถึงผู้ใช้ทุกคน (เช่น แจ้งปิดปรับปรุงระบบ 00.00–06.00)
//  ผู้ใช้เห็นเป็นแถบประกาศด้านบน + หน้าต่างเด้งให้กด "รับทราบ" · ส่งถึงหน้าเว็บที่เปิดอยู่ทันทีผ่าน SSE
// ============================================================
const hub = require('./hub');
const { fail, tsOut } = require('./util');

const LEVELS = ['info', 'maint', 'urgent'];
// รับค่าจาก <input type="datetime-local"> (เวลาไทย) หรือ ISO
function parseTs(v, def) {
  v = String(v || '').trim();
  if (!v) return def;
  if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d)?$/.test(v)) v = v + (v.length === 16 ? ':00' : '') + '+07:00';
  const d = new Date(v);
  if (isNaN(d.getTime())) fail('รูปแบบวันเวลาไม่ถูกต้อง');
  return d;
}
const out = (a, extra) => ({ id: String(a.id), message: a.message, level: a.level, popup: a.popup,
  startsAt: new Date(a.startsAt).toISOString(), endsAt: a.endsAt ? new Date(a.endsAt).toISOString() : '',
  startsTh: tsOut(a.startsAt), endsTh: a.endsAt ? tsOut(a.endsAt) : '', createdName: a.createdName || '', createdTh: tsOut(a.createdAt), ...extra });

// ประกาศที่กำลังแสดงอยู่ (สำหรับผู้ใช้ทุกคน รวมผู้ที่ License หมดอายุ)
async function announceActive(ctx) {
  const l = await ctx.all(`SELECT a.*, (r.user_id IS NOT NULL) AS read FROM announcements a
      LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1
     WHERE a.stopped_at IS NULL AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
     ORDER BY a.created_at DESC LIMIT 10`, [ctx.user.id]);
  return l.map(a => out(a, { read: !!a.read }));
}
async function announceRead(ctx, id) {
  await ctx.exec('INSERT INTO announcement_reads (announcement_id, user_id) SELECT id, $2 FROM announcements WHERE id = $1 ON CONFLICT DO NOTHING', [String(id).replace(/\D/g, '').slice(0, 15) || 0, ctx.user.id]);
  return true;
}
// ---- Super Admin ----
async function announceList(ctx) {
  const total = (await ctx.one("SELECT count(*)::int AS n FROM users WHERE status = 'active'")).n;
  const l = await ctx.all(`SELECT a.*, (SELECT count(*)::int FROM announcement_reads r WHERE r.announcement_id = a.id) AS reads
      FROM announcements a ORDER BY a.created_at DESC LIMIT 50`);
  const now = Date.now();
  return { total, items: l.map(a => out(a, { reads: a.reads,
    state: a.stoppedAt ? 'stopped' : new Date(a.startsAt).getTime() > now ? 'scheduled' : (a.endsAt && new Date(a.endsAt).getTime() <= now) ? 'ended' : 'live' })) };
}
async function announceSave(ctx, f) {
  f = f || {};
  const msg = String(f.message || '').trim().slice(0, 2000);
  if (!msg) fail('กรุณาพิมพ์ข้อความประกาศ');
  const level = LEVELS.includes(f.level) ? f.level : 'info';
  const st = parseTs(f.startsAt, new Date()), en = parseTs(f.endsAt, null);
  if (en && en <= st) fail('เวลาสิ้นสุดต้องหลังเวลาเริ่มแสดง');
  if (en && en.getTime() <= Date.now()) fail('เวลาสิ้นสุดต้องเป็นเวลาในอนาคต');
  const r = await ctx.one(`INSERT INTO announcements (message, level, starts_at, ends_at, popup, created_by, created_name)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [msg, level, st, en, f.popup !== false, ctx.user.id, ctx.user.displayName || ctx.user.username]);
  await ctx.exec('INSERT INTO announcement_reads (announcement_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [r.id, ctx.user.id]);
  const delay = st.getTime() - Date.now();
  ctx.afterCommit(() => {
    hub.toAll({ type: 'announce' });
    if (delay > 0 && delay < 2 ** 31 - 1) setTimeout(() => hub.toAll({ type: 'announce' }), delay + 500).unref();   // ถึงเวลาเริ่มแสดง → ส่งอีกครั้ง
  });
  return { id: String(r.id) };
}
async function announceStop(ctx, id) {
  await ctx.exec('UPDATE announcements SET stopped_at = now() WHERE id = $1 AND stopped_at IS NULL', [String(id).replace(/\D/g, '').slice(0, 15) || 0]);
  ctx.afterCommit(() => hub.toAll({ type: 'announce' }));
  return true;
}
async function announceDelete(ctx, id) {
  await ctx.exec('DELETE FROM announcements WHERE id = $1', [String(id).replace(/\D/g, '').slice(0, 15) || 0]);
  ctx.afterCommit(() => hub.toAll({ type: 'announce' }));
  return true;
}
module.exports = { announceActive, announceRead, announceList, announceSave, announceStop, announceDelete };
