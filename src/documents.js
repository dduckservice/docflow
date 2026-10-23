// ============================================================
//  documents.js — เอกสารขาย, ข้อมูลบริษัท, สรุปยอด (เดิม: Code.gs)
// ============================================================
const { uuid, fail, clean, num, round2, parseVat, parseWht, dateOut, tsOut, isYmd, todayStr, compactDay, yearNow, localeTh, VAT_RATE } = require('./util');

const PAY_METHODS = ['cash', 'cheque', 'transfer', 'card'];
const SALES_TYPES = ['quotation', 'invoice', 'taxinvoice', 'receipt', 'cashsale'];
const PAID_TYPES = ['receipt', 'cashsale'];
const STATUS_BY_TYPE = { quotation: ['draft', 'issued', 'cancelled'], invoice: ['draft', 'issued', 'paid', 'cancelled'], taxinvoice: ['draft', 'issued', 'cancelled'], receipt: ['paid', 'cancelled'], cashsale: ['paid', 'cancelled'] };
const STATUS_RANK = { draft: 0, issued: 1, paid: 2 };
// true = เอกสารที่ออกแล้ว/ชำระแล้ว แก้ "เนื้อหา" ได้เฉพาะ admin และต้องระบุเหตุผล
const LOCK_ISSUED_DOCS = !/^(0|false|no)$/i.test(process.env.LOCK_ISSUED_DOCS || 'true');

// ---------- บริษัท ----------
async function getCompany(ctx, withLogo) {
  const r = await ctx.one(`SELECT * ${withLogo ? '' : ', NULL AS logo'} FROM company_profiles WHERE tenant_id = $1`, [ctx.tenantId]);
  if (!r) fail('ยังไม่มีข้อมูลบริษัทผู้ออกเอกสาร');
  return r;
}
async function getActiveCompanyId(ctx) { const c = await ctx.one('SELECT id FROM company_profiles WHERE tenant_id = $1', [ctx.tenantId]); return c ? String(c.id) : ''; }
function companyPublic(c) {
  const o = Object.assign({}, c);
  o.logoFileId = c.logo ? 'db' : ''; delete o.logo; delete o.logoMime; delete o.tenantId;
  o.createdAt = tsOut(c.createdAt); o.updatedAt = tsOut(c.updatedAt);
  return o;
}
async function getCompanySettings(ctx) { return companyPublic(await getCompany(ctx, false)); }
async function getLogoPreview(ctx) {
  const c = await getCompany(ctx, true);
  if (!c.logo) return { id: '', dataUrl: '', error: '' };
  return { id: 'db', dataUrl: 'data:' + (c.logoMime || 'image/png') + ';base64,' + Buffer.from(c.logo).toString('base64'), error: '' };
}
async function saveCompanySettings(ctx, input) {
  input = input || {};
  await ctx.lock('tenant:' + ctx.tenantId);
  const upd = {};
  if (input.logoData) {
    const m = String(input.logoData).match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) fail('ไฟล์โลโก้ต้องเป็น PNG, JPG หรือ WEBP');
    const bytes = Buffer.from(m[2], 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024) fail('โลโก้ต้องมีขนาดมากกว่า 0 และไม่เกิน 2 MB');
    upd.logo = bytes; upd.logoMime = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  } else if (input.removeLogo) { await ctx.exec('UPDATE company_profiles SET logo = NULL, logo_mime = NULL WHERE tenant_id = $1', [ctx.tenantId]); }
  const companyName = clean(input.companyName || '', 250);
  if (!companyName) fail('กรุณากรอกชื่อบริษัท/ห้างหุ้นส่วน');
  const old = await getCompany(ctx, false);
  Object.assign(upd, { companyName, companyTaxId: clean(input.companyTaxId, 250), companyAddress: clean(input.companyAddress, 1000), companyPhone: clean(input.companyPhone, 250),
    companyEmail: clean(input.companyEmail, 250), signatoryName: clean(input.signatoryName, 250), branch: clean(input.branch, 100), updatedAt: new Date() });
  if (input.vatRegistered !== undefined) upd.vatRegistered = (input.vatRegistered === false || input.vatRegistered === 'no') ? 'no' : 'yes';
  await ctx.update('company_profiles', old.id, upd);
  await require('./platform').syncTenantName(ctx, companyName);
  await ctx.log('COMPANY:' + old.id, 'UPDATE', companyName);
  return { success: true, company: await getCompanySettings(ctx) };
}

// ---------- เอกสาร ----------
function pubDocRow(d) {
  const o = Object.assign({}, d); delete o.tenantId;
  ['date', 'dueDate', 'payDate'].forEach(k => { o[k] = dateOut(o[k]); });
  ['createdAt', 'updatedAt', 'lastEditedAt'].forEach(k => { o[k] = tsOut(o[k]); });
  o.editCount = Number(o.editCount) || 0;
  return o;
}
async function docItems(ctx, id) {
  return (await ctx.all('SELECT * FROM document_items WHERE document_id = $1 ORDER BY line_no', [id])).map(x => ({
    id: x.id, documentId: x.documentId, description: x.description, quantity: Number(x.quantity), unit: x.unit, price: Number(x.price), discount: Number(x.discount), amount: Number(x.amount) }));
}
async function findDoc(ctx, id) { return ctx.one('SELECT * FROM documents WHERE tenant_id = $1 AND id::text = $2', [ctx.tenantId, String(id || '')]); }

async function listDocuments(ctx, keyword) {
  const q = clean(keyword, 200).toLowerCase();
  // กรองและจำกัด 500 รายการล่าสุดในฐานข้อมูล (ไม่ดึงเอกสารทั้งหมดของบริษัทมาทุกครั้ง)
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const rows = await ctx.all(`SELECT * FROM documents WHERE tenant_id = $1 AND ($2 = '' OR lower(COALESCE(number,'')) LIKE $3 OR lower(COALESCE(type,'')) LIKE $3
      OR lower(COALESCE(customer_name,'')) LIKE $3 OR lower(COALESCE(status,'')) LIKE $3) ORDER BY updated_at DESC LIMIT 500`, [ctx.tenantId, q, like]);
  return rows.map(pubDocRow);
}
async function getDocument(ctx, id) {
  const d = await findDoc(ctx, id);
  if (!d) fail('ไม่พบเอกสาร');
  const o = pubDocRow(d); o.items = await docItems(ctx, d.id); return o;
}
// ประวัติการแก้ไข: detail = "เลขที่ | สิ่งที่เปลี่ยน | เหตุผล: ..."
async function getDocHistory(ctx, id) {
  const rows = await ctx.all("SELECT * FROM audit_log WHERE tenant_id = $1 AND document_id = $2 AND action IN ('CREATE','UPDATE') ORDER BY id DESC LIMIT 100", [ctx.tenantId, String(id)]);
  return rows.map(r => {
    const parts = String(r.detail || '').split(' | ');
    let reason = '', changes = '';
    parts.slice(1).forEach(p => { if (p.indexOf('เหตุผล: ') === 0) reason = p.slice(8); else changes = changes ? changes + ' | ' + p : p; });
    return { at: tsOut(r.ts), user: String(r.username || ''), action: String(r.action), changes, reason };
  });
}
const itemSig = x => [clean(x.description, 500), Number(x.quantity), clean(x.unit, 50), Number(x.price), Number(x.discount)].join('|');
function docChanges(old, rec, oldItems, items) {
  const out = [], txt = v => String(v == null ? '' : v).trim();
  [['payMethods', 'วิธีชำระเงิน'], ['payBank', 'ธนาคาร'], ['payNo', 'เลขที่เช็ค/อ้างอิง'], ['payDate', 'วันที่ชำระ'], ['customerName', 'ชื่อลูกค้า'], ['customerTaxId', 'เลขผู้เสียภาษีลูกค้า'],
    ['customerAddress', 'ที่อยู่ลูกค้า'], ['customerPhone', 'โทรลูกค้า'], ['projectName', 'ชื่องาน'], ['notes', 'หมายเหตุ']]
    .forEach(([k, l]) => { if (txt(old[k]) !== txt(rec[k])) out.push(l + ' (แก้ไข)'); });
  const pa = v => (v === '' || v == null) ? '' : round2(Number(v));
  if (pa(old.payAmount) !== pa(rec.payAmount)) out.push('จำนวนเงินที่ชำระ (แก้ไข)');
  [['date', 'วันที่'], ['dueDate', 'วันครบกำหนด']].forEach(([k, l]) => { const a = dateOut(old[k]), b = rec[k] || ''; if (a !== b) out.push(l + ': ' + (a || '-') + '→' + (b || '-')); });
  const oldVat = (old.vatRate === '' || old.vatRate == null) ? VAT_RATE : Number(old.vatRate);
  [['VAT%', oldVat, rec.vatRate], ['หัก ณ ที่จ่าย%', Number(old.whtRate) || 0, rec.whtRate], ['รวมรายการ', Number(old.subtotal) || 0, rec.subtotal],
    ['ส่วนลด', Number(old.discount) || 0, rec.discount], ['ยอดสุทธิ', Number(old.total) || 0, rec.total]]
    .forEach(([l, a, b]) => { if (round2(a) !== round2(b)) out.push(l + ': ' + a + '→' + b); });
  const a = oldItems.map(itemSig), b = items.map(itemSig);
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) out.push('รายการสินค้า: ' + a.length + '→' + b.length + ' รายการ' + (a.length === b.length ? ' (เนื้อหาเปลี่ยน)' : ''));
  return out;
}
async function nextNumber(ctx, type) {
  const prefix = { quotation: 'QT', invoice: 'INV', taxinvoice: 'TX', receipt: 'RC', cashsale: 'CS' }[type];
  if (!prefix) fail('ประเภทเอกสารไม่ถูกต้อง');
  const start = prefix + '-' + compactDay() + '-';
  const rows = await ctx.all("SELECT number FROM documents WHERE tenant_id = $1 AND number LIKE $2 UNION SELECT doc_number FROM trash_items WHERE tenant_id = $1 AND kind = 'document' AND status = 'trashed' AND doc_number LIKE $2", [ctx.tenantId, start + '%']);   // ไม่ใช้เลขที่ของเอกสารในถังขยะซ้ำ
  const nums = rows.map(r => parseInt(String(r.number).slice(start.length), 10)).filter(Number.isFinite);
  return start + String(Math.max(0, ...nums) + 1).padStart(4, '0');
}
// รับ id ใบแจ้งหนี้ หรือใบกำกับภาษี → id ใบแจ้งหนี้ต้นทาง
async function invoiceIdOf(ctx, docId) {
  const d = await findDoc(ctx, docId);
  if (!d) return '';
  if (d.type === 'invoice') return String(d.id);
  if (d.type === 'taxinvoice' && d.sourceDocumentId) { const p = await findDoc(ctx, d.sourceDocumentId); return p && p.type === 'invoice' ? String(p.id) : ''; }
  return '';
}
// ใบเสร็จที่ยังไม่ยกเลิก = ใบแจ้งหนี้ต้นทางชำระแล้ว; ยกเลิกใบเสร็จทั้งหมด = ย้อนกลับเป็น "ออกเอกสารแล้ว"
async function syncInvoicePaidState(ctx, invId) {
  invId = await invoiceIdOf(ctx, invId);
  if (!invId) return;
  const inv = await findDoc(ctx, invId);
  if (!inv || inv.type !== 'invoice' || inv.status === 'cancelled') return;
  const r = await ctx.one(`SELECT 1 FROM documents d WHERE d.tenant_id = $1 AND d.type = 'receipt' AND d.status <> 'cancelled' AND (d.source_document_id = $2 OR d.source_document_id IN
      (SELECT id FROM documents WHERE tenant_id = $1 AND type = 'taxinvoice' AND source_document_id = $2 AND status <> 'cancelled')) LIMIT 1`, [ctx.tenantId, invId]);
  let next = String(inv.status);
  if (r) next = 'paid'; else if (next === 'paid') next = 'issued';
  if (next === String(inv.status)) return;
  await ctx.update('documents', inv.id, { status: next, updatedAt: new Date() });
  await ctx.log(inv.id, 'STATUS', inv.number + ': ' + inv.status + '→' + next + ' (อัตโนมัติตามใบเสร็จ)');
}

async function deleteDocument(ctx, id) {
  await ctx.lock('tenant:' + ctx.tenantId);
  const d = await findDoc(ctx, id);
  if (!d) fail('ไม่พบเอกสาร');
  const child = await ctx.one('SELECT number FROM documents WHERE tenant_id = $1 AND source_document_id = $2 LIMIT 1', [ctx.tenantId, d.id]);
  if (child) fail('ลบไม่ได้: มีเอกสารที่สร้างต่อจากฉบับนี้ (' + child.number + ') กรุณาลบเอกสารปลายทางก่อน');
  // เก็บเอกสารทั้งชุด + ไฟล์แนบ + PDF ไว้ในถังขยะ (Super Admin กู้คืนได้ภายใน 30 วัน)
  await require('./trash').trashRecord(ctx, { kind: 'document', table: 'documents', itemsTable: 'document_items', fk: 'document_id', id: d.id, number: d.number, docType: d.type, label: d.customerName });
  await ctx.exec('DELETE FROM documents WHERE id = $1', [d.id]);   // รายการสินค้าถูกลบตาม (ON DELETE CASCADE)
  if (['receipt', 'taxinvoice'].includes(d.type) && d.sourceDocumentId) await syncInvoicePaidState(ctx, d.sourceDocumentId);
  await ctx.log(d.id, 'DELETE', d.number + ' / ' + d.type + ' / ' + d.status + ' / ยอดสุทธิ ' + d.total);
  return { success: true };
}

async function saveDocument(ctx, input) {
  if (!input || !SALES_TYPES.includes(input.type)) fail('ประเภทเอกสารไม่ถูกต้อง');
  if (!clean(input.customerName, 250)) fail('กรุณากรอกชื่อลูกค้า/บริษัทลูกค้า');
  if (!Array.isArray(input.items) || !input.items.length) fail('กรุณาเพิ่มรายการสินค้า/บริการ');
  await ctx.lock('tenant:' + ctx.tenantId);
  const old = input.id ? await findDoc(ctx, input.id) : null;
  if (input.id && !old) fail('ไม่พบเอกสารที่ต้องการแก้ไข');
  if (old && old.type !== input.type) fail('ไม่สามารถเปลี่ยนประเภทเอกสารเดิมได้');
  if (old && old.status === 'cancelled') fail('เอกสารที่ยกเลิกแล้วไม่สามารถแก้ไขได้');
  const prevStatus = old ? String(old.status || 'draft') : '';
  const id = old ? String(old.id) : uuid();
  const items = input.items.map((it, i) => {
    const quantity = num(it.quantity, 'จำนวน'), price = num(it.price, 'ราคา'), discount = num(it.discount || 0, 'ส่วนลด');
    if (quantity <= 0 || price < 0 || discount < 0 || discount > quantity * price) fail('ตรวจสอบจำนวน ราคา และส่วนลด แถว ' + (i + 1));
    const description = clean(it.description, 500);
    if (!description) fail('กรุณากรอกรายละเอียดรายการที่ ' + (i + 1));
    return { id: uuid(), documentId: id, lineNo: i + 1, description, quantity, unit: clean(it.unit || 'รายการ', 50), price, discount, amount: round2(quantity * price - discount) };
  });
  const subtotal = round2(items.reduce((s, x) => s + x.quantity * x.price, 0));
  const discount = round2(items.reduce((s, x) => s + x.discount, 0));
  const net = round2(subtotal - discount), vatRate = parseVat(input.vatRate), vatAmount = round2(net * vatRate / 100), total = round2(net + vatAmount);
  const date = clean(input.date, 10), dueDate = clean(input.dueDate, 10);
  if (!isYmd(date)) fail('วันที่เอกสารไม่ถูกต้อง');
  if (dueDate && !isYmd(dueDate)) fail('วันครบกำหนดไม่ถูกต้อง');
  const comp = await getCompany(ctx, false);
  const companyId = String(comp.id);
  if (String(comp.vatRegistered || '') === 'no' && vatRate !== 0 && !(old && Number(old.vatRate) === vatRate)) fail('บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม กรุณาเลือก "ไม่คิด VAT"');
  const sourceDocumentId = old ? String(old.sourceDocumentId || '') : clean(input.sourceDocumentId, 100);
  if (sourceDocumentId && !(await findDoc(ctx, sourceDocumentId))) fail('ไม่พบเอกสารต้นทาง');
  if (old && String(old.sourceDocumentId || '') !== sourceDocumentId) fail('ไม่สามารถเปลี่ยนเอกสารต้นทางได้');

  let status = clean(input.status || 'draft', 30);
  if (!['draft', 'issued', 'paid', 'cancelled'].includes(status)) fail('สถานะไม่ถูกต้อง');
  if (PAID_TYPES.includes(input.type)) status = (old && status === 'cancelled') ? 'cancelled' : 'paid';
  if (!STATUS_BY_TYPE[input.type].includes(status) && !(old && status === prevStatus)) fail('สถานะนี้ใช้กับเอกสารประเภทนี้ไม่ได้');
  if (old && status !== prevStatus && status !== 'cancelled' && STATUS_RANK[status] < STATUS_RANK[prevStatus]) fail('ไม่สามารถย้อนสถานะเอกสารได้ หากต้องแก้ไขให้ยกเลิกแล้วออกเอกสารใหม่');
  if (input.type === 'taxinvoice') {
    if (String(comp.vatRegistered || '') === 'no') fail('บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม ออกใบกำกับภาษีไม่ได้');
    if (vatRate === 0) fail('ใบกำกับภาษีต้องคิด VAT (เลือก VAT 7% หรือ 3%)');
  }
  const isRc = PAID_TYPES.includes(input.type);
  const payMethods = isRc ? String(input.payMethods || '').split(',').map(s => s.trim()).filter((s, i, a) => PAY_METHODS.includes(s) && a.indexOf(s) === i).join(',') : '';
  const payDate = isRc ? clean(input.payDate, 10) : '';
  if (payDate && !isYmd(payDate)) fail('วันที่ชำระเงินไม่ถูกต้อง');
  const payAmountRaw = isRc ? clean(input.payAmount, 20) : '';
  if (payAmountRaw !== '' && (!Number.isFinite(Number(payAmountRaw)) || Number(payAmountRaw) < 0)) fail('จำนวนเงินที่ชำระไม่ถูกต้อง');
  const record = { id, number: old ? old.number : await nextNumber(ctx, input.type), type: input.type, date, dueDate, companyId,
    payMethods, payBank: isRc ? clean(input.payBank, 100) : '', payNo: isRc ? clean(input.payNo, 100) : '', payDate, payAmount: payAmountRaw,
    customerName: clean(input.customerName, 250), customerTaxId: clean(input.customerTaxId, 50), customerAddress: clean(input.customerAddress, 1000), customerPhone: clean(input.customerPhone, 50),
    subtotal, discount, vatRate, vatAmount, total, notes: clean(input.notes, 2000), projectName: clean(input.projectName, 250), whtRate: parseWht(input.whtRate),
    status, sourceDocumentId, variant: old ? String(old.variant || '') : (input.type === 'receipt' ? 'receipt' : ''), updatedAt: new Date() };
  if (!old) { record.createdAt = new Date(); record.createdBy = ctx.username(); }

  // ล็อกเอกสารที่ออกแล้ว: แก้เนื้อหาได้เฉพาะ admin + ต้องมีเหตุผล
  const oldItems = old ? await ctx.all('SELECT * FROM document_items WHERE document_id = $1 ORDER BY line_no', [id]) : [];
  const changes = old ? docChanges(old, record, oldItems, items) : [];
  const reason = clean(input.editReason, 300);
  if (old && LOCK_ISSUED_DOCS && ['issued', 'paid'].includes(prevStatus) && changes.length) {
    if (!ctx.user || ctx.user.role !== 'admin') fail('เอกสารที่ออกแล้ว/ชำระแล้วแก้ไขเนื้อหาได้เฉพาะผู้ดูแลระบบ (เปลี่ยนสถานะหรือยกเลิกแล้วออกใหม่ได้)');
    if (!reason) fail('EDIT_REASON_REQUIRED');
  }
  if (old && ['issued', 'paid'].includes(prevStatus) && changes.length) {
    Object.assign(record, { editCount: (Number(old.editCount) || 0) + 1, lastEditReason: reason, lastEditedAt: new Date(), lastEditedBy: ctx.username() });
  }
  if (old) { await ctx.update('documents', id, record); await ctx.exec('DELETE FROM document_items WHERE document_id = $1', [id]); }
  else await ctx.insert('documents', record);
  await ctx.insertMany('document_items', items);

  if (old && ['receipt', 'taxinvoice'].includes(input.type) && status === 'cancelled' && prevStatus !== 'cancelled' && sourceDocumentId) await syncInvoicePaidState(ctx, sourceDocumentId);
  if (old && status === 'cancelled' && prevStatus !== 'cancelled') await require('./print').archiveCancelledPdf(ctx, id);

  const diffs = changes.slice();
  if (old && status !== prevStatus) diffs.unshift('สถานะ: ' + prevStatus + '→' + status);
  await ctx.log(id, old ? 'UPDATE' : 'CREATE', (record.number + (diffs.length ? ' | ' + diffs.join('; ') : '') + (reason && changes.length ? ' | เหตุผล: ' + reason : '')).slice(0, 1500));
  return { success: true, id, number: record.number, total, status };
}

async function convertDocument(ctx, sourceId, targetType) {
  if (!['invoice', 'taxinvoice', 'receipt'].includes(targetType)) fail('ประเภทปลายทางไม่ถูกต้อง');
  await ctx.lock('tenant:' + ctx.tenantId);
  const source = await findDoc(ctx, sourceId);
  if (!source) fail('ไม่พบเอกสารต้นทาง');
  if (source.status === 'cancelled') fail('ไม่สามารถแปลงเอกสารที่ยกเลิกแล้ว');
  if (targetType === 'invoice' && source.type !== 'quotation') fail('สร้างใบแจ้งหนี้จากใบเสนอราคาเท่านั้น');
  if (targetType === 'taxinvoice' && source.type !== 'invoice') fail('สร้างใบกำกับภาษีจากใบแจ้งหนี้เท่านั้น');
  if (targetType === 'receipt' && !['invoice', 'taxinvoice'].includes(source.type)) fail('สร้างใบเสร็จจากใบแจ้งหนี้หรือใบกำกับภาษีเท่านั้น');
  if (targetType === 'taxinvoice' && parseVat(source.vatRate) === 0) fail('ใบแจ้งหนี้นี้ไม่คิด VAT จึงออกใบกำกับภาษีไม่ได้');
  const comp = await getCompany(ctx, false);
  if (targetType === 'taxinvoice' && String(comp.vatRegistered || '') === 'no') fail('บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม ออกใบกำกับภาษีไม่ได้');
  const existing = await ctx.one("SELECT id, number FROM documents WHERE tenant_id = $1 AND source_document_id = $2 AND type = $3 AND status <> 'cancelled' LIMIT 1", [ctx.tenantId, source.id, targetType]);
  if (existing) return { success: true, id: existing.id, number: existing.number, alreadyExists: true };
  const items = await ctx.all('SELECT * FROM document_items WHERE document_id = $1 ORDER BY line_no', [source.id]);
  if (!items.length) fail('เอกสารต้นทางไม่มีรายการสินค้า/บริการ');
  const id = uuid(), now = new Date(), number = await nextNumber(ctx, targetType);
  await ctx.insert('documents', { id, number, type: targetType, companyId: String(source.companyId || comp.id), date: todayStr(), dueDate: '',
    customerName: source.customerName, customerTaxId: source.customerTaxId, customerAddress: source.customerAddress, customerPhone: source.customerPhone,
    subtotal: Number(source.subtotal) || 0, discount: Number(source.discount) || 0, vatRate: parseVat(source.vatRate), vatAmount: Number(source.vatAmount) || 0, total: Number(source.total) || 0,
    notes: 'อ้างอิง ' + source.number, projectName: source.projectName || '', whtRate: parseWht(source.whtRate), status: targetType === 'receipt' ? 'paid' : 'draft',
    variant: targetType === 'receipt' ? 'receipt' : '', sourceDocumentId: String(source.id), createdAt: now, updatedAt: now, createdBy: ctx.username() });
  await ctx.insertMany('document_items', items.map((x, i) => ({ id: uuid(), documentId: id, lineNo: i + 1, description: x.description, quantity: Number(x.quantity), unit: x.unit,
    price: Number(x.price), discount: Number(x.discount), amount: Number(x.amount) })));
  if (targetType === 'receipt') await syncInvoicePaidState(ctx, String(source.id));
  await ctx.log(id, 'CONVERT', source.number + ' -> ' + number);
  return { success: true, id, number };
}

// ---------- สรุปยอดขาย / ภาษีหัก ณ ที่จ่าย ----------
async function getSummary(ctx, opts) {
  opts = opts || {};
  const { expStatusOf } = require('./modules');
  const thisYear = yearNow(), year = Number(opts.year) || thisYear, month = Number(opts.month) || 0;
  const type = (SALES_TYPES.includes(opts.type) || opts.type === 'expense' || opts.type === 'product') ? opts.type : 'invoice';
  const mode = ['all', 'issued', 'paid'].includes(opts.status) ? opts.status : 'all';
  const cust = clean(opts.customer, 250);
  const years = new Set([thisYear, year]), names = new Set(), rows = [];
  const inPeriod = date => { const y = Number(date.slice(0, 4)); if (y) years.add(y); return y === year && (!month || Number(date.slice(5, 7)) === month); };
  if (type === 'expense') {
    const catBy = {};   // หมวดหมู่ตามรายการ (เหมือนหน้ารายการค่าใช้จ่าย)
    for (const i of await ctx.all("SELECT ei.expense_id, ei.category FROM expense_items ei JOIN expenses e ON e.id = ei.expense_id WHERE e.tenant_id = $1", [ctx.tenantId])) {
      const k = String(i.expenseId); if (i.category) (catBy[k] = catBy[k] || new Set()).add(String(i.category));
    }
    for (const e of await ctx.all('SELECT * FROM expenses WHERE tenant_id = $1', [ctx.tenantId])) {
      const date = dateOut(e.date), st = expStatusOf(e.status), per = inPeriod(date);
      if (st === 'cancelled') continue;
      const name = String(e.vendorName || '').trim();
      if (name) names.add(name);
      if (!per || (mode === 'paid' && st !== 'paid') || (cust && name !== cust)) continue;
      const total = Number(e.total) || 0, wht = Number(e.whtAmount) || 0;
      rows.push({ id: String(e.id), number: String(e.number), date, customerName: name, category: String(e.category || ''), categories: catBy[String(e.id)] ? [...catBy[String(e.id)]] : [String(e.category || 'อื่นๆ')], status: st, net: Number(e.amountBeforeVat) || 0,
        vat: Number(e.vatAmount) || 0, total, whtRate: Number(e.whtRate) || 0, wht, payable: round2(total - wht) });
    }
  } else if (type === 'product') {
    const docs = await ctx.all("SELECT * FROM documents WHERE tenant_id = $1 AND type IN ('receipt','cashsale') AND status <> 'cancelled'", [ctx.tenantId]);
    const itemsBy = {};
    (await ctx.all('SELECT * FROM document_items WHERE tenant_id = $1 ORDER BY line_no', [ctx.tenantId])).forEach(i => { (itemsBy[String(i.documentId)] = itemsBy[String(i.documentId)] || []).push(i); });
    docs.forEach(d => {
      const date = dateOut(d.date), per = inPeriod(date), name = String(d.customerName || '').trim();
      if (name) names.add(name);
      if (!per || (mode === 'paid' && d.status !== 'paid') || (cust && name !== cust)) return;
      const sub = Number(d.subtotal) || 0; if (sub <= 0) return;
      const k = (sub - (Number(d.discount) || 0)) / sub, vk = (Number(d.vatAmount) || 0) / sub;
      (itemsBy[String(d.id)] || []).forEach(i => {
        const amt = Number(i.amount) || 0, net = round2(amt * k), vat = round2(amt * vk);
        rows.push({ id: String(d.id), number: String(d.number), date, customerName: name, status: String(d.status), item: String(i.description || ''),
          qty: Number(i.quantity) || 0, unit: String(i.unit || ''), net, vat, total: round2(net + vat), whtRate: 0, wht: 0, payable: round2(net + vat) });
      });
    });
  } else {
    for (const d of await ctx.all('SELECT * FROM documents WHERE tenant_id = $1', [ctx.tenantId])) {
      const date = dateOut(d.date), per = inPeriod(date);
      if (d.status === 'cancelled') continue;
      const name = String(d.customerName || '').trim();
      if (name) names.add(name);
      if (d.type !== type) continue;
      if (mode === 'issued' && !['issued', 'paid'].includes(d.status)) continue;
      if (mode === 'paid' && d.status !== 'paid') continue;
      if (!per || (cust && name !== cust)) continue;
      const net = round2((Number(d.subtotal) || 0) - (Number(d.discount) || 0));
      const wr = Number(d.whtRate) || 0, wht = round2(net * wr / 100), total = Number(d.total) || 0;
      rows.push({ id: String(d.id), number: String(d.number), date, customerName: name, status: String(d.status), net, vat: Number(d.vatAmount) || 0, total, whtRate: wr, wht, payable: round2(total - wht) });
    }
  }
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.number < b.number ? -1 : 1);
  return { year, month, type, docs: rows, customers: [...names].sort(localeTh), years: [...years].sort((a, b) => b - a) };
}

module.exports = { SALES_TYPES, PAID_TYPES, getCompany, getActiveCompanyId, getCompanySettings, getLogoPreview, saveCompanySettings,
  listDocuments, getDocument, getDocHistory, saveDocument, convertDocument, deleteDocument, getSummary, findDoc, docItems, pubDocRow, syncInvoicePaidState };
