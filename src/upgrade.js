// ============================================================
//  upgrade.js — คำขอเพิ่มสิทธิ์จากผู้ใช้ → Super Admin อนุมัติ
//  - ผู้ใช้ (เจ้าของบัญชี) กด "ขอเพิ่มบริษัท" หรือ "ขอเพิ่มผู้ใช้" เมื่อใช้โควตาครบ
//  - Super Admin เห็นที่หน้า "ติดตามผู้ใช้งาน" (การ์ด "คำขอเพิ่มสิทธิ์") + แจ้งเตือนทันที / Telegram
//  - อนุมัติ = เพิ่มโควตาให้ผู้ขอตามจำนวนที่อนุมัติ · ปฏิเสธ = แจ้งผู้ขอพร้อมหมายเหตุ
// ============================================================
const hub = require('./hub');
const { fail, tsOut, clean } = require('./util');
const P = () => require('./platform');
const TG = () => require('./telegram');

const KIND_TH = { company: 'เพิ่มบริษัท', user: 'เพิ่มผู้ใช้' };
const UNIT_TH = { company: 'บริษัท', user: 'คน' };
const STATUS_TH = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิกแล้ว' };
const who = ctx => String(ctx.user.displayName || ctx.user.username);
const out = r => ({ id: String(r.id), kind: r.kind, kindTh: KIND_TH[r.kind] || r.kind, unitTh: UNIT_TH[r.kind] || '',
  amount: r.amount, reason: r.reason || '', status: r.status, statusTh: STATUS_TH[r.status] || r.status,
  requestedBy: String(r.requestedBy), requestedName: r.requestedName || '', requestedAt: tsOut(r.requestedAt),
  decidedName: r.decidedName || '', decidedAt: r.decidedAt ? tsOut(r.decidedAt) : '', granted: r.granted, note: r.decisionNote || '' });

// ---------- ฝั่งผู้ขอ ----------
async function requestUpgrade(ctx, kind, amount, reason) {
  kind = String(kind || '');
  if (!['company', 'user'].includes(kind)) fail('ประเภทคำขอไม่ถูกต้อง');
  if (await P().isSuper(ctx, ctx.user)) fail('Super Admin เพิ่มได้เองโดยตรง ไม่ต้องส่งคำขอ');
  amount = Math.floor(Number(amount) || 1);
  if (!Number.isFinite(amount) || amount < 1 || amount > 999) fail('จำนวนที่ขอต้องอยู่ระหว่าง 1 ถึง 999');
  reason = clean(reason, 500);
  await ctx.lock('upgrade');
  if (await ctx.one("SELECT id FROM upgrade_requests WHERE kind = $1 AND requested_by = $2 AND status = 'pending'", [kind, ctx.user.id]))
    fail('คุณมีคำขอประเภทนี้รออนุมัติอยู่แล้ว กรุณารอ Super Admin พิจารณา');
  const r = await ctx.one(`INSERT INTO upgrade_requests (kind, amount, reason, requested_by, requested_name) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [kind, amount, reason || null, ctx.user.id, who(ctx)]);
  const by = who(ctx), label = KIND_TH[kind], unit = UNIT_TH[kind];
  // โพสต์เข้ากล่องข้อความให้ Super Admin เห็นในแชทด้วย
  try { await require('./chat').postUserNote(ctx, `⬆️ [คำขอ${label}] ขอเพิ่ม ${amount} ${unit}${reason ? ' — เหตุผล: ' + reason : ''}\n(ส่งจากปุ่มขอเพิ่มสิทธิ์ · พิจารณาได้ที่เมนู "ติดตามผู้ใช้งาน")`); } catch (e) { console.warn('upgrade chat note:', e.message); }
  ctx.afterCommit(() => {
    hub.toSupers({ type: 'upgrade', action: 'new', kind, by, amount });
    TG().notifyText(`⬆️ <b>คำขอ${label}</b>\n👤 โดย ${by}\n➕ ขอเพิ่ม ${amount} ${unit}\n${reason ? '📝 ' + reason + '\n' : ''}\nอนุมัติหรือปฏิเสธได้ที่เมนู "ติดตามผู้ใช้งาน" ในระบบ DocFlow`);
  });
  return out(r);
}
async function myUpgradeRequests(ctx) {
  return (await ctx.all('SELECT * FROM upgrade_requests WHERE requested_by = $1 ORDER BY requested_at DESC LIMIT 20', [ctx.user.id])).map(out);
}
async function cancelUpgradeRequest(ctx, id) {
  const r = await ctx.one('SELECT * FROM upgrade_requests WHERE id = $1 AND requested_by = $2', [Number(id) || 0, ctx.user.id]);
  if (!r) fail('ไม่พบคำขอ');
  if (r.status !== 'pending') fail('คำขอนี้ดำเนินการไปแล้ว ยกเลิกไม่ได้');
  await ctx.exec("UPDATE upgrade_requests SET status = 'cancelled', decided_at = now(), decided_name = $2 WHERE id = $1", [r.id, who(ctx)]);
  ctx.afterCommit(() => hub.toSupers({ type: 'upgrade', action: 'cancelled', kind: r.kind }));
  return true;
}

// ---------- ฝั่ง Super Admin ----------
async function listUpgradeRequests(ctx) {
  await P().superOnly(ctx);
  const rows = (await ctx.all("SELECT * FROM upgrade_requests ORDER BY (status = 'pending') DESC, requested_at DESC LIMIT 100")).map(out);
  for (const r of rows.filter(x => x.status === 'pending')) {   // แสดงโควตาปัจจุบันของผู้ขอ
    const u = await ctx.one('SELECT * FROM users WHERE id = $1', [r.requestedBy]);
    if (!u) { r.gone = true; continue; }
    if (r.kind === 'company') { const lim = await P().companyLimitOf(ctx, u), used = await P().companyCount(ctx, u.id); r.cur = { used, limit: lim === Infinity ? -1 : lim }; }
    else { const lim = await P().createLimitOfPublic(ctx, u), used = await P().createdCountPublic(ctx, u.id); r.cur = { used, limit: lim === Infinity ? -1 : lim }; }
  }
  return rows;
}
async function decideUpgradeRequest(ctx, id, approve, grant, note) {
  await P().superOnly(ctx);
  await ctx.lock('upgrade');
  const r = await ctx.one('SELECT * FROM upgrade_requests WHERE id = $1', [Number(id) || 0]);
  if (!r) fail('ไม่พบคำขอ');
  if (r.status !== 'pending') fail('คำขอนี้ดำเนินการไปแล้ว');
  note = clean(note, 500);
  const uid = String(r.requestedBy), kind = r.kind;
  if (!approve) {
    await ctx.exec("UPDATE upgrade_requests SET status = 'rejected', decided_by = $2, decided_name = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [r.id, ctx.user.id, who(ctx), note || null]);
    ctx.afterCommit(() => { hub.toUser(uid, { type: 'upgrade', action: 'rejected', kind, note }); hub.toSupers({ type: 'upgrade', action: 'decided', kind }); });
    return { status: 'rejected' };
  }
  // อนุมัติ: เพิ่มโควตาของผู้ขอตามจำนวนที่อนุมัติ (grant) — ตั้งโควตาใหม่ = โควตาปัจจุบัน + grant
  grant = Math.floor(Number(grant) || r.amount);
  if (!Number.isFinite(grant) || grant < 1 || grant > 999) fail('จำนวนที่อนุมัติต้องอยู่ระหว่าง 1 ถึง 999');
  const u = await ctx.one('SELECT * FROM users WHERE id = $1', [uid]);
  if (!u) fail('ไม่พบผู้ใช้ที่ส่งคำขอ (อาจถูกลบไปแล้ว)');
  const col = kind === 'company' ? 'company_quota' : 'user_quota';
  const curLimit = kind === 'company' ? await P().companyLimitOf(ctx, u) : await P().createLimitOfPublic(ctx, u);
  let newQ;
  if (curLimit === Infinity) newQ = -1;   // ไม่จำกัดอยู่แล้ว
  else newQ = curLimit + grant;
  await ctx.exec(`UPDATE users SET ${col} = $2 WHERE id = $1`, [uid, newQ]);
  await ctx.exec("UPDATE upgrade_requests SET status = 'approved', decided_by = $2, decided_name = $3, decided_at = now(), granted = $4, decision_note = $5 WHERE id = $1", [r.id, ctx.user.id, who(ctx), grant, note || null]);
  const newLimit = newQ === -1 ? -1 : newQ;
  ctx.afterCommit(() => {
    hub.toUser(uid, { type: 'upgrade', action: 'approved', kind, grant, limit: newLimit, note });
    hub.toUser(uid, { type: 'quota', scope: kind, limit: newLimit });
    hub.toSupers({ type: 'upgrade', action: 'decided', kind });
  });
  return { status: 'approved', grant, newLimit };
}
async function pendingSummary(ctx) {
  const rows = await ctx.all("SELECT kind, count(*)::int AS n FROM upgrade_requests WHERE status = 'pending' GROUP BY kind");
  const by = {}; rows.forEach(r => { by[r.kind] = r.n; });
  return { pending: (by.company || 0) + (by.user || 0), company: by.company || 0, user: by.user || 0 };
}
module.exports = { requestUpgrade, myUpgradeRequests, cancelUpgradeRequest, listUpgradeRequests, decideUpgradeRequest, pendingSummary };
