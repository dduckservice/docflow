// ============================================================
//  monitor.js — เมนู "ติดตามผู้ใช้งาน" (สถานะออนไลน์ / การเข้าใช้งาน / สถิติ)
//  Super Admin เห็นทุกคน · Admin และผู้ตรวจสอบเห็นเฉพาะผู้ใช้ที่ตนสร้าง + ตัวเอง
//  ออนไลน์ = เปิดหน้าเว็บอยู่ (เชื่อมต่อแจ้งเตือนค้างไว้) หรือมีการใช้งานภายใน 2 นาที
// ============================================================
const hub = require('./hub');
const { tsOut } = require('./util');
const P = () => require('./platform');

const ONLINE_MS = 2 * 60 * 1000;
function device(ua) {
  ua = String(ua || '');
  if (!ua) return '';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'อื่นๆ';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [br, os].filter(Boolean).join(' · ');
}
async function monitorUsers(ctx) {
  const sup = await P().superIdsPublic(ctx), meSuper = sup.has(String(ctx.user.id));
  const ids = await P().managedIds(ctx);   // null = ทุกคน
  const scope = u => !ids || ids.has(String(u.id)) || String(u.id) === String(ctx.user.id);
  const users = (await ctx.all('SELECT * FROM users ORDER BY username')).filter(scope);
  const uidList = users.map(u => u.id);
  const names = users.map(u => String(u.username));
  const online = hub.onlineIds(), now = Date.now();
  const tenants = await ctx.all('SELECT id, company_name FROM tenants');
  const tn = id => (tenants.find(x => String(x.id) === id) || {}).companyName;
  // นับต่อผู้ใช้ 7 วัน
  const logins7 = {}, acts7 = {};
  (await ctx.all("SELECT user_id, count(*)::int n FROM login_events WHERE ok AND at > now() - interval '7 days' AND user_id = ANY($1::uuid[]) GROUP BY user_id", [uidList])).forEach(r => { logins7[String(r.userId)] = r.n; });
  (await ctx.all("SELECT username, count(*)::int n FROM audit_log WHERE ts > now() - interval '7 days' AND username = ANY($1) GROUP BY username", [names])).forEach(r => { acts7[r.username] = r.n; });
  const rows = users.map(u => {
    const seen = u.lastSeen ? new Date(u.lastSeen).getTime() : 0;
    const st = u.status !== 'active' ? 'disabled' : (online.has(String(u.id)) || now - seen < ONLINE_MS) ? 'online' : (now - seen < 864e5 ? 'today' : now - seen < 7 * 864e5 ? 'week' : 'idle');
    const lic = P().licenseOf(u, sup.has(String(u.id)));
    return { id: String(u.id), username: u.username, name: u.displayName || u.username, role: u.role, isSuper: sup.has(String(u.id)), status: st, avatar: P().avatarUrl(u),
      lastSeen: seen ? new Date(seen).toISOString() : '', lastSeenTh: seen ? tsOut(u.lastSeen) : '', lastLogin: u.lastLogin ? tsOut(u.lastLogin) : '',
      ip: u.lastIp || '', device: device(u.lastAgent), companies: String(u.tenantIds).trim() === '*' ? ['ทุกบริษัท'] : String(u.tenantIds || '').split(',').map(x => tn(x.trim())).filter(Boolean),
      tenantIds: String(u.tenantIds).trim() === '*' ? '*' : String(u.tenantIds || '').split(',').map(x => x.trim()).filter(Boolean),
      logins7: logins7[String(u.id)] || 0, actions7: acts7[u.username] || 0,
      license: { state: lic.state, expire: lic.expire, daysLeft: lic.daysLeft, trial: /ทดลองใช้/.test(lic.note) } };
  });
  // ผู้ใช้งานรายวัน 14 วัน (คนที่ล็อกอิน หรือมีการบันทึก/แก้ไขในวันนั้น)
  const daily = await ctx.all(`SELECT d::date AS day, count(DISTINCT who)::int AS users FROM (
      SELECT (at AT TIME ZONE 'Asia/Bangkok')::date AS d, username AS who FROM login_events WHERE ok AND at > now() - interval '15 days' AND username = ANY($1)
      UNION ALL SELECT (ts AT TIME ZONE 'Asia/Bangkok')::date, username FROM audit_log WHERE ts > now() - interval '15 days' AND username = ANY($1)
    ) x GROUP BY d ORDER BY d`, [names]);
  const logDaily = await ctx.all(`SELECT (at AT TIME ZONE 'Asia/Bangkok')::date AS day, count(*) FILTER (WHERE ok)::int AS ok, count(*) FILTER (WHERE NOT ok)::int AS fail
    FROM login_events WHERE at > now() - interval '15 days' AND (username = ANY($1) OR ($2 AND user_id IS NULL)) GROUP BY 1 ORDER BY 1`, [names, meSuper]);
  // กิจกรรมรายชั่วโมงวันนี้
  const hourly = await ctx.all(`SELECT extract(hour FROM t AT TIME ZONE 'Asia/Bangkok')::int AS h, count(*)::int AS n FROM (
      SELECT at AS t FROM login_events WHERE ok AND username = ANY($1) AND (at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date
      UNION ALL SELECT ts FROM audit_log WHERE username = ANY($1) AND (ts AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date
    ) x GROUP BY 1`, [names]);
  const events = (await ctx.all(`SELECT * FROM login_events WHERE (username = ANY($1) OR ($2 AND user_id IS NULL)) ORDER BY at DESC LIMIT 30`, [names, meSuper]))
    .map(e => ({ at: tsOut(e.at), atIso: new Date(e.at).toISOString(), username: e.username, ok: e.ok, ip: e.ip || '', device: device(e.agent), note: e.note || '' }));
  const failToday = await ctx.one(`SELECT count(*)::int AS n FROM login_events WHERE NOT ok AND (at AT TIME ZONE 'Asia/Bangkok')::date = (now() AT TIME ZONE 'Asia/Bangkok')::date AND (username = ANY($1) OR ($2 AND user_id IS NULL))`, [names, meSuper]);
  // จำนวนบริษัทในระบบ — เฉพาะ Super Admin
  let companies = null;
  if (meSuper) {
    const tl = await ctx.all(`SELECT t.id, t.company_name, t.status, t.created_at, t.created_by AS creator_id, cu.username AS creator, COALESCE(cu.display_name, cu.username) AS creator_name,
        (SELECT count(*)::int FROM documents d WHERE d.tenant_id = t.id) AS docs,
        (SELECT count(*)::int FROM expenses e WHERE e.tenant_id = t.id) AS expenses,
        (SELECT max(ts) FROM audit_log a WHERE a.tenant_id = t.id) AS last_act,
        (SELECT count(*)::int FROM audit_log a WHERE a.tenant_id = t.id AND a.ts > now() - interval '7 days') AS acts7
      FROM tenants t LEFT JOIN users cu ON cu.id = t.created_by ORDER BY t.created_at`);
    const list = tl.map(t => ({ id: String(t.id), name: t.companyName, status: t.status, createdAt: tsOut(t.createdAt), new7: now - new Date(t.createdAt).getTime() < 7 * 864e5,
      creator: t.creator || '', creatorId: t.creatorId ? String(t.creatorId) : '', creatorName: t.creatorName || t.creator || '',
      docs: t.docs, expenses: t.expenses, lastAct: t.lastAct ? new Date(t.lastAct).toISOString() : '', lastActTh: t.lastAct ? tsOut(t.lastAct) : '', acts7: t.acts7 }));
    companies = { total: list.length, new7: list.filter(x => x.new7).length, list };
  }
  const ymd = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  return { users: rows, daily: daily.map(r => ({ day: ymd(r.day), users: r.users })), logins: logDaily.map(r => ({ day: ymd(r.day), ok: r.ok, fail: r.fail })),
    hourly: hourly.map(r => ({ h: r.h, n: r.n })), events, failToday: failToday.n, companies, delReq: meSuper ? await require('./delreq').pendingSummary(ctx) : null, upReq: meSuper ? await require('./upgrade').pendingSummary(ctx) : null, disk: meSuper ? await require('./maint').diskInfo() : null, now: new Date().toISOString() };
}
module.exports = { monitorUsers };
