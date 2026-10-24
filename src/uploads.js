// ============================================================
//  uploads.js — เมนู "อัพโหลดไฟล์" (เดิม: Upload.gs)
//  ไฟล์: Storage / 02 ไฟล์อัพโหลด / [บริษัท] / [ประเภทไฟล์] / [ลูกค้า] / [ปี] / [MM เดือน] / ไฟล์   ข้อมูลไฟล์: ตาราง uploads
// ============================================================
const storage = require('./storage');
const { UPLOAD_TYPE_FOLDER } = require('./storage/layout');
const { fail, clean, round2, tsOut, isYmd, safeFolderName, sniffMime, monthFolderName, partsOf, localeTh } = require('./util');
const documents = require('./documents');
const { trashUpload } = require('./trash');

const UPLOAD_MAX_BYTES = Number(process.env.UPLOAD_MAX_MB || 10) * 1024 * 1024;
const UPLOAD_MIMES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const UPLOAD_DOC_TYPES = ['invoice', 'receipt', 'quotation', 'taxinvoice', 'cashsale', 'expense', 'po', 'gr', 'slip', 'contract', 'other'];

function upPublic(r) {
  const o = Object.assign({}, r); delete o.tenantId;
  o.uploadedAt = tsOut(o.uploadedAt);
  ['size', 'amountBeforeVat', 'vatRate', 'vatAmount', 'amountTotal'].forEach(k => { o[k] = (o[k] === '' || o[k] == null) ? '' : Number(o[k]); });
  return o;
}
async function upFind(ctx, id) {
  const r = await ctx.one("SELECT * FROM uploads WHERE tenant_id = $1 AND id::text = $2 AND status <> 'deleted'", [ctx.tenantId, String(id || '')]);
  if (!r) fail('ไม่พบไฟล์');
  return r;
}
function upNum(v, label) {
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail('ค่าตัวเลขไม่ถูกต้อง: ' + label);
  return round2(n);
}
// โฟลเดอร์ของไฟล์: บริษัท / ประเภทไฟล์ / ลูกค้า / ปี / เดือน
async function uploadFolder(ctx, docType, customer, ym) {
  const comp = await documents.getCompany(ctx, false);
  return storage.path('upload', [safeFolderName(comp.companyName, 'ไม่ระบุบริษัท'), UPLOAD_TYPE_FOLDER[docType] || UPLOAD_TYPE_FOLDER.other,
    safeFolderName(customer, 'ไม่ระบุลูกค้า'), ym.slice(0, 4), monthFolderName(ym)]);
}
async function uploadMeta(ctx) {
  const rows = await ctx.all("SELECT DISTINCT btrim(customer_name) AS n FROM documents WHERE tenant_id = $1 UNION SELECT DISTINCT btrim(customer_name) FROM uploads WHERE tenant_id = $1 AND status <> 'deleted'", [ctx.tenantId]);
  return { rootUrl: '', docTypes: UPLOAD_DOC_TYPES, maxMb: UPLOAD_MAX_BYTES / 1048576, customers: rows.map(r => r.n).filter(Boolean).sort(localeTh) };
}
async function uploadFile(ctx, input) {
  input = input || {};
  const customer = clean(input.customerName, 250);
  if (!customer) fail('กรุณาเลือกหรือพิมพ์ชื่อลูกค้า/บริษัท');
  const ym = clean(input.month, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) fail('เดือนไม่ถูกต้อง');
  const docType = UPLOAD_DOC_TYPES.includes(input.docType) ? input.docType : 'other';
  const mime = String(input.mimeType || '').toLowerCase().replace('image/jpg', 'image/jpeg');
  const ext = UPLOAD_MIMES[mime];
  if (!ext) fail('รองรับเฉพาะไฟล์ PDF, PNG, JPG, WEBP, GIF');
  const b64 = String(input.base64 || '').replace(/^data:[^,]*,/, '');
  if (!b64 || !/^[A-Za-z0-9+\/=\s]+$/.test(b64)) fail('ข้อมูลไฟล์ไม่ถูกต้อง');
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > UPLOAD_MAX_BYTES) fail('ไฟล์ต้องมีขนาดมากกว่า 0 และไม่เกิน ' + (UPLOAD_MAX_BYTES / 1048576) + ' MB');
  const real = sniffMime(bytes);   // L2 (Security Review): เนื้อไฟล์จริงต้องมี signature ตรงกับชนิดที่แจ้ง (กันไฟล์แปลกปลอมแปลงนามสกุล)
  if (!real || real !== mime) fail('เนื้อหาไฟล์ไม่ตรงกับชนิดที่ระบุ (ไม่พบ signature ของ ' + ext.toUpperCase() + ') — ห้ามเปลี่ยนนามสกุลไฟล์มาอัปโหลด');
  let name = safeFolderName(input.fileName, 'file');
  if (!new RegExp('\\.' + ext + '$', 'i').test(name)) name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.' + ext;

  await ctx.lock('tenant:' + ctx.tenantId);
  const folder = await uploadFolder(ctx, docType, customer, ym);
  const p = partsOf();
  name = await storage.uniqueName(folder, name, p.hour + p.minute + p.second);
  const file = await storage.put(folder, name, mime, bytes);
  const rec = await ctx.insert('uploads', { uploadedAt: new Date(), uploadedBy: ctx.username(), customerName: customer, month: ym, folderId: String(folder), fileId: file.id, fileName: name,
    mimeType: mime, size: bytes.length, fileUrl: file.url, docType, docNo: clean(input.docNo, 100), docDate: isYmd(input.docDate) ? String(input.docDate) : '', note: clean(input.note, 500), status: 'active' });
  await ctx.log('UPLOAD:' + rec.id, 'UPLOAD', customer + ' / ' + ym + ' / ' + name);
  return { success: true, item: upPublic(await upFind(ctx, rec.id)) };
}
async function listUploads(ctx, opts) {
  opts = opts || {};
  const dn = clean(opts.docNo, 100), q = clean(opts.keyword, 200).toLowerCase(), cust = clean(opts.customer, 250), month = clean(opts.month, 7), type = clean(opts.docType, 30);
  const all = await ctx.all("SELECT * FROM uploads WHERE tenant_id = $1 AND status <> 'deleted' ORDER BY uploaded_at DESC", [ctx.tenantId]);
  const customers = [...new Set(all.map(u => String(u.customerName || '').trim()).filter(Boolean))].sort(localeTh);
  const items = all.filter(u => (!dn || String(u.docNo) === dn) && (!cust || String(u.customerName) === cust) && (!month || String(u.month) === month) && (!type || String(u.docType) === type)
    && (!q || [u.fileName, u.customerName, u.docNo, u.taxId, u.note, u.docDate, u.month].some(v => String(v == null ? '' : v).toLowerCase().includes(q))))
    .slice(0, 1000).map(upPublic);
  return { items, customers };
}
async function getUpload(ctx, id) { return upPublic(await upFind(ctx, id)); }
async function getUploadFile(ctx, id) {
  const r = await upFind(ctx, id);
  const buf = await storage.get(String(r.fileId));
  if (buf.length > UPLOAD_MAX_BYTES) fail('ไฟล์ใหญ่เกินกว่าจะเปิดในระบบ');
  return { name: String(r.fileName), mimeType: String(r.mimeType), base64: buf.toString('base64') };
}
async function updateUpload(ctx, input) {
  input = input || {};
  const r = await upFind(ctx, input.id);
  const date = clean(input.docDate, 10);
  if (date && !isYmd(date)) fail('วันที่เอกสารไม่ถูกต้อง');
  const rate = (input.vatRate === '' || input.vatRate == null) ? '' : Number(input.vatRate);
  if (rate !== '' && ![0, 3, 7].includes(rate)) fail('อัตรา VAT ไม่ถูกต้อง');
  const docType = UPLOAD_DOC_TYPES.includes(input.docType) ? input.docType : r.docType;
  const upd = { docType, docNo: clean(input.docNo, 100), docDate: date, taxId: clean(input.taxId, 20).replace(/[^0-9\-]/g, ''),
    amountBeforeVat: upNum(input.amountBeforeVat, 'ยอดก่อน VAT'), vatAmount: upNum(input.vatAmount, 'VAT'), amountTotal: upNum(input.amountTotal, 'ยอดรวม'), vatRate: rate, note: clean(input.note, 500) };
  const moved = {};
  if (docType !== r.docType && /^\d{4}-\d{2}$/.test(String(r.month))) {   // เปลี่ยนประเภท = ย้ายไฟล์ไปหมวดใหม่
    try {
      const folder = await uploadFolder(ctx, docType, r.customerName, String(r.month));
      moved.fileId = await storage.move(String(r.fileId), folder); moved.folderId = String(folder);
    } catch (e) { console.warn('move upload:', e.message); }
  }
  await ctx.update('uploads', r.id, Object.assign(upd, moved));
  await ctx.log('UPLOAD:' + r.id, 'UPLOAD_EDIT', r.customerName + ' / ' + r.fileName);
  return { success: true };
}
async function deleteUpload(ctx, id) {
  const r = await upFind(ctx, id);
  await ctx.lock('tenant:' + ctx.tenantId);
  // ย้ายไป Storage/99 ถังขยะ เก็บไว้ 30 วัน (Super Admin กู้คืนได้) แล้วลบถาวรอัตโนมัติ
  await trashUpload(ctx, r);
  return { success: true };
}

module.exports = { uploadMeta, uploadFile, listUploads, getUpload, getUploadFile, updateUpload, deleteUpload };
