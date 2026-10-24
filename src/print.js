// ============================================================
//  print.js — แม่แบบพิมพ์, สร้าง PDF (Chromium) (เดิม: ส่วนท้ายของ Code.gs)
// ============================================================
const path = require('path');
const ejs = require('ejs');
const { trashFile } = require('./trash');
const storage = require('./storage');
const DOC_STYLE = require('./doc-style.json');
const { fail, round2, parseVat, fmt, thDate, ceDate, bahtText, bahtTextEn, safeFolderName, monthFolderName, ymOf, todayStr } = require('./util');
const documents = require('./documents');
const modules = require('./modules');

const PAID_TYPES = ['receipt', 'cashsale', 'deposit'];
const PDF_SAFE_PAD_PX = Number(process.env.PDF_SAFE_PAD_PX || 56);
const PDF_PAD_Y_PX = Number(process.env.PDF_PAD_Y_PX || 38);
const PDF_PAGE_BODY_PX = Number(process.env.PDF_PAGE_BODY_PX || 1020);
const DOC_TYPE_FOLDER = { quotation: '01 ใบเสนอราคา', invoice: '02 ใบแจ้งหนี้', taxinvoice: '03 ใบกำกับภาษี', receipt: '04 ใบเสร็จรับเงิน', cashsale: '05 ขายเงินสด', deposit: '10 ใบรับเงินมัดจำ', po: '06 ใบสั่งซื้อ', gr: '07 ใบรับสินค้า', expense: '08 ค่าใช้จ่าย', product: '09 สินค้า' };
const CANCEL_FOLDER_NAME = '_ยกเลิก';
const TEMPLATE = path.join(__dirname, '..', 'views', 'print.ejs');

async function getPrintData(ctx, id) {
  let doc = (await documents.findDoc(ctx, id)) ? await documents.getDocument(ctx, id) : null;
  if (!doc) doc = (await modules.purchaseAsPrintDoc(ctx, id)) || (await modules.expenseAsPrintDoc(ctx, id)) || (await modules.productAsPrintDoc(ctx, id));
  if (!doc) fail('ไม่พบเอกสาร');
  const c = await documents.getCompany(ctx, true);
  const logoData = c.logo && /^image\/(png|jpeg|webp)$/.test(String(c.logoMime)) ? 'data:' + c.logoMime + ';base64,' + Buffer.from(c.logo).toString('base64') : '';
  const company = Object.assign({}, c); delete company.logo;
  return { doc, company, logoData, src: doc.sourceDocumentId ? ((await documents.findDoc(ctx, doc.sourceDocumentId)) || (await modules.findPurchase(ctx, doc.sourceDocumentId))) : null };
}
function printOpts(o, type) {
  if (!o || typeof o !== 'object') return null;
  const n = v => Math.max(1, Math.min(5, Math.floor(Number(v)) || 1));
  const canDeliver = ['invoice', 'taxinvoice', 'receipt', 'cashsale'].includes(type);
  const r = { orig: !!o.orig, copy: !!o.copy, copies: n(o.copies), dOrig: canDeliver && !!o.dOrig, dCopy: canDeliver && !!o.dCopy, dCopies: n(o.dCopies), pay: o.pay !== false, lang: o.lang === 'en' ? 'en' : 'th' };
  if (!r.orig && !r.copy && !r.dOrig && !r.dCopy) r.orig = true;
  return r;
}
function printPages(o) {
  if (!o) return [{ kind: 'doc', label: '' }];
  const p = [];
  if (o.orig) p.push({ kind: 'doc', label: 'orig' });
  if (o.copy) for (let i = 0; i < o.copies; i++) p.push({ kind: 'doc', label: 'copy' });
  if (o.dOrig) p.push({ kind: 'del', label: 'orig' });
  if (o.dCopy) for (let i = 0; i < o.dCopies; i++) p.push({ kind: 'del', label: 'copy' });
  return p;
}
async function printModel(ctx, id, mode, opts) {
  const data = await getPrintData(ctx, id), d = data.doc, t = d.type;
  const po = printOpts(opts, t), en = !!po && po.lang === 'en';
  const L = { quotation: ['ใบเสนอราคา', '', 'ครบกำหนด', 'ผู้สั่งซื้อสินค้า', 'ผู้อนุมัติ'],
    invoice: ['ใบวางบิล/ใบแจ้งหนี้', 'ต้นฉบับ', 'ครบกำหนด', 'ผู้รับวางบิล', 'ผู้วางบิล'],
    taxinvoice: ['ใบกำกับภาษี', 'ต้นฉบับ (เอกสารออกเป็นชุด)', 'ครบกำหนด', 'ผู้รับสินค้า/บริการ', 'ผู้ออกใบกำกับภาษี'],
    receipt: ['ใบเสร็จรับเงิน', 'ต้นฉบับ (เอกสารออกเป็นชุด)', '', 'ผู้จ่ายเงิน', 'ผู้รับเงิน'],
    cashsale: ['ใบกำกับภาษี/ใบเสร็จรับเงิน (ขายเงินสด)', 'ต้นฉบับ (เอกสารออกเป็นชุด)', '', 'ผู้ซื้อ', 'ผู้รับเงิน'],
    deposit: ['ใบรับเงินมัดจำ / ใบกำกับภาษี', 'ต้นฉบับ (เอกสารออกเป็นชุด)', '', 'ผู้จ่ายเงิน', 'ผู้รับเงิน'],
    po: ['ใบสั่งซื้อ', 'ต้นฉบับ', 'กำหนดรับของ', 'ผู้ขายรับทราบ', 'ผู้สั่งซื้อ'],
    gr: ['ใบรับสินค้า', 'ต้นฉบับ', '', 'ผู้ส่งสินค้า', 'ผู้รับสินค้า'],
    expense: ['บันทึกค่าใช้จ่าย', '', 'ครบกำหนด', 'ผู้รับเงิน', 'ผู้จ่ายเงิน'],
    product: ['ข้อมูลสินค้า / บริการ', '', '', 'ผู้อนุมัติ', 'ผู้จัดทำ'] }[t].slice();
  const noVat = String(data.company.vatRegistered || '') === 'no';
  // ใบเสร็จรับเงิน = ใบกำกับภาษี/ใบเสร็จรับเงิน ในเอกสารเดียว (เมื่อคิด VAT) ; ไม่คิด VAT = ใบเสร็จรับเงินธรรมดา
  const taxReceipt = t === 'receipt' && Number(d.vatRate) > 0;
  if (taxReceipt) L[0] = 'ใบกำกับภาษี/ใบเสร็จรับเงิน';
  if ((t === 'receipt' || t === 'cashsale') && noVat) L[0] = t === 'cashsale' ? 'ใบเสร็จรับเงิน (ขายเงินสด)' : 'ใบเสร็จรับเงิน';
  if (t === 'deposit' && noVat) L[0] = 'ใบรับเงินมัดจำ';
  const LE = { quotation: ['Quotation', 'Due date', 'Customer', 'Approved by'], invoice: ['Invoice / Billing Note', 'Due date', 'Received by', 'Billed by'],
    taxinvoice: ['Tax Invoice', 'Due date', 'Received by', 'Issued by'], receipt: ['Receipt', '', 'Paid by', 'Received by'],
    cashsale: ['Tax Invoice / Receipt (Cash Sale)', '', 'Buyer', 'Received by'], deposit: ['Deposit Receipt / Tax Invoice', '', 'Paid by', 'Received by'], expense: ['Expense Record', 'Due date', 'Payee', 'Paid by'], product: ['Product Information', '', 'Approved by', 'Prepared by'],
    po: ['Purchase Order', 'Expected date', 'Acknowledged by', 'Ordered by'], gr: ['Goods Receipt', '', 'Delivered by', 'Received by'] }[t];
  let titleEn = LE[0];
  if (taxReceipt) titleEn = 'Tax Invoice / Receipt';
  if ((t === 'receipt' || t === 'cashsale') && noVat) titleEn = t === 'cashsale' ? 'Receipt (Cash Sale)' : 'Receipt';
  if (t === 'deposit' && noVat) titleEn = 'Deposit Receipt';
  // Phase: เอกสารมัดจำที่ออกเป็นใบวางบิล/เงินสด (variant='deposit') → เติม "(เงินมัดจำ)" ให้ชัด
  if (String(d.variant) === 'deposit' && t !== 'deposit') { L[0] = L[0] + ' (เงินมัดจำ)'; titleEn = titleEn + ' (Deposit)'; }
  // หัวเอกสารให้อยู่บรรทัดเดียวเสมอ — ย่อขนาดฟอนต์อัตโนมัติตามความยาวข้อความ
  const tlen = String(en ? titleEn : L[0]).length;
  const titleSize = tlen <= 16 ? 30 : tlen <= 22 ? 26 : tlen <= 30 ? 22 : tlen <= 40 ? 18 : 15;
  const isPurchase = t === 'po' || t === 'gr' || t === 'expense';
  // Phase 2: หักเงินมัดจำ — ฐานภาษี = ยอดหลังหักส่วนลด − มัดจำ (VAT/WHT คิดบนฐานนี้)
  const depAmt = round2(Number(d.depositAmount) || 0), afterDisc = round2(d.subtotal - d.discount);
  const net = round2(afterDisc - depAmt), wr = Number(d.whtRate) || 0, wht = round2(net * wr / 100);
  data.lang = en ? 'en' : 'th'; data.pages = printPages(po); data.showNo = !!po; data.opts = po;
  data.mode = mode; data.padX = mode === 'pdf' ? PDF_SAFE_PAD_PX : 0; data.padY = mode === 'pdf' ? PDF_PAD_Y_PX : 0;
  const dt = en ? ceDate : thDate, pm = String(d.payMethods || '').split(',');
  data.f = { titleTh: en ? titleEn : L[0], titleSize, subTitle: en ? '' : L[1], dueLabel: d.dueDate ? (en ? LE[1] : L[2]) : '', signLeft: en ? LE[2] : L[3], signRight: en ? LE[3] : L[4],
    delTitle: en ? 'Delivery Note' : 'ใบส่งของ', delSignLeft: en ? 'Received by' : 'ผู้รับสินค้า', delSignRight: en ? 'Delivered by' : 'ผู้ส่งสินค้า',
    lblOrig: en ? 'Original' : 'ต้นฉบับ', lblCopy: en ? 'Copy' : 'สำเนา', docType: t, canDeliver: ['invoice', 'taxinvoice', 'receipt', 'cashsale'].includes(t), hasPayBox: PAID_TYPES.includes(t),
    accent: DOC_STYLE[t].accent, tri: DOC_STYLE[t].tri, isReceipt: PAID_TYPES.includes(t),
    partyLabel: en ? (isPurchase ? 'Supplier' : 'Customer') : (isPurchase ? 'ผู้ขาย / ซัพพลายเออร์' : 'ลูกค้า'), sellerLabel: en ? (isPurchase ? 'Buyer' : 'Seller') : (isPurchase ? 'ผู้ซื้อ' : 'ผู้ขาย'),
    ref: data.src ? String(data.src.number) : '', project: d.projectName || '',
    date: dt(d.date), dueDate: dt(d.dueDate), hasDisc: d.items.some(x => x.discount > 0),
    items: d.items.map(x => ({ description: x.description, qty: fmt(x.quantity, 3).replace(/\.?0+$/, ''), unit: x.unit, price: fmt(x.price), disc: fmt(x.discount), amount: fmt(x.amount) })),
    subtotal: fmt(d.subtotal), discount: fmt(d.discount), hasDiscTotal: d.discount > 0, afterDisc: fmt(afterDisc), net: fmt(net),
    hasDeposit: depAmt > 0, deposit: fmt(depAmt), depositRef: String(d.depositRef || ''),
    vat: fmt(d.vatAmount), vatRate: parseVat(d.vatRate), total: fmt(d.total), words: en ? bahtTextEn(d.total) : bahtText(d.total),
    whtRate: wr, wht: fmt(wht), payable: fmt(round2(d.total - wht)),
    pay: (PAID_TYPES.includes(t) && (!po || po.pay)) ? {
      cash: pm.includes('cash'), cheque: pm.includes('cheque'), transfer: pm.includes('transfer'), card: pm.includes('card'),
      bank: String(d.payBank || ''), no: String(d.payNo || ''), date: d.payDate ? dt(d.payDate) : '',
      amount: (d.payAmount === '' || d.payAmount == null) ? (String(d.payMethods || '') ? fmt(round2(d.total - wht)) : '') : fmt(d.payAmount)
    } : null };
  data.f.bodyH = mode === 'pdf' ? PDF_PAGE_BODY_PX + 'px' : '265mm';
  return data;
}
async function renderPrint(ctx, id, mode, opts) {
  const data = await printModel(ctx, id, mode, opts);
  const html = await ejs.renderFile(TEMPLATE, { data }, { async: false });
  return { html, number: data.doc.number, type: data.doc.type, companyName: data.company.companyName, date: String(data.doc.date || ''), status: String(data.doc.status || ''), customerName: String(data.doc.customerName || '') };
}
async function getPrintHtml(ctx, id, opts) { return (await renderPrint(ctx, id, 'print', opts)).html; }

// ---------- HTML → PDF ด้วย Chromium ----------
let browserP = null;
function launchBrowser() {
  const puppeteer = require('puppeteer-core');
  const exe = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
  return puppeteer.launch({
    executablePath: exe,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
    headless: 'new',
    protocolTimeout: 60000
  }).then(b => { b.on('disconnected', () => { browserP = null; }); return b; })
    .catch(e => { browserP = null; console.error('[PDF] launch Chromium failed (' + exe + '):\n' + (e && e.stack || e)); throw e; });
}
function browser() { if (!browserP) browserP = launchBrowser(); return browserP; }
// รีเซ็ต Chromium ที่ค้าง/หลุดการเชื่อมต่อ เพื่อให้รอบถัดไปเปิดใหม่
async function resetBrowser() {
  const b = browserP; browserP = null;
  if (b) { try { const br = await b; await br.close(); } catch (e) {} }
}
// ข้อผิดพลาดที่แก้ได้ด้วยการเปิด Chromium ใหม่แล้วลองซ้ำ
const RETRYABLE = /Target closed|Session closed|Connection closed|Protocol error|browser has disconnected|Navigation timeout|Target\.|WebSocket|ECONNRESET|Most likely the page has been closed/i;
// จำกัดจำนวนการสร้าง PDF พร้อมกัน (Chromium ใช้หน่วยความจำมาก) — เกินจะต่อคิว
const PDF_MAX = Math.max(1, Number(process.env.PDF_CONCURRENCY || 2));
const PDF_QUEUE_MAX = Math.max(5, Number(process.env.PDF_QUEUE_MAX || 50));
let pdfBusy = 0; const pdfQueue = [];
// ส่งต่อ slot แบบ atomic ใน pdfFree (Security Review L5): คิวที่ตื่นมารับ slot ต่อทันที ไม่เปิดช่อง microtask race ให้คำขอใหม่แย่งจนเกิน PDF_MAX
async function pdfSlot() {
  if (pdfBusy < PDF_MAX) { pdfBusy++; return; }
  if (pdfQueue.length >= PDF_QUEUE_MAX) fail('ระบบกำลังสร้าง PDF ค้างหลายงานชั่วคราว กรุณารอสักครู่แล้วลองใหม่');
  await new Promise(r => pdfQueue.push(r));
}
function pdfFree() {
  const n = pdfQueue.shift();
  if (n) n();                   // ยก slot ส่งต่องานคิว (pdfBusy คงเดิม = นับต่อถูกตัว)
  else pdfBusy--;
}
async function htmlToPdf(html) {
  await pdfSlot();
  try {
    try { return await htmlToPdfRun(html); }
    catch (e) {
      const msg = String(e && e.message || e);
      if (!RETRYABLE.test(msg)) { console.error('[PDF] generate failed:', msg); throw e; }
      console.warn('[PDF] Chromium error, restarting and retrying once:', msg);
      await resetBrowser();
      return await htmlToPdfRun(html);   // ลองใหม่ด้วย Chromium ที่เปิดใหม่
    }
  } finally { pdfFree(); }
}
async function htmlToPdfRun(html) {
  const page = await (await browser()).newPage();
  try {
    // 'load' + รอฟอนต์แบบมีเพดานเวลา — กันกรณี resource ภายนอก (โลโก้/ฟอนต์) โหลดค้างจนครบ timeout
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    await page.evaluate(() => Promise.race([
      (document.fonts && document.fonts.ready) || Promise.resolve(),
      new Promise(r => setTimeout(r, 2500))
    ])).catch(() => {});
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 }, preferCSSPageSize: true }));
  } finally { await page.close().catch(() => {}); }
}
async function pdfOf(ctx, id, opts) { const r = await renderPrint(ctx, id, 'pdf', opts); return { r, buf: await htmlToPdf(r.html) }; }
async function createPdf(ctx, id, opts) {
  const r = await renderPrint(ctx, id, 'pdf', opts);   // อ่านข้อมูลใน transaction
  // แปลงเป็น PDF หลังปิด transaction (ดู __defer ใน api.js)
  return { __defer: async () => ({ name: r.number + '.pdf', mimeType: 'application/pdf', base64: (await htmlToPdf(r.html)).toString('base64') }) };
}

// ---------- สำรอง PDF: [02 เอกสาร PDF] / [บริษัท] / [ประเภท] / (_ยกเลิก) / [ปี] / [MM เดือน] / yyyy-MM-dd_เลขที่_ลูกค้า.pdf ----------
function pdfBackupName(number, date, customer) {
  const d = /^\d{4}-\d{2}-\d{2}/.test(String(date || '')) ? String(date).slice(0, 10) : todayStr();
  const cu = safeFolderName(customer, '').slice(0, 40);
  return d + '_' + safeFolderName(number, 'doc') + (cu ? '_' + cu : '') + '.pdf';
}
function pdfFolderNames(companyName, type, cancelled, ym) {
  return [safeFolderName(companyName, 'ไม่ระบุบริษัท'), DOC_TYPE_FOLDER[type] || '99 อื่นๆ'].concat(cancelled ? [CANCEL_FOLDER_NAME] : []).concat([ym.slice(0, 4), monthFolderName(ym)]);
}
// เอกสารถูกยกเลิก → ย้าย PDF สำรองเดิมไปโฟลเดอร์ _ยกเลิก (ไม่ขวางการยกเลิกถ้าย้ายไม่สำเร็จ)
async function archiveCancelledPdf(ctx, id) {
  try {
    const rows = await ctx.all('SELECT * FROM pdf_backups WHERE tenant_id = $1 AND doc_id = $2', [ctx.tenantId, String(id)]);
    if (!rows.length) return;
    const data = await getPrintData(ctx, id);
    const names = pdfFolderNames(data.company.companyName, data.doc.type, true, ymOf(data.doc.date));
    const dest = await storage.path('pdf', names);
    for (const b of rows) {
      const nid = await storage.move(b.fileId, dest);
      await ctx.exec('UPDATE pdf_backups SET file_id = $1, path = $2 WHERE id = $3', [nid, names.join(' / '), b.id]);
    }
  } catch (e) { console.warn('ย้าย PDF ที่ยกเลิกไม่สำเร็จ:', e.message); }
}

module.exports = { getPrintHtml, createPdf, archiveCancelledPdf, htmlToPdf, renderPrintPublic: renderPrint };
