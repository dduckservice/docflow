// ============================================================
//  coexport.js — ดาวน์โหลดข้อมูลทั้งบริษัทเป็นไฟล์ .zip (ส่งมอบข้อมูลให้ลูกค้า เช่น ก่อน/หลังเลิกกิจการ)
//  ในไฟล์ zip:
//    อ่านฉันก่อน.txt          รายละเอียดชุดข้อมูล
//    PDF/<ประเภท>/<เลขที่>.pdf  เอกสารทุกใบ (ขาย / ซื้อ / ค่าใช้จ่าย) สร้างใหม่จากข้อมูลล่าสุด
//    ไฟล์อัปโหลด/…             สลิป ใบเสร็จ สัญญา ฯลฯ ตามโฟลเดอร์เดิม
//    ข้อมูล (Excel)/*.csv      ตารางข้อมูลทั้งหมด เปิดด้วย Excel ได้ (UTF-8)
//    ข้อมูลบริษัท/…            ข้อมูลบริษัท + โลโก้ · data.json (ข้อมูลดิบทั้งหมด)
//  ไฟล์เก็บที่ Backups/exports และลบอัตโนมัติเมื่อครบ EXPORT_KEEP_DAYS วัน (ค่าเริ่มต้น 30)
// ============================================================
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pool, withCtx } = require('./db');
const storage = require('./storage');
const hub = require('./hub');
const { ZipWriter } = require('./zipwriter');
const { fail, tsOut, safeFolderName, csvCell, toCsv } = require('./util');
const P = () => require('./platform');
const PR = () => require('./print');

const ROOT = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'Backups'));
const DIR = path.join(ROOT, 'exports');
const KEEP_DAYS = Math.max(1, Number(process.env.EXPORT_KEEP_DAYS || 30));
const TYPE_TH = { quotation: 'ใบเสนอราคา', invoice: 'ใบวางบิล-ใบแจ้งหนี้', taxinvoice: 'ใบกำกับภาษี', receipt: 'ใบเสร็จรับเงิน', cashsale: 'ขายเงินสด',
  po: 'ใบสั่งซื้อ', gr: 'ใบรับสินค้า', expense: 'ค่าใช้จ่าย' };
const TABLE_TH = { company_profiles: 'ข้อมูลบริษัท', documents: 'เอกสารขาย', document_items: 'เอกสารขาย-รายการสินค้า', expenses: 'ค่าใช้จ่าย', expense_items: 'ค่าใช้จ่าย-รายการ',
  expense_categories: 'หมวดค่าใช้จ่าย', purchase_docs: 'ใบสั่งซื้อ-ใบรับสินค้า', purchase_items: 'ใบสั่งซื้อ-ใบรับสินค้า-รายการ', contacts: 'สมุดรายชื่อ', products: 'สินค้า-บริการ',
  uploads: 'ไฟล์อัปโหลด-รายการ', audit_log: 'ประวัติการแก้ไข' };
const PROGRESS = new Map();   // id → { step, done, total }
let CHAIN = Promise.resolve();  // สร้างทีละไฟล์ (PDF ใช้ Chromium หนัก)

const stamp = d => d.toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(/[-: ]/g, '').slice(0, 12);
const outRow = r => ({ id: String(r.id), tenantId: String(r.tenant_id), tenantName: r.tenant_name, status: r.status, fileName: r.file_name || '', size: Number(r.size) || 0,
  files: Number(r.files) || 0, createdName: r.created_name || '', createdAt: tsOut(r.created_at), readyAt: r.ready_at ? tsOut(r.ready_at) : '',
  expiresAt: r.expires_at ? tsOut(r.expires_at) : '', expiresIso: r.expires_at ? new Date(r.expires_at).toISOString() : '', downloads: Number(r.downloads) || 0,
  lastDownloadAt: r.last_download_at ? tsOut(r.last_download_at) : '', lastDownloadBy: r.last_download_by || '', error: r.error || '', requestId: r.request_id ? String(r.request_id) : '',
  progress: PROGRESS.get(String(r.id)) || null });

// ---------- สร้างไฟล์ ----------
async function build(id) {
  const row = (await pool.query('SELECT * FROM company_exports WHERE id = $1', [id])).rows[0];
  if (!row) return;
  const prog = { step: 'เตรียมข้อมูล', done: 0, total: 0 }; PROGRESS.set(String(id), prog);
  await fsp.mkdir(DIR, { recursive: true });
  const name = `${safeFolderName(row.tenant_name, 'company').slice(0, 60)}_ข้อมูลทั้งหมด_${stamp(new Date())}.zip`;
  const part = path.join(DIR, id + '.part'), final = path.join(DIR, id + '-' + name);
  const zip = new ZipWriter(part); const problems = [];
  try {
    const tid = String(row.tenant_id);
    const user = (await pool.query('SELECT * FROM users WHERE id = $1', [row.created_by])).rows[0];
    const asTenant = fn => withCtx(async ctx => { ctx.user = user ? Object.fromEntries(Object.entries(user).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()), v])) : null; ctx.tenantId = tid; return fn(ctx); });
    // 1) ตารางข้อมูล → CSV + data.json
    prog.step = 'ส่งออกตารางข้อมูล';
    const tcols = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'tenant_id'")).rows.map(r => r.table_name);
    const data = { app: 'docflow', exportedAt: new Date().toISOString(), company: row.tenant_name, tables: {} };
    for (const t of Object.keys(TABLE_TH).filter(x => tcols.includes(x))) {
      const rows = (await pool.query(`SELECT * FROM ${t} WHERE tenant_id = $1`, [tid])).rows;
      if (t === 'company_profiles') rows.forEach(r => { if (r.logo) { zip.add('ข้อมูลบริษัท/โลโก้.' + (/png/.test(r.logo_mime) ? 'png' : /webp/.test(r.logo_mime) ? 'webp' : 'jpg'), r.logo); } });
      data.tables[t] = rows.map(r => { const o = {}; for (const k of Object.keys(r)) o[k] = Buffer.isBuffer(r[k]) ? undefined : r[k]; return o; });
      zip.add(`ข้อมูล (Excel)/${TABLE_TH[t]}.csv`, toCsv(data.tables[t]));
    }
    zip.add('ข้อมูลบริษัท/data.json', JSON.stringify(data, null, 1));
    // 2) ไฟล์อัปโหลด
    const ups = (await pool.query("SELECT file_id, file_name FROM uploads WHERE tenant_id = $1 AND status <> 'deleted' AND file_id IS NOT NULL", [tid])).rows;
    prog.step = 'รวบรวมไฟล์อัปโหลด'; prog.total = ups.length; prog.done = 0;
    for (const u of ups) {
      try { const parts = String(u.file_id).split('/'); zip.add('ไฟล์อัปโหลด/' + (parts.length > 2 ? parts.slice(2).join('/') : parts.pop()), await storage.get(String(u.file_id))); }
      catch (e) { problems.push('ไฟล์อัปโหลด ' + (u.file_name || u.file_id) + ': ' + e.message); }
      prog.done++;
    }
    // 3) PDF ทุกเอกสาร (สร้างใหม่จากข้อมูลล่าสุด)
    const docs = [
      ...(await pool.query('SELECT id, number, type, status FROM documents WHERE tenant_id = $1 ORDER BY date, number', [tid])).rows,
      ...(await pool.query('SELECT id, number, type, status FROM purchase_docs WHERE tenant_id = $1 ORDER BY date, number', [tid])).rows,
      ...(await pool.query("SELECT id, number, 'expense' AS type, status FROM expenses WHERE tenant_id = $1 ORDER BY date, number", [tid])).rows ];
    prog.step = 'สร้าง PDF เอกสาร'; prog.total = docs.length; prog.done = 0;
    for (const d of docs) {
      try {
        const r = await asTenant(ctx => PR().renderPrintPublic(ctx, String(d.id), 'pdf'));
        const pdf = await PR().htmlToPdf(r.html);
        zip.add(`PDF/${TYPE_TH[d.type] || d.type}/${safeFolderName(d.number, 'doc')}${d.status === 'cancelled' ? ' (ยกเลิก)' : ''}.pdf`, pdf, { store: true });
      } catch (e) { problems.push('PDF ' + d.number + ': ' + e.message); }
      prog.done++;
    }
    // 4) อ่านฉันก่อน
    const cnt = t => (data.tables[t] || []).length;
    zip.add('อ่านฉันก่อน.txt', [
      `ข้อมูลทั้งหมดของบริษัท: ${row.tenant_name}`, `ส่งออกเมื่อ: ${tsOut(new Date())} (เวลาไทย) โดย ${row.created_name || '-'}`, '',
      'ในไฟล์นี้มี', `- PDF/  เอกสารทุกใบ ${docs.length} ฉบับ (ขาย ${cnt('documents')} · ซื้อ/รับสินค้า ${cnt('purchase_docs')} · ค่าใช้จ่าย ${cnt('expenses')})`,
      `- ไฟล์อัปโหลด/  ไฟล์แนบ ${ups.length} ไฟล์ (สลิป ใบเสร็จ สัญญา ฯลฯ)`, `- ข้อมูล (Excel)/  ตารางข้อมูลทั้งหมด (.csv เปิดด้วย Excel ได้)`,
      `- ข้อมูลบริษัท/  ข้อมูลบริษัท โลโก้ และ data.json (ข้อมูลดิบทั้งหมด สำหรับย้ายไประบบอื่น)`, '',
      'ข้อแนะนำ: ใบกำกับภาษี ใบเสร็จ และเอกสารบัญชี ต้องเก็บไว้ตามที่กฎหมายกำหนด (โดยทั่วไปอย่างน้อย 5 ปี)',
      'กรุณาเก็บไฟล์นี้ไว้ในที่ปลอดภัย และสำรองไว้มากกว่า 1 ที่',
      ...(problems.length ? ['', `หมายเหตุ: มี ${problems.length} รายการที่ส่งออกไม่สำเร็จ`, ...problems.slice(0, 50).map(x => '- ' + x)] : [])
    ].join('\r\n'));
    prog.step = 'บันทึกไฟล์';
    const r = zip.close();
    await fsp.rename(part, final);
    const size = (await fsp.stat(final)).size;
    await pool.query(`UPDATE company_exports SET status = 'ready', file_name = $2, size = $3, files = $4, ready_at = now(), expires_at = now() + ($5 || ' days')::interval, error = $6 WHERE id = $1`,
      [id, path.basename(final), size, r.files, String(KEEP_DAYS), problems.length ? problems.length + ' รายการส่งออกไม่สำเร็จ (ดูใน อ่านฉันก่อน.txt)' : null]);
  } catch (e) {
    zip.abort(); await fsp.unlink(part).catch(() => {});
    await pool.query("UPDATE company_exports SET status = 'error', error = $2 WHERE id = $1", [id, String(e.message).slice(0, 500)]);
    console.error('company export', e);
  } finally {
    PROGRESS.delete(String(id));
    const r2 = (await pool.query('SELECT * FROM company_exports WHERE id = $1', [id])).rows[0];
    if (r2) { hub.toUser(String(r2.created_by), { type: 'export', id: String(id), status: r2.status, name: r2.tenant_name }); hub.toSupers({ type: 'export', id: String(id), status: r2.status, name: r2.tenant_name }); }
  }
}
// เริ่มสร้าง (คืน id ทันที) · waitFor = รอจนเสร็จ (ใช้ตอนอนุมัติลบบริษัท)
async function start(tenantId, tenantName, user, requestId, waitFor) {
  const r = (await pool.query(`INSERT INTO company_exports (tenant_id, tenant_name, status, created_by, created_name, request_id) VALUES ($1,$2,'building',$3,$4,$5) RETURNING id`,
    [tenantId, tenantName, user.id, String(user.displayName || user.display_name || user.username), requestId || null])).rows[0];
  const id = String(r.id); PROGRESS.set(id, { step: 'รอคิว', done: 0, total: 0 });
  const p = CHAIN = CHAIN.then(() => build(id)).catch(async e => {
    // error ใดๆ ที่หลุดจาก build (เช่น DB ชั่วคราวใน finally) → ห้ามค้างสถานะ 'building' มิฉะนั้นจะปิดกั้นการส่งออกของเจ้านี้จนรีสตาร์ท
    console.error('company export chain:', e && e.stack || e);
    await pool.query("UPDATE company_exports SET status = 'error', error = $2 WHERE id = $1 AND status = 'building'", [id, String((e && e.message) || e).slice(0, 500)]).catch(() => {});
  });
  if (waitFor) { await p; const x = (await pool.query('SELECT * FROM company_exports WHERE id = $1', [id])).rows[0]; if (x.status !== 'ready') throw new Error('สร้างไฟล์ข้อมูลไม่สำเร็จ: ' + (x.error || '')); }
  return id;
}

// ---------- สิทธิ์ ----------
async function canAccess(ctx, row) {
  if (await P().isSuper(ctx, ctx.user)) return true;
  if (String(row.createdBy) === String(ctx.user.id)) return true;
  if (row.requestId && await ctx.one('SELECT 1 FROM delete_requests WHERE id = $1 AND requested_by = $2', [row.requestId, ctx.user.id])) return true;
  return (await P().allowedTenantsPublic(ctx, ctx.user)).some(t => t.id === String(row.tenantId));
}
async function tenantFor(ctx, tenantId) {
  const allowed = (await P().isSuper(ctx, ctx.user)) || (await P().allowedTenantsPublic(ctx, ctx.user)).some(t => t.id === String(tenantId));
  if (!allowed) fail('ไม่มีสิทธิ์เข้าถึงบริษัทนี้');
  const t = await ctx.one('SELECT t.id, COALESCE(p.company_name, t.company_name) AS name FROM tenants t LEFT JOIN company_profiles p ON p.tenant_id = t.id WHERE t.id::text = $1', [String(tenantId || '')]);
  if (!t) fail('ไม่พบบริษัท');
  return { id: String(t.id), name: String(t.name) };
}

// ---------- API ----------
async function exportCompany(ctx, tenantId) {
  const t = await tenantFor(ctx, tenantId);
  const busy = await ctx.one("SELECT id FROM company_exports WHERE tenant_id = $1 AND status = 'building'", [t.id]);
  if (busy) return { id: String(busy.id), already: true };
  const id = await start(t.id, t.name, ctx.user, null, false);
  return { id };
}
async function listCompanyExports(ctx, tenantId) {
  const t = await tenantFor(ctx, tenantId);
  return (await pool.query('SELECT * FROM company_exports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20', [t.id])).rows.map(outRow);
}
const TICKETS = new Map();
async function exportTicket(ctx, id) {
  const row = await ctx.one('SELECT * FROM company_exports WHERE id = $1', [Number(id) || 0]);
  if (!row || !(await canAccess(ctx, row))) fail('ไม่พบไฟล์');
  if (row.status !== 'ready') fail(row.status === 'expired' ? 'ไฟล์หมดอายุแล้ว (เก็บไว้ ' + KEEP_DAYS + ' วัน)' : 'ไฟล์ยังไม่พร้อม');
  if (!fs.existsSync(path.join(DIR, row.fileName))) fail('ไม่พบไฟล์บนเซิร์ฟเวอร์');
  const t = crypto.randomBytes(18).toString('hex'); TICKETS.set(t, { id: String(row.id), by: String(ctx.user.displayName || ctx.user.username), exp: Date.now() + 120e3 });
  for (const [k, v] of TICKETS) if (v.exp < Date.now()) TICKETS.delete(k);
  return { url: 'api/export/download/' + t };
}
async function takeTicket(t) {
  const v = TICKETS.get(String(t)); TICKETS.delete(String(t));
  if (!v || v.exp < Date.now()) return null;
  const r = (await pool.query("UPDATE company_exports SET downloads = downloads + 1, last_download_at = now(), last_download_by = $2 WHERE id = $1 AND status = 'ready' RETURNING file_name", [v.id, v.by])).rows[0];
  if (!r) return null;
  const f = path.join(DIR, r.file_name);
  return fs.existsSync(f) ? { file: f, name: r.file_name.replace(/^\d+-/, '') } : null;
}
// สรุปสำหรับคำขอลบ: ลูกค้าดาวน์โหลดข้อมูลแล้วหรือยัง
async function downloadedInfo(tenantId) {
  const r = (await pool.query('SELECT max(last_download_at) AS at, sum(downloads)::int AS n FROM company_exports WHERE tenant_id = $1', [tenantId])).rows[0];
  return r && r.n ? { downloads: r.n, lastAt: tsOut(r.at) } : null;
}
async function exportForRequest(requestId) {
  const r = (await pool.query('SELECT * FROM company_exports WHERE request_id = $1 ORDER BY id DESC LIMIT 1', [requestId])).rows[0];
  return r ? outRow(r) : null;
}
// ลบไฟล์ที่หมดอายุ (เรียกจากงานดูแลประจำคืน)
async function purgeExpired() {
  const rows = (await pool.query("SELECT id, file_name FROM company_exports WHERE status = 'ready' AND expires_at < now()")).rows;
  for (const r of rows) { await fsp.unlink(path.join(DIR, r.file_name)).catch(() => {}); await pool.query("UPDATE company_exports SET status = 'expired' WHERE id = $1", [r.id]); }
  return rows.length;
}
// ล้างไฟล์ค้างจากการรีสตาร์ทกลางคัน
(async () => { try { await pool.query("UPDATE company_exports SET status = 'error', error = 'ระบบรีสตาร์ทระหว่างสร้างไฟล์ กรุณาสร้างใหม่' WHERE status = 'building'"); for (const n of await fsp.readdir(DIR)) if (n.endsWith('.part')) await fsp.unlink(path.join(DIR, n)); } catch (e) {} })();

module.exports = { exportCompany, listCompanyExports, exportTicket, takeTicket, start, downloadedInfo, exportForRequest, purgeExpired, KEEP_DAYS };
