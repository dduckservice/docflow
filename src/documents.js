// ============================================================
//  documents.js — เอกสารขาย, ข้อมูลบริษัท, สรุปยอด (เดิม: Code.gs)
// ============================================================
const { uuid, fail, clean, num, round2, parseVat, parseWht, dateOut, tsOut, isYmd, todayStr, compactDay, yearNow, localeTh, VAT_RATE } = require('./util');

const PAY_METHODS = ['cash', 'cheque', 'transfer', 'card'];
// Phase 2: เพิ่ม deposit (ใบรับเงินมัดจำ/ใบกำกับภาษี) — รับเงินทันที + เป็นใบกำกับภาษีของยอดมัดจำ
const SALES_TYPES = ['quotation', 'invoice', 'taxinvoice', 'receipt', 'cashsale', 'deposit'];
const PAID_TYPES = ['receipt', 'cashsale', 'deposit'];
const DEPOSIT_DEDUCT_TYPES = ['invoice', 'taxinvoice', 'receipt', 'cashsale'];   // เอกสารงวดที่หักมัดจำได้
// Phase 1: ใบเสนอราคามีขั้นอนุมัติ — รออนุมัติ (pending) → อนุมัติ (approved) / ไม่อนุมัติ (rejected)
// คงค่าเดิม draft/issued ไว้เพื่อความเข้ากันได้กับข้อมูลเก่า (issued = ถือว่าอนุมัติแล้ว)
const STATUS_BY_TYPE = { quotation: ['draft', 'pending', 'approved', 'issued', 'rejected', 'cancelled'], invoice: ['draft', 'issued', 'paid', 'cancelled'], taxinvoice: ['draft', 'issued', 'cancelled'], receipt: ['paid', 'cancelled'], cashsale: ['paid', 'cancelled'], deposit: ['paid', 'cancelled'] };
const STATUS_RANK = { draft: 0, pending: 0, rejected: 0, approved: 1, issued: 1, paid: 2 };
const QUOTE_APPROVED = ['approved', 'issued'];   // ใบเสนอราคาที่สร้างเอกสารต่อได้
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

// ---------- Phase 2: เงินมัดจำ ----------
// ใบรับเงินมัดจำ (สถานะ 'paid' เท่านั้น — ไม่นับใบวางบิลมัดจำที่ยังไม่ได้รับเงิน, ยกเลิกแล้วไม่นับ) ของใบเสนอราคาหนึ่ง — ฐานมัดจำรวม = ผลรวม subtotal (ก่อน VAT)
async function depositsOfQuotation(ctx, quotationId) {
  // นับเอกสารมัดจำด้วย variant='deposit' (ออกเป็น type ได้หลายแบบ: ใบวางบิล/ใบกำกับ-ใบเสร็จ/เงินสด)
  const rows = await ctx.all("SELECT id, number, date, subtotal, vat_amount, total, status FROM documents WHERE tenant_id = $1 AND variant = 'deposit' AND source_document_id = $2 AND status = 'paid' ORDER BY date, number", [ctx.tenantId, String(quotationId)]);
  const base = round2(rows.reduce((s, r) => s + (Number(r.subtotal) || 0), 0));
  const vat = round2(rows.reduce((s, r) => s + (Number(r.vatAmount) || 0), 0));
  const paid = round2(rows.reduce((s, r) => s + (Number(r.total) || 0), 0));
  return { rows, base, vat, paid, refs: rows.map(r => String(r.number)) };
}
// สรุปยอดคงเหลือของใบเสนอราคา: มูลค่างาน (ฐานก่อน VAT) − มัดจำที่รับแล้ว
async function quotationBalance(ctx, quotationId) {
  const q = await findDoc(ctx, quotationId);
  if (!q || q.type !== 'quotation') return null;
  const quotationNet = round2((Number(q.subtotal) || 0) - (Number(q.discount) || 0));
  const dep = await depositsOfQuotation(ctx, quotationId);
  return { quotationId: String(q.id), quotationNumber: q.number, quotationNet, vatRate: Number(q.vatRate) || 0,
    depositBase: dep.base, depositVat: dep.vat, depositPaid: dep.paid, remaining: round2(quotationNet - dep.base),
    refs: dep.refs, deposits: dep.rows.map(r => ({ id: String(r.id), number: String(r.number), date: dateOut(r.date), base: Number(r.subtotal) || 0, vat: Number(r.vatAmount) || 0, total: Number(r.total) || 0 })) };
}
// มีเอกสารงวด (ใบแจ้งหนี้/ใบกำกับ/ใบเสร็จ ที่ยังไม่ยกเลิก) ที่สร้างต่อจากใบเสนอราคานี้แล้วหรือยัง (ใช้กันการลบ/ยกเลิกมัดจำย้อนหลัง)
async function hasFinalForQuotation(ctx, quotationId) {
  return !!(await ctx.one("SELECT 1 FROM documents WHERE tenant_id = $1 AND source_document_id = $2 AND type IN ('invoice','taxinvoice','receipt','cashsale') AND COALESCE(variant,'') <> 'deposit' AND status <> 'cancelled' AND COALESCE(deposit_amount,0) > 0 LIMIT 1", [ctx.tenantId, String(quotationId)]));
}

// ---------- Phase 3: แบ่งงวด ----------
// ใบวางบิล/ใบแจ้งหนี้ (type='invoice') ทั้งหมดที่ออกจากใบเสนอราคานี้ = การวางบิลจริง (ไม่นับโซ่ taxinvoice/receipt ที่แปลงต่อ)
// สรุป: มูลค่างานเต็ม − ยอดที่วางบิลไปแล้ว = คงเหลือที่ยังวางบิลได้
async function quotationBilling(ctx, quotationId) {
  const q = await findDoc(ctx, quotationId);
  if (!q || q.type !== 'quotation') return null;
  const fullNet = round2((Number(q.subtotal) || 0) - (Number(q.discount) || 0));
  // นับเฉพาะเอกสารวางบิล "ต้นทาง" ที่ออกจากใบเสนอราคาโดยตรง (ไม่นับโซ่ที่แปลงต่อ และไม่นับเอกสารมัดจำ)
  const rows = await ctx.all("SELECT id, number, date, type, subtotal, deposit_amount, installment_no, installment_pct, status FROM documents WHERE tenant_id = $1 AND source_document_id = $2 AND type IN ('invoice','taxinvoice','receipt','cashsale') AND COALESCE(variant,'') <> 'deposit' AND status <> 'cancelled' ORDER BY installment_no, number", [ctx.tenantId, String(quotationId)]);
  const billedBase = round2(rows.reduce((s, r) => s + (Number(r.subtotal) || 0), 0));
  const maxNo = rows.reduce((m, r) => Math.max(m, Number(r.installmentNo) || 0), 0);
  const hasInstallment = rows.some(r => (Number(r.installmentNo) || 0) > 0);
  const hasFull = rows.some(r => (Number(r.installmentNo) || 0) === 0);
  const depDeducted = round2(rows.reduce((s, r) => s + (Number(r.depositAmount) || 0), 0));
  return { quotationId: String(q.id), quotationNumber: q.number, fullNet, vatRate: Number(q.vatRate) || 0,
    billedBase, remaining: round2(fullNet - billedBase), nextNo: maxNo + 1, hasInstallment, hasFull, depDeducted,
    installments: rows.map(r => ({ id: String(r.id), number: String(r.number), date: dateOut(r.date), no: Number(r.installmentNo) || 0, pct: Number(r.installmentPct) || 0, base: Number(r.subtotal) || 0, deposit: Number(r.depositAmount) || 0 })) };
}

async function listDocuments(ctx, keyword) {
  const q = clean(keyword, 200).toLowerCase();
  // กรองและจำกัด 500 รายการล่าสุดในฐานข้อมูล (ไม่ดึงเอกสารทั้งหมดของบริษัทมาทุกครั้ง)
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const rows = await ctx.all(`SELECT * FROM documents WHERE tenant_id = $1 AND ($2 = '' OR lower(COALESCE(number,'')) LIKE $3 OR lower(COALESCE(type,'')) LIKE $3
      OR lower(COALESCE(customer_name,'')) LIKE $3 OR lower(COALESCE(status,'')) LIKE $3) ORDER BY updated_at DESC LIMIT 500`, [ctx.tenantId, q, like]);
  const out = rows.map(pubDocRow);
  // สถานะย่อยของใบเสนอราคา: มีมัดจำ / แบ่งงวด / วางบิลแล้ว / วางบิลครบ (คำนวณจากเอกสารลูก)
  const qIds = out.filter(r => r.type === 'quotation').map(r => r.id);
  if (qIds.length) {
    const agg = await ctx.all(`SELECT source_document_id::text AS sid,
        COALESCE(SUM(CASE WHEN variant = 'deposit' THEN subtotal ELSE 0 END),0) AS dep,
        COALESCE(SUM(CASE WHEN type IN ('invoice','taxinvoice','receipt','cashsale') AND COALESCE(variant,'') <> 'deposit' THEN subtotal ELSE 0 END),0) AS billed,
        COALESCE(MAX(CASE WHEN type IN ('invoice','taxinvoice','receipt','cashsale') AND COALESCE(variant,'') <> 'deposit' AND installment_no > 0 THEN 1 ELSE 0 END),0) AS has_inst
      FROM documents WHERE tenant_id = $1 AND source_document_id = ANY($2::uuid[]) AND status <> 'cancelled' GROUP BY source_document_id`, [ctx.tenantId, qIds]);
    const by = {}; agg.forEach(a => { by[String(a.sid)] = a; });
    out.forEach(r => {
      if (r.type !== 'quotation') return;
      const a = by[String(r.id)]; if (!a) { r.billTags = []; return; }
      const fullNet = round2((Number(r.subtotal) || 0) - (Number(r.discount) || 0));
      const dep = Number(a.dep) || 0, billed = Number(a.billed) || 0, hasInst = Number(a.hasInst) > 0, tags = [];
      if (billed > 0 && billed >= fullNet - 0.009) tags.push('วางบิลครบ');
      else if (hasInst) tags.push('แบ่งงวด');
      else if (billed > 0) tags.push('วางบิลแล้ว');
      if (dep > 0) tags.push('มีมัดจำ');
      r.billTags = tags;
    });
  }
  return out;
}
async function getDocument(ctx, id) {
  const d = await findDoc(ctx, id);
  if (!d) fail('ไม่พบเอกสาร');
  const o = pubDocRow(d); o.items = await docItems(ctx, d.id);
  // Phase 2: ใบเสนอราคา → แนบสรุปยอดมัดจำ/คงเหลือ; เอกสารงวดที่หักมัดจำ → รายละเอียดใบรับมัดจำที่อ้างอิง
  if (d.type === 'quotation') { o.depositInfo = await quotationBalance(ctx, d.id); o.billingInfo = await quotationBilling(ctx, d.id); }
  else if (DEPOSIT_DEDUCT_TYPES.includes(d.type) && (Number(d.depositAmount) || 0) > 0 && d.sourceDocumentId) o.depositInfo = await quotationBalance(ctx, d.sourceDocumentId);
  // Phase 3: งวด → แนบสรุปการแบ่งงวดของใบเสนอราคาต้นทาง
  if (DEPOSIT_DEDUCT_TYPES.includes(d.type) && (Number(d.installmentNo) || 0) > 0 && d.sourceDocumentId) o.billingInfo = await quotationBilling(ctx, d.sourceDocumentId);
  return o;
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
  const prefix = { quotation: 'QT', invoice: 'INV', taxinvoice: 'TX', receipt: 'RC', cashsale: 'CS', deposit: 'DP' }[type];
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
  // Phase 2: ลบใบรับเงินมัดจำไม่ได้ ถ้าใบเสนอราคาออกเอกสารงวดที่หักมัดจำไปแล้ว (ยอดหักจะเพี้ยน)
  if (d.type === 'deposit' && d.sourceDocumentId && await hasFinalForQuotation(ctx, d.sourceDocumentId))
    fail('ลบไม่ได้: ใบเสนอราคานี้ออกเอกสารงวดที่หักมัดจำแล้ว กรุณายกเลิก/ลบเอกสารงวดนั้นก่อน');
  // เก็บเอกสารทั้งชุด + ไฟล์แนบ + PDF ไว้ในถังขยะ (Super Admin กู้คืนได้ภายใน 30 วัน)
  await require('./trash').trashRecord(ctx, { kind: 'document', table: 'documents', itemsTable: 'document_items', fk: 'document_id', id: d.id, number: d.number, docType: d.type, label: d.customerName });
  await ctx.exec('DELETE FROM documents WHERE id = $1 AND tenant_id = $2', [d.id, ctx.tenantId]);   // รายการสินค้าถูกลบตาม (ON DELETE CASCADE) — ใส่ tenant condition ประกอบกัน ref ครั้งหน้าพลาด
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
  // Phase 2: หักเงินมัดจำ (ฐานก่อน VAT) ออกจากมูลค่างานเต็ม แล้วคิด VAT เฉพาะส่วนที่เหลือ (ไม่คิด VAT ซ้ำ)
  // แก้ไขเอกสารเดิม = คงยอดมัดจำเดิมไว้ (ผูกกับใบรับมัดจำ); สร้างใหม่โดยตรง = ตามที่ส่งเข้ามา (ปกติ 0)
  let depositAmount = DEPOSIT_DEDUCT_TYPES.includes(input.type)
    ? round2(old ? (Number(old.depositAmount) || 0) : num(input.depositAmount || 0, 'ยอดหักมัดจำ'))
    : 0;
  if (depositAmount < 0) fail('ยอดหักมัดจำไม่ถูกต้อง');
  const depositRef = DEPOSIT_DEDUCT_TYPES.includes(input.type) ? clean(old ? (old.depositRef || '') : (input.depositRef || ''), 300) : '';
  const net = round2(subtotal - discount - depositAmount), vatRate = parseVat(input.vatRate), vatAmount = round2(net * vatRate / 100), total = round2(net + vatAmount);
  if (net < 0) fail('ยอดหักมัดจำมากกว่ามูลค่าเอกสาร');
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
  if (!['draft', 'pending', 'approved', 'issued', 'paid', 'rejected', 'cancelled'].includes(status)) fail('สถานะไม่ถูกต้อง');
  // Phase 1: ใบเสนอราคาที่สร้างใหม่ เริ่มที่ "รออนุมัติ" (pending) — ห้ามส่งสถานะเกินกว่านี้มาตอนสร้าง (กันผู้สร้างอนุมัติตัวเองทันที)
  if (!old && input.type === 'quotation' && !['draft', 'pending'].includes(status)) status = 'pending';
  if (!old && input.type === 'quotation' && (status === 'draft' || !input.status)) status = 'pending';
  if (PAID_TYPES.includes(input.type)) status = (old && status === 'cancelled') ? 'cancelled' : 'paid';
  if (!STATUS_BY_TYPE[input.type].includes(status) && !(old && status === prevStatus)) fail('สถานะนี้ใช้กับเอกสารประเภทนี้ไม่ได้');
  if (old && status !== prevStatus && status !== 'cancelled' && STATUS_RANK[status] < STATUS_RANK[prevStatus]) fail('ไม่สามารถย้อนสถานะเอกสารได้ หากต้องแก้ไขให้ยกเลิกแล้วออกเอกสารใหม่');
  // Phase 2: กันการยกเลิก/แก้ยอดใบรับมัดจำ ถ้าใบเสนอราคานั้นออกเอกสารงวด (หักมัดจำ) ไปแล้ว — ต้องยกเลิกเอกสารงวดก่อน
  if (old && input.type === 'deposit' && old.sourceDocumentId) {
    const becameCancelled = status === 'cancelled' && prevStatus !== 'cancelled';
    const baseChanged = round2(Number(old.subtotal) || 0) !== subtotal;
    if ((becameCancelled || baseChanged) && await hasFinalForQuotation(ctx, old.sourceDocumentId))
      fail('ใบเสนอราคานี้ออกเอกสารงวดที่หักมัดจำแล้ว กรุณายกเลิกเอกสารงวดนั้นก่อนจึงจะแก้/ยกเลิกใบรับมัดจำได้');
  }
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
    depositAmount, depositRef,
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
  // Security Review M1: แก้ "เนื้อหา" ใบเสนอราคาที่เคยอนุมัติแล้ว → ตีกลับเป็น รออนุมัติอัตโนมัติ (ต้องได้รับอนุมัติใหม่ก่อนจึงออกเอกสารต่อได้)
  const reapprove = !!(old && input.type === 'quotation' && prevStatus === 'approved' && changes.length && status === 'approved');
  if (reapprove) { status = record.status = 'pending'; record.updatedAt = new Date(); }
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
  if (!['invoice', 'taxinvoice', 'receipt', 'cashsale'].includes(targetType)) fail('ประเภทปลายทางไม่ถูกต้อง');
  await ctx.lock('tenant:' + ctx.tenantId);
  const source = await findDoc(ctx, sourceId);
  if (!source) fail('ไม่พบเอกสารต้นทาง');
  if (source.status === 'cancelled') fail('ไม่สามารถแปลงเอกสารที่ยกเลิกแล้ว');
  if (source.status === 'rejected') fail('ใบเสนอราคานี้ไม่อนุมัติ จึงสร้างเอกสารต่อไม่ได้');
  // Phase 1: ต้องอนุมัติใบเสนอราคาก่อน จึงจะสร้างเอกสารต่อได้
  if (source.type === 'quotation' && !QUOTE_APPROVED.includes(String(source.status))) fail('กรุณาอนุมัติใบเสนอราคาก่อนสร้างเอกสารต่อ (กดที่สถานะ → อนุมัติ)');
  // ประเภทปลายทางตามต้นทาง — ใบเสนอราคา → ใบวางบิล/ใบกำกับ-ใบเสร็จ/เงินสด (วางบิลเต็มจำนวน) · ใบวางบิล → ใบกำกับภาษี/ใบกำกับ-ใบเสร็จ · ใบกำกับภาษี → ใบกำกับ-ใบเสร็จ
  if (['invoice', 'cashsale'].includes(targetType) && source.type !== 'quotation') fail('สร้างเอกสารนี้จากใบเสนอราคาเท่านั้น');
  if (targetType === 'taxinvoice' && source.type !== 'invoice') fail('สร้างใบกำกับภาษีจากใบแจ้งหนี้เท่านั้น');
  if (targetType === 'receipt' && !['quotation', 'invoice', 'taxinvoice'].includes(source.type)) fail('สร้างใบเสร็จจากใบเสนอราคา/ใบแจ้งหนี้/ใบกำกับภาษีเท่านั้น');
  // Phase 3: วางบิลเต็มจำนวนจากใบเสนอราคา — ห้ามปนกับการแบ่งงวด
  if (source.type === 'quotation' && ['invoice', 'receipt', 'cashsale'].includes(targetType)) {
    const b = await quotationBilling(ctx, source.id);
    if (b && b.hasInstallment) fail('ใบเสนอราคานี้แบ่งงวดแล้ว กรุณาสร้างงวดถัดไปผ่านปุ่ม "แบ่งงวด"');
  }
  if ((targetType === 'taxinvoice' && parseVat(source.vatRate) === 0)) fail('ใบแจ้งหนี้นี้ไม่คิด VAT จึงออกใบกำกับภาษีไม่ได้');
  const comp = await getCompany(ctx, false);
  if (targetType === 'taxinvoice' && String(comp.vatRegistered || '') === 'no') fail('บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม ออกใบกำกับภาษีไม่ได้');
  const existing = await ctx.one("SELECT id, number FROM documents WHERE tenant_id = $1 AND source_document_id = $2 AND type = $3 AND COALESCE(variant,'') <> 'deposit' AND status <> 'cancelled' LIMIT 1", [ctx.tenantId, source.id, targetType]);
  if (existing) return { success: true, id: existing.id, number: existing.number, alreadyExists: true };
  // วางบิลเต็มจำนวนจากใบเสนอราคาซ้ำ (มีเอกสารวางบิลต้นทางอื่นอยู่แล้ว)
  if (source.type === 'quotation' && ['invoice', 'receipt', 'cashsale'].includes(targetType)) {
    const b = await quotationBilling(ctx, source.id);
    if (b && b.billedBase > 0.009) fail('ใบเสนอราคานี้ออกเอกสารวางบิลแล้ว');
  }
  const items = await ctx.all('SELECT * FROM document_items WHERE document_id = $1 ORDER BY line_no', [source.id]);
  if (!items.length) fail('เอกสารต้นทางไม่มีรายการสินค้า/บริการ');
  const id = uuid(), now = new Date(), number = await nextNumber(ctx, targetType);
  // Phase 2: หักเงินมัดจำที่รับไว้แล้ว (ถ้าต้นทางเป็นใบเสนอราคาที่มีมัดจำ) แล้วส่งต่อการหักไปยังเอกสารงวดถัดไป
  let depBase = 0, depRef = '';
  if (source.type === 'quotation') { const dep = await depositsOfQuotation(ctx, source.id); depBase = dep.base; depRef = dep.refs.join(','); }
  else if (DEPOSIT_DEDUCT_TYPES.includes(source.type)) { depBase = round2(Number(source.depositAmount) || 0); depRef = String(source.depositRef || ''); }
  const cSub = round2(Number(source.subtotal) || 0), cDisc = round2(Number(source.discount) || 0), cVatRate = parseVat(source.vatRate);
  const cNet = round2(cSub - cDisc - depBase), cVat = round2(cNet * cVatRate / 100), cTotal = round2(cNet + cVat);
  const cNotes = 'อ้างอิง ' + source.number + (depBase > 0 ? ' · หักมัดจำ ' + depRef : '');
  await ctx.insert('documents', { id, number, type: targetType, companyId: String(source.companyId || comp.id), date: todayStr(), dueDate: '',
    customerName: source.customerName, customerTaxId: source.customerTaxId, customerAddress: source.customerAddress, customerPhone: source.customerPhone,
    subtotal: cSub, discount: cDisc, vatRate: cVatRate, vatAmount: cVat, total: cTotal, depositAmount: depBase, depositRef: depRef,
    notes: cNotes, projectName: source.projectName || '', whtRate: parseWht(source.whtRate), status: ['receipt', 'cashsale'].includes(targetType) ? 'paid' : 'draft',
    variant: targetType === 'receipt' ? 'receipt' : '', sourceDocumentId: String(source.id), createdAt: now, updatedAt: now, createdBy: ctx.username() });
  await ctx.insertMany('document_items', items.map((x, i) => ({ id: uuid(), documentId: id, lineNo: i + 1, description: x.description, quantity: Number(x.quantity), unit: x.unit,
    price: Number(x.price), discount: Number(x.discount), amount: Number(x.amount) })));
  if (targetType === 'receipt') await syncInvoicePaidState(ctx, String(source.id));
  await ctx.log(id, 'CONVERT', source.number + ' -> ' + number);
  return { success: true, id, number };
}

// Phase 1: อนุมัติ / ไม่อนุมัติ ใบเสนอราคา (จากเมนูสถานะในหน้ารายการ)
async function setDocStatus(ctx, id, action) {
  await ctx.lock('tenant:' + ctx.tenantId);
  const d = await findDoc(ctx, id);
  if (!d) fail('ไม่พบเอกสาร');
  if (d.type !== 'quotation') fail('ปรับสถานะอนุมัติได้เฉพาะใบเสนอราคา');
  if (d.status === 'cancelled') fail('เอกสารนี้ถูกยกเลิกแล้ว');
  const cur = String(d.status || '');
  let next;
  if (action === 'approve') {
    if (QUOTE_APPROVED.includes(cur)) return { success: true, id: String(d.id), status: cur, number: d.number };
    if (!['draft', 'pending', 'rejected'].includes(cur)) fail('สถานะปัจจุบันอนุมัติไม่ได้');
    next = 'approved';
  } else if (action === 'reject') {
    if (QUOTE_APPROVED.includes(cur) && await ctx.one("SELECT 1 FROM documents WHERE tenant_id = $1 AND source_document_id = $2 AND status <> 'cancelled' LIMIT 1", [ctx.tenantId, d.id]))
      fail('ใบเสนอราคานี้มีเอกสารที่สร้างต่อแล้ว ไม่สามารถเปลี่ยนเป็นไม่อนุมัติได้');
    next = 'rejected';
  } else fail('คำสั่งไม่ถูกต้อง');
  await ctx.update('documents', d.id, { status: next, updatedAt: new Date() });
  await ctx.log(d.id, 'STATUS', d.number + ': ' + cur + '→' + next + (action === 'approve' ? ' (อนุมัติ)' : ' (ไม่อนุมัติ)'));
  return { success: true, id: String(d.id), status: next, number: d.number };
}

// Phase 2: รับเงินมัดจำจากใบเสนอราคา → ออกใบรับเงินมัดจำ/ใบกำกับภาษี (คิด VAT บนยอดมัดจำ ณ วันรับเงิน)
async function createDeposit(ctx, quotationId, input) {
  input = input || {};
  await ctx.lock('tenant:' + ctx.tenantId);
  const q = await findDoc(ctx, quotationId);
  if (!q) fail('ไม่พบใบเสนอราคา');
  if (q.type !== 'quotation') fail('รับเงินมัดจำได้จากใบเสนอราคาเท่านั้น');
  if (q.status === 'cancelled') fail('ใบเสนอราคานี้ถูกยกเลิกแล้ว');
  if (!QUOTE_APPROVED.includes(String(q.status))) fail('กรุณาอนุมัติใบเสนอราคาก่อนรับเงินมัดจำ (กดที่สถานะ → อนุมัติ)');
  const bal = await quotationBalance(ctx, quotationId);
  const amount = round2(num(input.amount, 'ยอดเงินมัดจำ'));
  if (amount <= 0) fail('กรุณาระบุยอดเงินมัดจำที่มากกว่า 0');
  if (amount > bal.remaining + 0.009) fail('ยอดเงินมัดจำเกินยอดคงเหลือ (คงเหลือ ' + bal.remaining.toLocaleString('th-TH') + ' บาท)');
  const comp = await getCompany(ctx, false);
  const vatReg = String(comp.vatRegistered || '') !== 'no';
  // ใบรับเงินมัดจำของกิจการจด VAT = ใบกำกับภาษี → ต้องคิด VAT บนยอดมัดจำ (จุดรับผิด VAT เกิด ณ วันรับเงิน)
  const vatRate = vatReg ? parseVat(input.vatRate) : 0;
  if (vatReg && vatRate === 0) fail('กิจการจดทะเบียน VAT ใบรับเงินมัดจำต้องคิด VAT');
  const date = clean(input.date, 10) || todayStr();
  if (!isYmd(date)) fail('วันที่รับเงินมัดจำไม่ถูกต้อง');
  // ประเภทเอกสารมัดจำ (variant='deposit' เสมอ เพื่อคุมยอดมัดจำ): deposit=ใบรับเงินมัดจำ/ใบกำกับภาษี(รับเงินแล้ว) · invoice=ใบวางบิลมัดจำ(ยังไม่รับเงิน) · cashsale=เงินสด
  const docType = ['deposit', 'invoice', 'cashsale'].includes(input.docType) ? input.docType : 'deposit';
  const paid = docType !== 'invoice';
  const net = amount, vatAmount = round2(net * vatRate / 100), total = round2(net + vatAmount);
  const payDate = paid ? (clean(input.payDate, 10) || date) : '';
  if (payDate && !isYmd(payDate)) fail('วันที่ชำระเงินไม่ถูกต้อง');
  const payMethods = paid ? (String(input.payMethods || 'transfer').split(',').map(s => s.trim()).filter((s, i, a) => PAY_METHODS.includes(s) && a.indexOf(s) === i).join(',') || 'transfer') : '';
  const id = uuid(), now = new Date(), number = await nextNumber(ctx, docType);
  const noun = paid ? 'รับเงินมัดจำ' : 'วางบิลเงินมัดจำ';
  await ctx.insert('documents', { id, number, type: docType, companyId: String(q.companyId || comp.id), date, dueDate: '',
    customerName: q.customerName, customerTaxId: q.customerTaxId, customerAddress: q.customerAddress, customerPhone: q.customerPhone,
    subtotal: net, discount: 0, vatRate, vatAmount, total, whtRate: 0, depositAmount: 0, depositRef: '',
    notes: noun + 'ตามใบเสนอราคา ' + q.number + (clean(input.notes, 1000) ? ' — ' + clean(input.notes, 1000) : ''),
    projectName: q.projectName || '', status: paid ? 'paid' : 'draft', variant: 'deposit', sourceDocumentId: String(q.id),
    payMethods, payBank: paid ? clean(input.payBank, 100) : '', payNo: paid ? clean(input.payNo, 100) : '', payDate, payAmount: paid ? String(total) : '',
    createdAt: now, updatedAt: now, createdBy: ctx.username() });
  await ctx.insertMany('document_items', [{ id: uuid(), documentId: id, lineNo: 1,
    description: 'เงินมัดจำ (อ้างอิงใบเสนอราคา ' + q.number + ')', quantity: 1, unit: 'รายการ', price: net, discount: 0, amount: net }]);
  await ctx.log(id, 'CREATE', number + ' | ' + noun + ' ' + net.toLocaleString('th-TH') + ' (VAT ' + vatAmount.toLocaleString('th-TH') + ') จาก ' + q.number);
  const after = await quotationBalance(ctx, quotationId);
  return { success: true, id, number, type: docType, depositBase: net, vatAmount, total, remaining: after.remaining };
}

// Phase 3: สร้างใบวางบิลแบ่งงวดจากใบเสนอราคา (ระบุเป็น % หรือยอดเงิน) — รวมทุกงวด = มูลค่างานเต็ม
async function createInstallment(ctx, quotationId, input) {
  input = input || {};
  await ctx.lock('tenant:' + ctx.tenantId);
  const q = await findDoc(ctx, quotationId);
  if (!q) fail('ไม่พบใบเสนอราคา');
  if (q.type !== 'quotation') fail('แบ่งงวดได้จากใบเสนอราคาเท่านั้น');
  if (q.status === 'cancelled') fail('ใบเสนอราคานี้ถูกยกเลิกแล้ว');
  if (!QUOTE_APPROVED.includes(String(q.status))) fail('กรุณาอนุมัติใบเสนอราคาก่อนแบ่งงวด (กดที่สถานะ → อนุมัติ)');
  const bill = await quotationBilling(ctx, quotationId);
  if (bill.hasFull) fail('ใบเสนอราคานี้ออกใบวางบิลเต็มจำนวนแล้ว ไม่สามารถแบ่งงวดได้');
  if (bill.remaining <= 0.009) fail('วางบิลครบมูลค่างานแล้ว');
  // ฐานงวด: ระบุเป็นยอดเงิน หรือเป็น %
  let base, pct;
  if (input.amount !== undefined && input.amount !== '' && input.amount !== null) {
    base = round2(num(input.amount, 'ยอดงวด'));
    pct = bill.fullNet > 0 ? round2(base / bill.fullNet * 100) : 0;
  } else {
    pct = round2(num(input.pct, 'เปอร์เซ็นต์งวด'));
    if (pct <= 0 || pct > 100) fail('เปอร์เซ็นต์งวดต้องอยู่ระหว่าง 0–100');
    base = round2(bill.fullNet * pct / 100);
  }
  if (base <= 0) fail('ยอดงวดต้องมากกว่า 0');
  if (base > bill.remaining + 0.009) fail('ยอดงวดเกินยอดคงเหลือ (คงเหลือ ' + bill.remaining.toLocaleString('th-TH') + ' บาท)');
  const comp = await getCompany(ctx, false);
  const vr = parseVat(q.vatRate);
  // หักเงินมัดจำในงวดนี้ (ถ้าเลือก) — ไม่เกินมัดจำที่ยังไม่ถูกหัก และไม่เกินฐานงวด
  let dep = 0, depRef = '';
  if (input.deductDeposit) {
    const d = await depositsOfQuotation(ctx, quotationId);
    const avail = round2(d.base - bill.depDeducted);
    dep = round2(Math.min(Math.max(0, avail), base));
    if (dep > 0) depRef = d.refs.join(',');
  }
  const net = round2(base - dep), vat = round2(net * vr / 100), total = round2(net + vat);
  const date = clean(input.date, 10) || todayStr();
  if (!isYmd(date)) fail('วันที่ไม่ถูกต้อง');
  const no = bill.nextNo, pctLabel = Number.isInteger(pct) ? String(pct) : String(round2(pct));
  const label = clean(input.label, 200) || ('งวดที่ ' + no + (pct ? ' (' + pctLabel + '%)' : ''));
  // ประเภทเอกสารงวด: invoice=ใบวางบิล(ยังไม่รับเงิน) · receipt=ใบกำกับภาษี/ใบเสร็จ(รับเงินแล้ว) · cashsale=เงินสด
  const docType = ['invoice', 'receipt', 'cashsale'].includes(input.docType) ? input.docType : 'invoice';
  const paid = PAID_TYPES.includes(docType);
  const payDate = paid ? (clean(input.payDate, 10) || date) : '';
  const payMethods = paid ? (String(input.payMethods || 'transfer').split(',').map(s => s.trim()).filter((s, i, a) => PAY_METHODS.includes(s) && a.indexOf(s) === i).join(',') || 'transfer') : '';
  const id = uuid(), now = new Date(), number = await nextNumber(ctx, docType);
  await ctx.insert('documents', { id, number, type: docType, companyId: String(q.companyId || comp.id), date, dueDate: clean(input.dueDate, 10),
    customerName: q.customerName, customerTaxId: q.customerTaxId, customerAddress: q.customerAddress, customerPhone: q.customerPhone,
    subtotal: base, discount: 0, vatRate: vr, vatAmount: vat, total, whtRate: parseWht(q.whtRate),
    depositAmount: dep, depositRef: depRef, installmentNo: no, installmentPct: pct,
    notes: 'แบ่งงวดจากใบเสนอราคา ' + q.number + ' · ' + label + (dep > 0 ? ' · หักมัดจำ ' + depRef : ''),
    projectName: q.projectName || '', status: paid ? 'paid' : 'draft', variant: 'installment', sourceDocumentId: String(q.id),
    payMethods, payBank: paid ? clean(input.payBank, 100) : '', payNo: paid ? clean(input.payNo, 100) : '', payDate, payAmount: paid ? String(total) : '',
    createdAt: now, updatedAt: now, createdBy: ctx.username() });
  await ctx.insertMany('document_items', [{ id: uuid(), documentId: id, lineNo: 1,
    description: label + ' ตามใบเสนอราคา ' + q.number, quantity: 1, unit: 'งวด', price: base, discount: 0, amount: base }]);
  await ctx.log(id, 'CREATE', number + ' | ' + label + ' ฐาน ' + base.toLocaleString('th-TH') + (dep > 0 ? ' หักมัดจำ ' + dep.toLocaleString('th-TH') : ''));
  const after = await quotationBilling(ctx, quotationId);
  return { success: true, id, number, installmentNo: no, pct, base, deposit: dep, vatAmount: vat, total, remaining: after.remaining };
}

// ---------- สรุปยอดขาย / ภาษีหัก ณ ที่จ่าย ----------
async function getSummary(ctx, opts) {
  opts = opts || {};
  const { expStatusOf } = require('./modules');
  const thisYear = yearNow(), year = Number(opts.year) || thisYear, month = Number(opts.month) || 0;
  if (!Number.isInteger(year) || year < 1990 || year > 2200) fail('ปีที่ระบุไม่ถูกต้อง');
  const mo = Number.isInteger(month) && month >= 1 && month <= 12 ? month : 0;
  const pad2 = n => String(n).padStart(2, '0');
  const periodFrom = year + '-' + pad2(mo || 1) + '-01';
  const periodTo = mo ? (mo === 12 ? (year + 1) + '-01-01' : year + '-' + pad2(mo + 1) + '-01') : (year + 1) + '-01-01';
  const type = (SALES_TYPES.includes(opts.type) || opts.type === 'expense' || opts.type === 'product') ? opts.type : 'invoice';
  const mode = ['all', 'issued', 'paid'].includes(opts.status) ? opts.status : 'all';
  const cust = clean(opts.customer, 250);
  const years = new Set([thisYear, year]), names = new Set(), rows = [];
  const inPeriod = date => Number(String(date).slice(0, 4)) === year && (!mo || Number(String(date).slice(5, 7)) === mo);
  if (type === 'expense') {
    const catBy = {};   // หมวดหมู่ตามรายการ (เหมือนหน้ารายการค่าใช้จ่าย)
    for (const i of await ctx.all("SELECT ei.expense_id, ei.category FROM expense_items ei JOIN expenses e ON e.id = ei.expense_id WHERE e.tenant_id = $1", [ctx.tenantId])) {
      const k = String(i.expenseId); if (i.category) (catBy[k] = catBy[k] || new Set()).add(String(i.category));
    }
    for (const r of await ctx.all("SELECT DISTINCT btrim(vendor_name) AS n FROM expenses WHERE tenant_id = $1 AND status <> 'cancelled' AND btrim(vendor_name) <> ''", [ctx.tenantId])) names.add(String(r.n));
    for (const r of await ctx.all("SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM expenses WHERE tenant_id = $1 AND status <> 'cancelled'", [ctx.tenantId])) if (r.y) years.add(Number(r.y));
    for (const e of await ctx.all("SELECT * FROM expenses WHERE tenant_id = $1 AND date >= $2::date AND date < $3::date", [ctx.tenantId, periodFrom, periodTo])) {
      const date = dateOut(e.date), st = expStatusOf(e.status);
      if (st === 'cancelled') continue;
      const name = String(e.vendorName || '').trim();
      if (name) names.add(name);
      if (!inPeriod(date) || (mode === 'paid' && st !== 'paid') || (cust && name !== cust)) continue;
      const total = Number(e.total) || 0, wht = Number(e.whtAmount) || 0;
      rows.push({ id: String(e.id), number: String(e.number), date, customerName: name, category: String(e.category || ''), categories: catBy[String(e.id)] ? [...catBy[String(e.id)]] : [String(e.category || 'อื่นๆ')], status: st, net: Number(e.amountBeforeVat) || 0,
        vat: Number(e.vatAmount) || 0, total, whtRate: Number(e.whtRate) || 0, wht, payable: round2(total - wht) });
    }
  } else if (type === 'product') {
    for (const r of await ctx.all("SELECT DISTINCT btrim(customer_name) AS n FROM documents WHERE tenant_id = $1 AND type IN ('receipt','cashsale') AND status <> 'cancelled' AND btrim(customer_name) <> ''", [ctx.tenantId])) names.add(String(r.n));
    for (const r of await ctx.all("SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM documents WHERE tenant_id = $1 AND type IN ('receipt','cashsale') AND status <> 'cancelled'", [ctx.tenantId])) if (r.y) years.add(Number(r.y));
    const docs = await ctx.all("SELECT * FROM documents WHERE tenant_id = $1 AND type IN ('receipt','cashsale') AND status <> 'cancelled' AND date >= $2::date AND date < $3::date", [ctx.tenantId, periodFrom, periodTo]);
    const itemsBy = {};
    if (docs.length) (await ctx.all('SELECT * FROM document_items WHERE tenant_id = $1 AND document_id = ANY($2::uuid[]) ORDER BY line_no', [ctx.tenantId, docs.map(d => String(d.id))])).forEach(i => { (itemsBy[String(i.documentId)] = itemsBy[String(i.documentId)] || []).push(i); });
    docs.forEach(d => {
      const date = dateOut(d.date), per = inPeriod(date), name = String(d.customerName || '').trim();
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
    for (const r of await ctx.all("SELECT DISTINCT btrim(customer_name) AS n FROM documents WHERE tenant_id = $1 AND status <> 'cancelled' AND btrim(customer_name) <> ''", [ctx.tenantId])) names.add(String(r.n));
    for (const r of await ctx.all("SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM documents WHERE tenant_id = $1", [ctx.tenantId])) if (r.y) years.add(Number(r.y));
    for (const d of await ctx.all("SELECT * FROM documents WHERE tenant_id = $1 AND type = $2 AND date >= $3::date AND date < $4::date", [ctx.tenantId, type, periodFrom, periodTo])) {
      const date = dateOut(d.date), per = inPeriod(date);
      if (d.status === 'cancelled') continue;
      const name = String(d.customerName || '').trim();
      if (!per || (mode === 'issued' && !['issued', 'paid'].includes(d.status)) || (mode === 'paid' && d.status !== 'paid') || (cust && name !== cust)) continue;
      const net = round2((Number(d.subtotal) || 0) - (Number(d.discount) || 0) - (Number(d.depositAmount) || 0));
      const wr = Number(d.whtRate) || 0, wht = round2(net * wr / 100), total = Number(d.total) || 0;
      rows.push({ id: String(d.id), number: String(d.number), date, customerName: name, status: String(d.status), net, vat: Number(d.vatAmount) || 0, total, whtRate: wr, wht, payable: round2(total - wht) });
    }
  }
  rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.number < b.number ? -1 : 1);
  return { year, month, type, docs: rows, customers: [...names].sort(localeTh), years: [...years].sort((a, b) => b - a) };
}

module.exports = { SALES_TYPES, PAID_TYPES, getCompany, getActiveCompanyId, getCompanySettings, getLogoPreview, saveCompanySettings,
  listDocuments, getDocument, getDocHistory, saveDocument, convertDocument, setDocStatus, createDeposit, quotationBalance, createInstallment, quotationBilling, deleteDocument, getSummary, findDoc, docItems, pubDocRow, syncInvoicePaidState };
