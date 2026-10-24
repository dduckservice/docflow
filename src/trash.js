// ============================================================
//  trash.js — ถังขยะ (Storage / 99 ถังขยะ)
//  - ลบไฟล์ = ย้ายไปถังขยะ + บันทึกในตาราง trash_items
//  - เก็บไว้ TRASH_KEEP_DAYS วัน (ค่าเริ่มต้น 30) แล้วลบถาวรอัตโนมัติทุกวัน (TRASH_CRON)
//  - ดู / กู้คืน / ลบถาวร: Super Admin (ทุกบริษัท) · Admin และผู้ตรวจสอบ (Admin Audit) เฉพาะบริษัทที่ตนมีสิทธิ์
// ============================================================
const storage = require('./storage');
const path = require('path').posix;
const { fail, clean, tsOut, safeFolderName } = require('./util');
const { ROOT_NAME, UPLOAD_TYPE_FOLDER } = require('./storage/layout');

const KEEP_DAYS = Math.max(1, Number(process.env.TRASH_KEEP_DAYS || 30));

// ย้ายไฟล์ไปถังขยะและบันทึกไว้ (ใช้แทน storage.trash ทุกจุดที่ผู้ใช้ลบไฟล์)
// - ย้ายไม่สำเร็จ → แจ้ง error และไม่ลบ (กันไฟล์หายเงียบ ๆ)
// - ไม่พบไฟล์ในที่เก็บ → ยังบันทึกรายการไว้ (กู้คืนข้อมูลได้ แต่ไม่มีไฟล์)
async function trashFile(ctx, info) {
  let t;
  try { t = await storage.trash(String(info.fileId)); }
  catch (e) {
    // L4 (Security Review): อย่าส่ง path/รายละเอียดเทคนิคจาก error ดิบไปถึงผู้ใช้ — log พร้อมรหัสอ้างอิงแทน
    const ref = Date.now().toString(36).slice(-6).toUpperCase();
    console.error('[ERR trash ' + ref + ']', e);
    fail('ย้ายไฟล์ไปถังขยะไม่สำเร็จ กรุณาลองใหม่ (รหัสอ้างอิง ' + ref + ')');
  }
  const missing = !t;
  if (missing) t = { id: '', folder: info.folder || path.dirname(String(info.fileId || '')), name: info.fileName || path.basename(String(info.fileId || '')) };
  const comp = ctx.tenantId ? await ctx.one('SELECT company_name FROM tenants WHERE id = $1', [ctx.tenantId]) : null;
  await ctx.exec('SAVEPOINT trash_ins');
  try {
    const rec = await ctx.insert('trash_items', {
      tenantId: ctx.tenantId || '', companyName: comp ? comp.companyName : '', kind: info.kind, refId: String(info.refId || ''),
      label: clean((info.label || '') + (missing ? ' (ไม่พบไฟล์ในที่เก็บ)' : ''), 300),
      fileName: t.name || info.fileName || 'file', mimeType: info.mimeType || '', size: info.size === '' || info.size == null ? '' : Number(info.size),
      originalFolder: String(t.folder || info.folder || ''), originalPath: clean(info.path || t.folder, 1000), trashFileId: String(t.id || ''),
      deletedBy: ctx.username(), deletedAt: new Date(), expiresAt: new Date(Date.now() + KEEP_DAYS * 86400000), status: 'trashed', groupId: info.groupId || ''
    });
    await ctx.exec('RELEASE SAVEPOINT trash_ins');
    return rec;
  } catch (e) {
    await ctx.exec('ROLLBACK TO SAVEPOINT trash_ins');
    if (t.id) { try { await storage.restore(t.id, t.folder, t.name); } catch (_) {} }   // คืนไฟล์กลับที่เดิม
    throw e;
  }
}
// ลบไฟล์อัพโหลด 1 รายการ → ถังขยะ
async function trashUpload(ctx, r, why, groupId) {
  const tf = UPLOAD_TYPE_FOLDER[r.docType];
  await trashFile(ctx, { kind: 'upload', refId: r.id, fileId: r.fileId, folder: r.folderId, fileName: r.fileName, mimeType: r.mimeType, size: r.size,
    label: [r.customerName, tf ? tf.replace(/^\d+\s*/, '') : '', r.docNo].filter(Boolean).join(' / ') + (why ? ' · ' + why : ''),
    path: [r.customerName, r.month].filter(Boolean).join(' / '), groupId });
  await ctx.exec("UPDATE uploads SET status = 'deleted' WHERE id = $1", [r.id]);
  await ctx.log('UPLOAD:' + r.id, 'UPLOAD_DELETE', r.customerName + ' / ' + r.fileName + (why ? ' / ' + why : ''));
}
// ลบเอกสาร / ค่าใช้จ่าย / ใบสั่งซื้อ → ไฟล์แนบ (อ้างด้วยเลขที่) และ PDF สำรองของเอกสารนั้นไปถังขยะด้วย
async function trashDocFiles(ctx, docNumber, docId, groupId) {
  const why = 'ลบพร้อมเอกสาร ' + docNumber;
  for (const r of await ctx.all("SELECT * FROM uploads WHERE tenant_id = $1 AND doc_no = $2 AND status <> 'deleted'", [ctx.tenantId, String(docNumber)])) await trashUpload(ctx, r, why, groupId);
  if (docId) {
    for (const b of await ctx.all('SELECT * FROM pdf_backups WHERE tenant_id = $1 AND doc_id = $2', [ctx.tenantId, String(docId)])) {
      await trashFile(ctx, { kind: 'pdf', refId: b.docId, fileId: b.fileId, mimeType: 'application/pdf', label: 'PDF ' + b.docNumber + ' · ' + why, path: b.path, groupId });
    }
    await ctx.exec('DELETE FROM pdf_backups WHERE tenant_id = $1 AND doc_id = $2', [ctx.tenantId, String(docId)]);
  }
}

// ===== ลบเอกสาร (ใบเสนอราคา / ใบวางบิล / ใบกำกับภาษี-ใบเสร็จ / ขายเงินสด / ค่าใช้จ่าย / ใบสั่งซื้อ / ใบรับสินค้า) =====
// เก็บข้อมูลเอกสาร + รายการสินค้าทั้งชุดไว้ (ตาราง trash_items.payload และไฟล์ .json ใน 99 ถังขยะ/เอกสารที่ลบ)
// ไฟล์แนบและ PDF ของเอกสารย้ายไปถังขยะในกลุ่มเดียวกัน → กู้คืนเอกสารแล้วไฟล์กลับที่เดิมพร้อมกัน
const TYPE_TH = { quotation: 'ใบเสนอราคา', invoice: 'ใบวางบิล-ใบแจ้งหนี้', taxinvoice: 'ใบกำกับภาษี', receipt: 'ใบกำกับภาษี-ใบเสร็จรับเงิน', cashsale: 'ขายเงินสด',
  expense: 'ค่าใช้จ่าย', po: 'ใบสั่งซื้อ', gr: 'ใบรับสินค้า' };
const RECORD_KINDS = ['document', 'expense', 'purchase'];
async function trashRecord(ctx, spec) {
  const row = (await ctx.db.query(`SELECT * FROM ${spec.table} WHERE id = $1`, [spec.id])).rows[0];
  if (!row) return null;
  const items = spec.itemsTable ? (await ctx.db.query(`SELECT * FROM ${spec.itemsTable} WHERE ${spec.fk} = $1`, [spec.id])).rows : [];
  const payload = { table: spec.table, itemsTable: spec.itemsTable, fk: spec.fk, row, items };
  const comp = await ctx.one('SELECT company_name FROM tenants WHERE id = $1', [ctx.tenantId]);
  const typeName = TYPE_TH[spec.docType] || spec.docType || spec.kind;
  const gid = require('./util').uuid();
  // สำเนาข้อมูลเป็นไฟล์ในถังขยะ (ดูได้จากโฟลเดอร์ Storage)
  const folder = await storage.path('trash', ['เอกสารที่ลบ', safeFolderName(comp ? comp.companyName : '', 'ไม่ระบุบริษัท'), typeName]);
  const p = require('./util').partsOf();
  const fname = p.year + p.month + p.day + '-' + p.hour + p.minute + p.second + '_' + safeFolderName(spec.number, 'doc') + '.json';
  const f = await storage.put(folder, fname, 'application/json', Buffer.from(JSON.stringify(payload, null, 1)));
  await ctx.insert('trash_items', {
    id: gid, tenantId: ctx.tenantId, companyName: comp ? comp.companyName : '', kind: spec.kind, refId: String(spec.id),
    label: clean(typeName + (spec.label ? ' · ' + spec.label : ''), 300), fileName: String(spec.number), mimeType: 'application/json',
    originalFolder: 'db:' + spec.table, originalPath: typeName, trashFileId: String(f.id), docType: spec.docType || '', docNumber: String(spec.number),
    payload: JSON.stringify(payload), groupId: gid,
    deletedBy: ctx.username(), deletedAt: new Date(), expiresAt: new Date(Date.now() + KEEP_DAYS * 86400000), status: 'trashed'
  });
  await trashDocFiles(ctx, spec.number, spec.kind === 'expense' ? null : spec.id, gid);
  return gid;
}
async function tableCols(ctx, t) {
  return new Set((await ctx.db.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1', [t])).rows.map(r => r.column_name));
}
async function insertRaw(ctx, t, row, cols) {
  const keys = Object.keys(row).filter(k => cols.has(k));
  await ctx.db.query(`INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`,
    keys.map(k => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date)) ? JSON.stringify(row[k]) : row[k]));
}
async function restoreRecord(ctx, r) {
  const pl = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
  if (!pl || !pl.row || !['documents', 'expenses', 'purchase_docs'].includes(pl.table)) fail('ข้อมูลเอกสารในถังขยะไม่สมบูรณ์ กู้คืนไม่ได้');
  const row = Object.assign({}, pl.row);
  if (String(row.tenant_id) !== String(r.tenantId)) fail('ข้อมูลบริษัทไม่ตรงกัน');
  if (await ctx.one(`SELECT 1 FROM ${pl.table} WHERE id = $1`, [row.id])) fail('เอกสารนี้มีอยู่ในระบบแล้ว');
  const dup = await ctx.one(`SELECT number FROM ${pl.table} WHERE tenant_id = $1 AND number = $2`, [r.tenantId, row.number]);
  if (dup) fail('กู้คืนไม่ได้: มีเอกสารเลขที่ ' + row.number + ' อยู่ในระบบแล้ว');
  // เอกสารต้นทางถูกลบไปแล้ว → ตัดการอ้างอิง
  // เอกสารต้นทางถูกลบถาวรไปแล้ว → ตัดการอ้างอิง (ถ้ายังอยู่ในถังขยะ คงไว้ เพื่อกู้คืนตามมาแล้วเชื่อมกันเหมือนเดิม)
  if (row.source_document_id && !(await ctx.one(`SELECT 1 FROM ${pl.table} WHERE id = $1`, [row.source_document_id]))
    && !(await ctx.one("SELECT 1 FROM trash_items WHERE ref_id = $1 AND status = 'trashed' AND kind = ANY($2)", [String(row.source_document_id), RECORD_KINDS]))) row.source_document_id = null;
  await insertRaw(ctx, pl.table, row, await tableCols(ctx, pl.table));
  if (pl.itemsTable) { const ic = await tableCols(ctx, pl.itemsTable); for (const it of pl.items || []) await insertRaw(ctx, pl.itemsTable, it, ic); }
  // ปรับสถานะที่เกี่ยวข้องให้เหมือนก่อนลบ
  if (pl.table === 'documents') {
    const D = require('./documents');
    if (['receipt', 'taxinvoice'].includes(row.type) && row.source_document_id) await D.syncInvoicePaidState(ctx, row.source_document_id);
    if (['invoice', 'taxinvoice'].includes(row.type)) await D.syncInvoicePaidState(ctx, row.id);   // ใบเสร็จที่กู้คืนไปก่อนหน้า → สถานะชำระแล้ว
  }
  if (pl.table === 'purchase_docs') {
    const M = require('./modules');
    if (String(row.stock_applied) === '1') await M.stockAdjust(ctx, await M.purchaseItems(ctx, row.id), 1);
    if (row.type === 'gr' && row.source_document_id) await M.syncPoReceived(ctx, String(row.source_document_id));
    if (row.type === 'po') await M.syncPoReceived(ctx, String(row.id));
  }
  await ctx.log(pl.table === 'expenses' ? 'EXPENSE:' + row.id : row.id, 'TRASH_RESTORE', row.number + ' (กู้คืนจากถังขยะ)');
  if (r.trashFileId) await storage.purge(String(r.trashFileId)).catch(() => {});
}

function pub(r) {
  const left = Math.max(0, Math.ceil((new Date(r.expiresAt).getTime() - Date.now()) / 86400000));
  return { id: r.id, kind: r.kind, label: r.label, fileName: r.fileName, mimeType: r.mimeType, size: r.size === '' ? '' : Number(r.size),
    companyName: r.companyName, originalPath: r.originalPath, docType: r.docType, docNumber: r.docNumber, groupId: r.groupId, isRecord: RECORD_KINDS.includes(r.kind), deletedBy: r.deletedBy, deletedAt: tsOut(r.deletedAt), expiresAt: tsOut(r.expiresAt), daysLeft: left };
}
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', json: 'application/json', gz: 'application/gzip' };
// เวลาในชื่อไฟล์ถังขยะ yyyyMMdd-HHmmss (เวลาไทย) → Date
function stampDate(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : null;
}
// ดึงไฟล์ใน "99 ถังขยะ" ที่ยังไม่มีในรายการ (เช่น ไฟล์ที่ลบก่อนอัปเดตระบบ) เข้ามาในรายการ
async function syncTrashFolder(ctx) {
  if (!storage.listTrashFiles) return 0;
  await ctx.lock('trash-sync');
  const files = await storage.listTrashFiles();
  if (!files.length) return 0;
  const known = new Set((await ctx.all("SELECT trash_file_id FROM trash_items WHERE status = 'trashed'")).map(r => String(r.trashFileId)));
  const tenants = await ctx.all('SELECT id, company_name FROM tenants');
  const tenantOf = folderName => tenants.find(t => safeFolderName(t.companyName, '') === folderName) || null;
  let added = 0;
  for (const f of files) {
    if (known.has(f.id)) continue;
    const rel = f.id.slice(ROOT_NAME.trash.length + 1);            // path เดิมใต้ Storage
    const folder = path.dirname(rel), base = path.basename(rel);
    const m = base.match(/^(\d{8}-\d{6})_(.+)$/);
    const name = m ? m[2] : base, deletedAt = (m && stampDate(m[1])) || f.mtime || new Date();
    const seg = folder.split('/');
    const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [])[1] || '';
    let kind = 'file', refId = '', label = '', tenant = null, by = '';
    const up = await ctx.one("SELECT * FROM uploads WHERE file_id = $1 ORDER BY uploaded_at DESC LIMIT 1", [path.join(folder, name)]);
    if (up && up.status === 'deleted') {
      kind = 'upload'; refId = up.id; tenant = tenants.find(t => String(t.id) === String(up.tenantId)) || null;
      const tf = UPLOAD_TYPE_FOLDER[up.docType];
      label = [up.customerName, tf ? tf.replace(/^\d+\s*/, '') : '', up.docNo].filter(Boolean).join(' / ');
      const lg = await ctx.one("SELECT username FROM audit_log WHERE document_id = $1 AND action = 'UPLOAD_DELETE' ORDER BY id DESC LIMIT 1", ['UPLOAD:' + up.id]);
      by = lg ? lg.username : '';
    } else {
      if (seg[0] === ROOT_NAME.pdf) { kind = 'pdf'; label = 'PDF เอกสาร'; }
      else if (seg[0] === ROOT_NAME.upload) label = 'ไฟล์อัพโหลด';
      tenant = seg[1] ? tenantOf(seg[1]) : null;
    }
    await ctx.insert('trash_items', {
      tenantId: tenant ? tenant.id : '', companyName: tenant ? tenant.companyName : (seg[1] || ''), kind, refId, label,
      fileName: name, mimeType: MIME[ext.toLowerCase()] || '', size: f.size, originalFolder: folder, originalPath: seg.slice(1).join(' / ') || folder,
      trashFileId: f.id, deletedBy: by, deletedAt, expiresAt: new Date(new Date(deletedAt).getTime() + KEEP_DAYS * 86400000), status: 'trashed'
    });
    added++;
  }
  return added;
}
// ถ้าดึงไม่สำเร็จ ไม่ให้กระทบการทำงานหลัก (ย้อนเฉพาะส่วนนี้)
async function safeSync(ctx) {
  await ctx.exec('SAVEPOINT trash_sync');
  try { await syncTrashFolder(ctx); await ctx.exec('RELEASE SAVEPOINT trash_sync'); }
  catch (e) { await ctx.exec('ROLLBACK TO SAVEPOINT trash_sync'); console.warn('sync trash folder:', e.message); }
}
// ขอบเขตบริษัทที่ผู้ใช้จัดการถังขยะได้ (null = ทุกบริษัท สำหรับ Super Admin)
async function scopeIds(ctx) {
  const P = require('./platform');
  if (await P.isSuper(ctx, ctx.user)) return null;
  return (await P.allowedTenants(ctx, ctx.user)).map(t => t.id);
}
async function listTrash(ctx) {
  await safeSync(ctx);
  const ids = await scopeIds(ctx);
  const rows = ids ? await ctx.all("SELECT * FROM trash_items WHERE status = 'trashed' AND tenant_id::text = ANY($1) ORDER BY deleted_at DESC LIMIT 2000", [ids])
    : await ctx.all("SELECT * FROM trash_items WHERE status = 'trashed' ORDER BY deleted_at DESC LIMIT 2000");
  return { items: rows.map(pub), keepDays: KEEP_DAYS };
}
async function findItem(ctx, id) {
  const r = await ctx.one("SELECT * FROM trash_items WHERE id::text = $1 AND status = 'trashed' FOR UPDATE", [String(id || '')]);
  if (!r) fail('ไม่พบรายการในถังขยะ (อาจถูกกู้คืนหรือลบถาวรไปแล้ว)');
  const ids = await scopeIds(ctx);
  if (ids && !ids.includes(String(r.tenantId))) fail('ไม่มีสิทธิ์จัดการรายการของบริษัทนี้');
  return r;
}
// กู้คืนไฟล์ 1 รายการกลับที่เดิม
async function restoreFile(ctx, r) {
  if (r.kind === 'upload' && !r.tenantId) fail('กู้คืนไม่ได้: บริษัทของไฟล์นี้ถูกลบไปแล้ว');
  if (!r.trashFileId && r.kind !== 'upload') fail('กู้คืนไม่ได้: ไม่มีไฟล์ในถังขยะ (ไฟล์หายไปก่อนถูกลบ)');
  const newId = r.trashFileId ? await storage.restore(String(r.trashFileId), String(r.originalFolder), String(r.fileName)) : '';
  if (r.kind === 'upload') {
    const up = await ctx.one('SELECT id FROM uploads WHERE id::text = $1', [String(r.refId)]);
    if (!up) fail('กู้คืนไม่ได้: ไม่พบข้อมูลไฟล์อัพโหลดเดิม');
    if (newId) await ctx.exec("UPDATE uploads SET status = 'active', file_id = $1, folder_id = $2 WHERE id::text = $3", [String(newId), String(r.originalFolder), String(r.refId)]);
    else await ctx.exec("UPDATE uploads SET status = 'active' WHERE id::text = $1", [String(r.refId)]);
  }
  if (r.kind === 'pdf' && newId && r.refId) {
    // PDF ของเอกสาร: ผูกกลับกับเอกสาร (ถ้าเอกสารยังอยู่)
    const d = await ctx.one('SELECT id, number, type FROM documents WHERE id::text = $1', [String(r.refId)]);
    if (d && !(await ctx.one('SELECT 1 FROM pdf_backups WHERE tenant_id = $1 AND doc_id = $2', [r.tenantId, String(d.id)])))
      await ctx.exec('INSERT INTO pdf_backups (tenant_id, doc_id, doc_number, doc_type, file_id, path) VALUES ($1,$2,$3,$4,$5,$6)', [r.tenantId, String(d.id), d.number, d.type, String(newId), r.originalPath]);
  }
  if (r.tenantId) await ctx.log(r.kind === 'upload' ? 'UPLOAD:' + r.refId : r.refId, 'TRASH_RESTORE', r.fileName);
}
async function markRestored(ctx, r) {
  await ctx.exec("UPDATE trash_items SET status = 'restored', restored_by = $1, restored_at = now() WHERE id = $2", [ctx.username(), r.id]);
}
// กู้คืน: เอกสาร → ข้อมูลเอกสาร + ไฟล์แนบ + PDF ทั้งกลุ่มกลับที่เดิม ; ไฟล์ → กลับโฟลเดอร์เดิม
async function restoreTrash(ctx, id) {
  const r = await findItem(ctx, id);
  ctx.tenantId = r.tenantId || '';
  if (RECORD_KINDS.includes(r.kind)) {
    if (!r.tenantId) fail('กู้คืนไม่ได้: บริษัทของเอกสารนี้ถูกลบไปแล้ว');
    await ctx.lock('tenant:' + ctx.tenantId);
    await restoreRecord(ctx, r);
    await markRestored(ctx, r);
    const kids = await ctx.all("SELECT * FROM trash_items WHERE group_id = $1 AND id <> $1 AND status = 'trashed' FOR UPDATE", [r.id]);
    let files = 0;
    for (const k of kids) { await restoreFile(ctx, k); await markRestored(ctx, k); files++; }
    return { success: true, files };
  }
  await restoreFile(ctx, r);
  await markRestored(ctx, r);
  return { success: true };
}
async function purgeRow(ctx, r) {
  if (r.trashFileId) await storage.purge(String(r.trashFileId));
  await ctx.exec("UPDATE trash_items SET status = 'purged' WHERE id = $1", [r.id]);
}
// ลบถาวรทันที (Super Admin)
async function deleteTrashItem(ctx, id) {
  const r = await findItem(ctx, id);
  await purgeRow(ctx, r);
  if (RECORD_KINDS.includes(r.kind)) for (const k of await ctx.all("SELECT * FROM trash_items WHERE group_id = $1 AND id <> $1 AND status = 'trashed'", [r.id])) await purgeRow(ctx, k);
  ctx.tenantId = r.tenantId || '';
  if (r.tenantId) await ctx.log(r.kind === 'upload' ? 'UPLOAD:' + r.refId : r.refId, 'TRASH_PURGE', r.fileName);
  return { success: true };
}
// งานรายวัน: ลบถาวรรายการที่ครบกำหนด
async function purgeExpired(ctx) {
  await safeSync(ctx);
  const rows = await ctx.all("SELECT * FROM trash_items WHERE status = 'trashed' AND expires_at <= now() ORDER BY expires_at LIMIT 5000");
  let purged = 0, failed = 0;
  for (const r of rows) {
    try { await purgeRow(ctx, r); purged++; } catch (e) { failed++; console.warn('purge trash', r.id, e.message); }
  }
  return { purged, failed };
}

module.exports = { syncTrashFolder, trashFile, trashUpload, trashDocFiles, trashRecord, listTrash, restoreTrash, deleteTrashItem, purgeExpired, KEEP_DAYS };
