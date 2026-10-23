// ============================================================
//  delreq.js — คำขอลบบริษัท (ผู้ใช้ขอ → Super Admin อนุมัติ/ปฏิเสธ)
//  - ผู้ดูแล / ผู้ตรวจสอบ กด "ขอลบ" ที่การ์ดบริษัท → สร้างคำขอ (พิมพ์ชื่อบริษัทยืนยัน + เหตุผล)
//  - Super Admin เห็นที่หน้า "ติดตามผู้ใช้งาน" (การ์ด "คำขอลบรออนุมัติ") + แจ้งเตือนทันที / Telegram
//  - อนุมัติ = ลบบริษัทจริง (สำรองข้อมูลก่อนลบอัตโนมัติ) · ปฏิเสธ = แจ้งผู้ขอพร้อมหมายเหตุ
//  - ผู้ขอเห็นสถานะคำขอที่หน้า "บริษัทของฉัน" และได้รับแจ้งเตือนทันทีเมื่อมีผล
// ============================================================
const hub = require('./hub');
const { fail, tsOut, clean } = require('./util');
const P = () => require('./platform');
const TG = () => require('./telegram');

const { withCtx } = require('./db');
const CX = () => require('./coexport');
const STATUS_TH = { processing: 'กำลังเตรียมไฟล์และลบ', pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว (ลบแล้ว)', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิกแล้ว' };
const who = ctx => String(ctx.user.displayName || ctx.user.username);
const out = r => ({ id: String(r.id), kind: r.kind, targetId: String(r.targetId), targetName: r.targetName, reason: r.reason || '', status: r.status, statusTh: STATUS_TH[r.status] || r.status,
  requestedBy: String(r.requestedBy), requestedName: r.requestedName || '', requestedAt: tsOut(r.requestedAt), requestedIso: new Date(r.requestedAt).toISOString(),
  decidedName: r.decidedName || '', decidedAt: r.decidedAt ? tsOut(r.decidedAt) : '', note: r.decisionNote || '' });
async function companyName(ctx, id) {
  const t = await ctx.one('SELECT t.id, COALESCE(p.company_name, t.company_name) AS name FROM tenants t LEFT JOIN company_profiles p ON p.tenant_id = t.id WHERE t.id::text = $1', [String(id || '')]);
  return t ? String(t.name) : null;
}

// ---------- ฝั่งผู้ขอ ----------
async function requestDeleteTenant(ctx, tenantId, confirmName, reason) {
  if (await P().isSuper(ctx, ctx.user)) fail('Super Admin ลบบริษัทได้ทันทีที่ปุ่มลบ ไม่ต้องส่งคำขอ');
  await ctx.lock('registry');
  const allowed = await P().allowedTenantsPublic(ctx, ctx.user);
  if (!allowed.some(t => t.id === String(tenantId))) fail('ไม่มีสิทธิ์เข้าถึงบริษัทนี้');
  const name = await companyName(ctx, tenantId);
  if (!name) fail('ไม่พบบริษัท');
  if (String(confirmName || '').trim() !== name.trim()) fail('ชื่อบริษัทที่พิมพ์ยืนยันไม่ตรงกัน');
  reason = clean(reason, 500);
  if (!reason) fail('กรุณาระบุเหตุผลที่ต้องการลบ');
  if (await ctx.one("SELECT id FROM delete_requests WHERE kind = 'tenant' AND target_id = $1 AND status IN ('pending','processing')", [tenantId])) fail('มีคำขอลบบริษัทนี้รออนุมัติอยู่แล้ว');
  const r = await ctx.one(`INSERT INTO delete_requests (kind, target_id, target_name, reason, requested_by, requested_name) VALUES ('tenant',$1,$2,$3,$4,$5) RETURNING *`,
    [tenantId, name, reason, ctx.user.id, who(ctx)]);
  await ctx.exec('INSERT INTO audit_log (tenant_id, document_id, action, detail, username) VALUES ($1,$2,$3,$4,$5)', [tenantId, 'TENANT:' + tenantId, 'DELETE_REQUEST', reason, ctx.username()]);
  const by = who(ctx);
  ctx.afterCommit(() => {
    hub.toSupers({ type: 'delreq', action: 'new', name, by });
    TG().notifyText(`🗑 <b>คำขอลบบริษัท</b>\n🏢 ${name}\n👤 โดย ${by}\n📝 ${reason}\n\nอนุมัติหรือปฏิเสธได้ที่เมนู "ติดตามผู้ใช้งาน" ในระบบ DocFlow`);
  });
  return out(r);
}
async function myDeleteRequests(ctx) {
  const l = (await ctx.all('SELECT * FROM delete_requests WHERE requested_by = $1 ORDER BY requested_at DESC LIMIT 20', [ctx.user.id])).map(out);
  for (const r of l) if (r.status === 'approved' || r.status === 'processing') r.export = await CX().exportForRequest(r.id);
  return l;
}
async function cancelDeleteRequest(ctx, id) {
  const r = await ctx.one("SELECT * FROM delete_requests WHERE id = $1 AND requested_by = $2", [Number(id) || 0, ctx.user.id]);
  if (!r) fail('ไม่พบคำขอ');
  if (r.status !== 'pending') fail('คำขอนี้ดำเนินการไปแล้ว ยกเลิกไม่ได้');
  await ctx.exec("UPDATE delete_requests SET status = 'cancelled', decided_at = now(), decided_name = $2 WHERE id = $1", [r.id, who(ctx)]);
  ctx.afterCommit(() => hub.toSupers({ type: 'delreq', action: 'cancelled', name: r.targetName }));
  return true;
}

// ---------- ฝั่ง Super Admin ----------
async function listDeleteRequests(ctx) {
  await P().superOnly(ctx);
  const rows = (await ctx.all("SELECT * FROM delete_requests ORDER BY (status IN ('pending','processing')) DESC, requested_at DESC LIMIT 100")).map(out);
  for (const r of rows.filter(x => x.status === 'approved' || x.status === 'processing')) r.export = await CX().exportForRequest(r.id);
  for (const r of rows.filter(x => x.status === 'pending')) {   // ขนาดข้อมูลของบริษัทที่จะถูกลบ
    const c = await ctx.one(`SELECT (SELECT count(*)::int FROM documents WHERE tenant_id::text = $1) AS docs, (SELECT count(*)::int FROM expenses WHERE tenant_id::text = $1) AS expenses,
      (SELECT count(*)::int FROM uploads WHERE tenant_id::text = $1 AND status <> 'deleted') AS files, (SELECT count(*)::int FROM users WHERE tenant_ids LIKE $2) AS users`, [r.targetId, '%' + r.targetId + '%']);
    r.counts = c; r.exists = !!(await companyName(ctx, r.targetId)); r.downloaded = await CX().downloadedInfo(r.targetId);
  }
  return rows;
}
async function decideDeleteRequest(ctx, id, approve, note) {
  await P().superOnly(ctx);
  await ctx.lock('delreq');
  const r = await ctx.one('SELECT * FROM delete_requests WHERE id = $1', [Number(id) || 0]);
  if (!r) fail('ไม่พบคำขอ');
  if (r.status !== 'pending') fail('คำขอนี้ดำเนินการไปแล้ว');
  note = clean(note, 500);
  if (!approve) {
    await ctx.exec("UPDATE delete_requests SET status = 'rejected', decided_by = $2, decided_name = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [r.id, ctx.user.id, who(ctx), note || null]);
    const uid = String(r.requestedBy), name = r.targetName;
    ctx.afterCommit(() => { hub.toUser(uid, { type: 'delreq', action: 'rejected', name, note }); hub.toSupers({ type: 'delreq', action: 'rejected', name }); });
    return { status: 'rejected' };
  }
  // อนุมัติ: 1) สร้างไฟล์ข้อมูลทั้งบริษัทเก็บไว้ให้ลูกค้า 2) ลบบริษัท (สำรองทั้งระบบก่อนลบ) — ทำเบื้องหลัง
  await ctx.exec("UPDATE delete_requests SET status = 'processing', decided_by = $2, decided_name = $3, decided_at = now(), decision_note = $4 WHERE id = $1", [r.id, ctx.user.id, who(ctx), note || null]);
  const sup = ctx.user, rid = r.id;
  ctx.afterCommit(() => { hub.toSupers({ type: 'delreq', action: 'processing', name: r.targetName }); approveFlow(rid, sup).catch(e => console.error('approve delete', e)); });
  return { status: 'processing' };
}
async function approveFlow(rid, sup) {
  const r = await withCtx(ctx => ctx.one('SELECT * FROM delete_requests WHERE id = $1', [rid]));
  const uid = String(r.requestedBy), name = r.targetName;
  const back = async msg => {   // ไม่สำเร็จ → คืนสถานะรออนุมัติ พร้อมเหตุผล
    await withCtx(ctx => ctx.exec("UPDATE delete_requests SET status = 'pending', decision_note = $2 WHERE id = $1", [rid, msg]));
    hub.toSupers({ type: 'delreq', action: 'failed', name, note: msg });
  };
  let exportId = null;
  try {
    const exists = await withCtx(ctx => companyName(ctx, r.targetId));
    if (exists) exportId = await CX().start(String(r.targetId), exists, sup, rid, true);
  } catch (e) { return back('ยังไม่ได้ลบ: ' + e.message); }
  let result = null;
  try {
    result = await withCtx(async ctx => {
      ctx.user = sup; ctx.meta = {};
      const nm = await companyName(ctx, r.targetId);
      const x = nm ? await P().deleteTenant(ctx, String(r.targetId), nm) : null;
      await ctx.exec("UPDATE delete_requests SET status = 'approved', decided_at = now() WHERE id = $1", [rid]);
      return x;
    });
  } catch (e) { return back('ยังไม่ได้ลบ: ' + e.message); }
  hub.toUser(uid, { type: 'delreq', action: 'approved', name, exportId });
  hub.toSupers({ type: 'delreq', action: 'approved', name, backup: result ? result.backup : '' });
  return result;
}

// สำหรับหน้า "ติดตามผู้ใช้งาน"
async function pendingSummary(ctx) {
  const n = await ctx.one("SELECT count(*)::int AS n FROM delete_requests WHERE status IN ('pending','processing')");
  return { pending: n.n, pendingTenants: (await ctx.all("SELECT target_id FROM delete_requests WHERE status IN ('pending','processing')")).map(x => String(x.targetId)) };
}
module.exports = { requestDeleteTenant, myDeleteRequests, cancelDeleteRequest, listDeleteRequests, decideDeleteRequest, pendingSummary };
