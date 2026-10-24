// ============================================================
//  modules.js — สมุดรายชื่อ, สินค้า, ค่าใช้จ่าย, ใบสั่งซื้อ/ใบรับสินค้า (เดิม: Modules.gs)
// ============================================================
const { uuid, fail, clean, num, round2, round3, parseVat, parseWht, dateOut, tsOut, tsMs, isYmd, todayStr, compactDay, yearNow, localeTh } = require('./util');

const PURCHASE_TYPES = ['po', 'gr'];
const PURCHASE_STATUS = { po: ['draft', 'issued', 'received', 'cancelled'], gr: ['draft', 'received', 'cancelled'] };
const PURCHASE_RANK = { draft: 0, issued: 1, received: 2 };
const PURCHASE_PREFIX = { po: 'PO', gr: 'GR' };
const EXP_STATUS = ['paid', 'unpaid', 'cancelled'];
const EXP_PRICE_TYPES = ['exclude', 'include', 'none'];
const expStatusOf = s => { s = String(s || ''); return s === 'recorded' ? 'paid' : s; };
const T = ctx => ctx.tenantId;
const lockT = ctx => ctx.lock('tenant:' + ctx.tenantId);

function mDate(s, label, required) {
  s = clean(s, 10);
  if (!s) { if (required) fail('กรุณากรอก' + label); return ''; }
  if (!isYmd(s)) fail(label + 'ไม่ถูกต้อง');
  return s;
}
function mPublic(r) {
  const o = Object.assign({}, r); delete o.tenantId;
  ['createdAt', 'updatedAt'].forEach(k => { if (k in o) o[k] = tsOut(o[k]); });
  ['date', 'expectedDate'].forEach(k => { if (k in o) o[k] = dateOut(o[k]); });
  return o;
}
function needName(v, label) { const s = clean(v, 250); if (!s) fail('กรุณากรอก' + label); return s; }

// ===================== สมุดรายชื่อ =====================
async function listContacts(ctx, opts) {
  opts = opts || {};
  const q = clean(opts.keyword, 200).toLowerCase(), type = clean(opts.type, 20);
  const items = (await ctx.all("SELECT * FROM contacts WHERE tenant_id = $1 AND status <> 'deleted'", [T(ctx)]))
    .filter(c => !type || String(c.type) === type || String(c.type) === 'both')
    .filter(c => !q || [c.name, c.taxId, c.phone, c.email, c.contactPerson, c.address].some(v => String(v == null ? '' : v).toLowerCase().includes(q)))
    .sort((a, b) => localeTh(a.name, b.name)).map(mPublic);
  return { items };
}
async function saveContact(ctx, input) {
  input = input || {};
  const name = needName(input.name, 'ชื่อบริษัท/ชื่อผู้ติดต่อ');
  const type = ['customer', 'vendor', 'both'].includes(input.type) ? input.type : 'customer';
  const credit = input.creditDays === '' || input.creditDays == null ? '' : Number(input.creditDays);
  if (credit !== '' && (!Number.isInteger(credit) || credit < 0 || credit > 999)) fail('เครดิต (วัน) ไม่ถูกต้อง');
  await lockT(ctx);
  const old = input.id ? await ctx.one('SELECT * FROM contacts WHERE tenant_id = $1 AND id::text = $2', [T(ctx), String(input.id)]) : null;
  if (input.id && !old) fail('ไม่พบรายชื่อที่ต้องการแก้ไข');
  const dup = await ctx.one("SELECT id FROM contacts WHERE tenant_id = $1 AND status <> 'deleted' AND btrim(name) = $2 AND type = $3 AND ($4::uuid IS NULL OR id <> $4) LIMIT 1", [T(ctx), name, type, old ? old.id : null]);
  if (dup) fail('มีรายชื่อ "' + name + '" ประเภทนี้อยู่แล้ว');
  const rec = { type, name, taxId: clean(input.taxId, 50), branch: clean(input.branch, 100), address: clean(input.address, 1000), phone: clean(input.phone, 50), email: clean(input.email, 250),
    contactPerson: clean(input.contactPerson, 250), creditDays: credit, note: clean(input.note, 1000), status: 'active', updatedAt: new Date() };
  let id;
  if (old) { id = old.id; await ctx.update('contacts', id, rec); }
  else { id = uuid(); await ctx.insert('contacts', Object.assign(rec, { id, createdAt: new Date(), createdBy: ctx.username() })); }
  await ctx.log('CONTACT:' + id, old ? 'UPDATE' : 'CREATE', name);
  return { success: true, id };
}
async function deleteContact(ctx, id) {
  await lockT(ctx);
  const r = await ctx.one("SELECT * FROM contacts WHERE tenant_id = $1 AND id::text = $2 AND status <> 'deleted'", [T(ctx), String(id)]);
  if (!r) fail('ไม่พบรายชื่อ');
  await ctx.update('contacts', r.id, { status: 'deleted', updatedAt: new Date() });
  await ctx.log('CONTACT:' + r.id, 'DELETE', String(r.name));
  return { success: true };
}
async function importContactsFromDocs(ctx) {
  await lockT(ctx);
  const have = new Set((await ctx.all("SELECT name FROM contacts WHERE tenant_id = $1 AND status <> 'deleted' AND type IN ('customer','both')", [T(ctx)])).map(c => String(c.name).trim()));
  const latest = {};
  (await ctx.all('SELECT * FROM documents WHERE tenant_id = $1 ORDER BY updated_at', [T(ctx)])).forEach(d => { const n = String(d.customerName || '').trim(); if (n) latest[n] = d; });
  let added = 0;
  for (const n of Object.keys(latest)) {
    if (have.has(n)) continue;
    const d = latest[n];
    await ctx.insert('contacts', { type: 'customer', name: n, taxId: d.customerTaxId, address: d.customerAddress, phone: d.customerPhone, status: 'active', createdAt: new Date(), updatedAt: new Date(), createdBy: ctx.username() });
    added++;
  }
  if (added) await ctx.log('CONTACT:IMPORT', 'IMPORT', 'นำเข้า ' + added + ' รายชื่อจากเอกสารเดิม');
  return { success: true, added };
}

// ===================== สินค้า =====================
async function listProducts(ctx, opts) {
  opts = opts || {};
  const q = clean(opts.keyword, 200).toLowerCase();
  const items = (await ctx.all("SELECT * FROM products WHERE tenant_id = $1 AND status <> 'deleted'", [T(ctx)]))
    .filter(p => !q || [p.sku, p.name, p.note].some(v => String(v == null ? '' : v).toLowerCase().includes(q)))
    .sort((a, b) => localeTh(a.name, b.name)).map(p => { const o = mPublic(p); ['price', 'cost', 'stockQty'].forEach(k => { o[k] = Number(o[k]) || 0; }); return o; });
  return { items };
}
async function saveProduct(ctx, input) {
  input = input || {};
  const name = needName(input.name, 'ชื่อสินค้า/บริการ');
  const price = num(input.price === '' ? 0 : input.price, 'ราคาขาย'), cost = num(input.cost === '' ? 0 : input.cost, 'ต้นทุน');
  if (price < 0 || cost < 0) fail('ราคาและต้นทุนต้องไม่ติดลบ');
  const type = input.type === 'service' ? 'service' : 'goods';
  const tracked = type === 'goods' && input.stockTracked === 'yes' ? 'yes' : 'no';
  const sku = clean(input.sku, 50);
  await lockT(ctx);
  const old = input.id ? await ctx.one('SELECT * FROM products WHERE tenant_id = $1 AND id::text = $2', [T(ctx), String(input.id)]) : null;
  if (input.id && !old) fail('ไม่พบสินค้าที่ต้องการแก้ไข');
  if (sku && await ctx.one("SELECT id FROM products WHERE tenant_id = $1 AND status <> 'deleted' AND sku = $2 AND ($3::uuid IS NULL OR id <> $3) LIMIT 1", [T(ctx), sku, old ? old.id : null])) fail('รหัสสินค้า ' + sku + ' ซ้ำกับสินค้าอื่น');
  let qty = old ? Number(old.stockQty) || 0 : 0;
  if (tracked === 'yes' && input.stockQty !== undefined && input.stockQty !== '' && input.stockQty !== null) {
    const n = Number(input.stockQty); if (!Number.isFinite(n)) fail('จำนวนคงเหลือไม่ถูกต้อง'); qty = round3(n);
  }
  if (tracked === 'no') qty = 0;
  const rec = { sku, name, type, unit: clean(input.unit || 'ชิ้น', 50), price, cost, vatType: input.vatType === 'novat' ? 'novat' : 'vat', stockTracked: tracked, stockQty: qty,
    status: 'active', note: clean(input.note, 1000), updatedAt: new Date() };
  let id;
  if (old) { id = old.id; await ctx.update('products', id, rec); }
  else { id = uuid(); await ctx.insert('products', Object.assign(rec, { id, createdAt: new Date(), createdBy: ctx.username() })); }
  await ctx.log('PRODUCT:' + id, old ? 'UPDATE' : 'CREATE', name + (old && Number(old.stockQty) !== qty ? ' | สต็อก ' + (Number(old.stockQty) || 0) + '→' + qty : ''));
  return { success: true, id };
}
async function deleteProduct(ctx, id) {
  await lockT(ctx);
  const r = await ctx.one("SELECT * FROM products WHERE tenant_id = $1 AND id::text = $2 AND status <> 'deleted'", [T(ctx), String(id)]);
  if (!r) fail('ไม่พบสินค้า');
  await ctx.update('products', r.id, { status: 'deleted', updatedAt: new Date() });
  await ctx.log('PRODUCT:' + r.id, 'DELETE', String(r.name));
  return { success: true };
}
// ปรับสต็อกตามใบรับสินค้า: sign +1 = รับเข้า, -1 = ย้อนกลับ (เฉพาะสินค้าที่ "ควบคุมสต็อก")
async function stockAdjust(ctx, items, sign) {
  const sums = {};
  items.forEach(it => {
    const pid = String(it.productId || ''); if (!pid) return;
    const q = (it.receivedQty === '' || it.receivedQty == null) ? Number(it.quantity) : Number(it.receivedQty);
    sums[pid] = (sums[pid] || 0) + (Number.isFinite(q) ? q : 0);
  });
  for (const pid of Object.keys(sums)) {
    await ctx.exec("UPDATE products SET stock_qty = round((stock_qty + $1)::numeric, 3), updated_at = now() WHERE tenant_id = $2 AND id::text = $3 AND stock_tracked = 'yes' AND status <> 'deleted'",
      [sign * sums[pid], T(ctx), pid]);
  }
}

// ===================== ค่าใช้จ่าย =====================
// เลขที่: EXP + ปีเดือน (ค.ศ.) + เลขรัน 4 หลักต่อเดือน เช่น EXP2026100001
async function nextExpenseNumber(ctx, dateStr) {
  const ym = String(dateStr || '').slice(0, 7).replace('-', '') || todayStr().slice(0, 7).replace('-', '');
  const start = 'EXP' + ym;
  const rows = await ctx.all("SELECT number FROM expenses WHERE tenant_id = $1 AND number LIKE $2 UNION SELECT doc_number FROM trash_items WHERE tenant_id = $1 AND kind = 'expense' AND status = 'trashed' AND doc_number LIKE $2", [T(ctx), start + '%']);
  const nums = rows.map(r => String(r.number)).filter(n => n.length === start.length + 4).map(n => parseInt(n.slice(start.length), 10)).filter(Number.isFinite);
  return start + String(Math.max(0, ...nums) + 1).padStart(4, '0');
}
async function categoryRows(ctx) { return ctx.all("SELECT * FROM expense_categories WHERE tenant_id = $1 AND status <> 'deleted' ORDER BY sort, created_at", [T(ctx)]); }
async function expenseCategories(ctx) {
  const out = (await categoryRows(ctx)).map(c => String(c.name)), seen = new Set(out);
  (await ctx.all("SELECT DISTINCT category FROM expense_items WHERE tenant_id = $1 UNION SELECT DISTINCT category FROM expenses WHERE tenant_id = $1", [T(ctx)]))
    .forEach(r => { const c = String(r.category || '').trim(); if (c && c !== 'หลายหมวด' && !seen.has(c)) { seen.add(c); out.push(c); } });
  return out;
}
async function listExpenseCategories(ctx) { return { items: (await categoryRows(ctx)).map(c => ({ id: String(c.id), name: String(c.name), sort: Number(c.sort) || 0 })) }; }
async function saveExpenseCategory(ctx, input) {
  input = input || {};
  const name = needName(input.name, 'ชื่อหมวดหมู่');
  await lockT(ctx);
  const rows = await categoryRows(ctx);
  const old = input.id ? rows.find(c => String(c.id) === String(input.id)) : null;
  if (input.id && !old) fail('ไม่พบหมวดหมู่');
  if (rows.some(c => String(c.name).trim() === name && (!old || String(c.id) !== String(old.id)))) fail('มีหมวดหมู่ "' + name + '" อยู่แล้ว');
  let id;
  if (old) { id = old.id; await ctx.update('expense_categories', id, { name }); if (old.name !== name) await ctx.log('EXPCAT:' + id, 'UPDATE', old.name + '→' + name + ' (รายการเก่ายังใช้ชื่อเดิม)'); }
  else { id = uuid(); await ctx.insert('expense_categories', { id, name, sort: rows.length + 1, status: 'active', createdAt: new Date() }); }
  return { success: true, id };
}
async function deleteExpenseCategory(ctx, id) {
  await lockT(ctx);
  const r = await ctx.one("SELECT * FROM expense_categories WHERE tenant_id = $1 AND id::text = $2 AND status <> 'deleted'", [T(ctx), String(id)]);
  if (!r) fail('ไม่พบหมวดหมู่');
  await ctx.update('expense_categories', r.id, { status: 'deleted' });
  await ctx.log('EXPCAT:' + r.id, 'DELETE', String(r.name));
  return { success: true };
}
function expCalc(items, priceType, discountPct, vatRate, whtRate) {
  const sub = round2(items.reduce((s, x) => s + x.amount, 0));
  const disc = round2(sub * discountPct / 100), after = round2(sub - disc);
  let net = after, vat = 0, total = after;
  if (priceType === 'exclude' && vatRate) { vat = round2(after * vatRate / 100); total = round2(after + vat); }
  else if (priceType === 'include' && vatRate) { net = round2(after / (1 + vatRate / 100)); vat = round2(after - net); total = after; }
  return { subtotal: sub, discountAmt: disc, net, vat, total, wht: round2(net * whtRate / 100) };
}
async function expItemsOf(ctx, e) {
  const rows = await ctx.all('SELECT * FROM expense_items WHERE expense_id = $1 ORDER BY line_no', [e.id]);
  if (rows.length) return rows.map(x => ({ category: String(x.category || ''), description: String(x.description || ''), quantity: Number(x.quantity) || 0, unit: String(x.unit || ''), price: Number(x.price) || 0, amount: Number(x.amount) || 0 }));
  return [{ category: String(e.category || 'อื่นๆ'), description: String(e.description || ''), quantity: 1, unit: 'รายการ', price: Number(e.amountBeforeVat) || 0, amount: Number(e.amountBeforeVat) || 0 }];
}
function expPublic(e) {
  const o = mPublic(e);
  ['amountBeforeVat', 'vatRate', 'vatAmount', 'total', 'whtRate', 'whtAmount', 'subtotal', 'discountPct', 'discountAmt', 'creditDays'].forEach(k => { o[k] = Number(o[k]) || 0; });
  o.dueDate = dateOut(e.dueDate); o.status = expStatusOf(o.status); o.priceType = EXP_PRICE_TYPES.includes(o.priceType) ? o.priceType : 'exclude';
  return o;
}
async function findExpense(ctx, id) { return ctx.one('SELECT * FROM expenses WHERE tenant_id = $1 AND id::text = $2', [T(ctx), String(id || '')]); }
async function listExpenses(ctx, opts) {
  opts = opts || {};
  const year = Number(opts.year) || 0, month = Number(opts.month) || 0, cat = clean(opts.category, 100), q = clean(opts.keyword, 200).toLowerCase(), st = clean(opts.status, 20);
  // เลือกปี/เดือนแล้ว → ดึงเฉพาะช่วงนั้นจากฐานข้อมูล
  const from = year ? `${year}-${String(month || 1).padStart(2, '0')}-01` : null;
  const to = year ? (month ? (month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`) : `${year + 1}-01-01`) : null;
  const all = await ctx.all('SELECT * FROM expenses WHERE tenant_id = $1 AND ($2::date IS NULL OR (date >= $2::date AND date < $3::date))', [T(ctx), from, to]);
  const years = new Set([yearNow()]);
  (await ctx.all('SELECT DISTINCT extract(year FROM date)::int AS y FROM expenses WHERE tenant_id = $1 AND date IS NOT NULL', [T(ctx)])).forEach(r => { if (r.y) years.add(Number(r.y)); });
  const itemsBy = {}; (await ctx.all('SELECT * FROM expense_items WHERE tenant_id = $1 AND expense_id = ANY($2::uuid[]) ORDER BY line_no', [T(ctx), all.map(e => e.id)])).forEach(i => { (itemsBy[String(i.expenseId)] = itemsBy[String(i.expenseId)] || []).push(i); });
  const filesBy = {}; (await ctx.all("SELECT doc_no, count(*)::int AS n FROM uploads WHERE tenant_id = $1 AND status <> 'deleted' AND doc_no IS NOT NULL GROUP BY doc_no", [T(ctx)])).forEach(r => { filesBy[String(r.docNo)] = r.n; });
  const catsOf = e => { const l = itemsBy[String(e.id)]; return l && l.length ? [...new Set(l.map(i => String(i.category || '')).filter(Boolean))] : [String(e.category || 'อื่นๆ')]; };
  const items = all.filter(e => {
    const d = dateOut(e.date);
    if (year && Number(d.slice(0, 4)) !== year) return false;
    if (month && Number(d.slice(5, 7)) !== month) return false;
    if (st && expStatusOf(e.status) !== st) return false;
    if (cat && !catsOf(e).includes(cat)) return false;
    return !q || [e.number, e.vendorName, e.description, e.category, e.payRef, e.refNo, e.projectName, e.notes].some(v => String(v == null ? '' : v).toLowerCase().includes(q));
  }).sort((a, b) => dateOut(b.date) < dateOut(a.date) ? -1 : dateOut(b.date) > dateOut(a.date) ? 1 : String(b.number) < String(a.number) ? -1 : 1)
    .slice(0, 2000).map(e => { const o = expPublic(e); o.categories = catsOf(e); o.fileCount = filesBy[String(e.number)] || 0; return o; });
  const live = items.filter(e => e.status !== 'cancelled');
  const sum = k => round2(live.reduce((s, e) => s + (Number(e[k]) || 0), 0));
  const byCat = {};
  live.forEach(e => {
    const l = itemsBy[String(e.id)], k = (Number(e.subtotal) > 0) ? Number(e.amountBeforeVat) / Number(e.subtotal) : 1;
    (l && l.length ? l.map(i => [String(i.category || 'อื่นๆ'), (Number(i.amount) || 0) * k]) : [[e.category || 'อื่นๆ', e.amountBeforeVat]]).forEach(([c, a]) => { byCat[c] = round2((byCat[c] || 0) + a); });
  });
  return { items, categories: await expenseCategories(ctx), years: [...years].sort((a, b) => b - a),
    totals: { count: live.length, net: sum('amountBeforeVat'), vat: sum('vatAmount'), total: sum('total'), wht: sum('whtAmount'), unpaid: round2(live.filter(e => e.status === 'unpaid').reduce((s, e) => s + e.total, 0)) }, byCategory: byCat };
}
async function getExpense(ctx, id) {
  const e = await findExpense(ctx, id);
  if (!e) fail('ไม่พบรายการค่าใช้จ่าย');
  const o = expPublic(e); o.items = await expItemsOf(ctx, e); return o;
}
async function saveExpense(ctx, input) {
  input = input || {};
  const date = mDate(input.date, 'วันที่', true);
  const vendorName = clean(input.vendorName, 250), description = clean(input.description, 500);
  const credit = input.creditDays === '' || input.creditDays == null ? 0 : Number(input.creditDays);
  if (!Number.isInteger(credit) || credit < 0 || credit > 999) fail('เครดิต (วัน) ไม่ถูกต้อง');
  const dueDate = mDate(input.dueDate, 'วันครบกำหนด', false);
  const priceType = EXP_PRICE_TYPES.includes(input.priceType) ? input.priceType : 'exclude';
  const discountPct = input.discountPct === '' || input.discountPct == null ? 0 : Number(input.discountPct);
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) fail('ส่วนลด (%) ไม่ถูกต้อง');
  const vatRate = priceType === 'none' ? 0 : parseVat(input.vatRate === '' || input.vatRate == null ? 0 : input.vatRate), whtRate = parseWht(input.whtRate);
  const raw = (Array.isArray(input.items) ? input.items : []).filter(it => clean(it.description, 500) || Number(it.price) > 0);
  if (!raw.length) fail('กรุณาเพิ่มรายการค่าใช้จ่ายอย่างน้อย 1 รายการ');
  const items = raw.map((it, i) => {
    const quantity = num(it.quantity === '' || it.quantity == null ? 1 : it.quantity, 'จำนวน'), price = num(it.price === '' || it.price == null ? 0 : it.price, 'ราคา');
    if (quantity <= 0 || price < 0) fail('ตรวจสอบจำนวนและราคา แถว ' + (i + 1));
    return { category: clean(it.category, 100) || 'อื่นๆ', description: clean(it.description, 500), quantity, unit: clean(it.unit || 'รายการ', 50), price, amount: round2(quantity * price) };
  });
  if (!vendorName && !description && !items.some(x => x.description)) fail('กรุณากรอกชื่อผู้จ่ายหน่วย หรือรายละเอียดรายการ');
  const c = expCalc(items, priceType, discountPct, vatRate, whtRate);
  const status = EXP_STATUS.includes(input.status) ? input.status : 'paid';
  await lockT(ctx);
  const old = input.id ? await findExpense(ctx, input.id) : null;
  if (input.id && !old) fail('ไม่พบรายการค่าใช้จ่าย');
  if (old && expStatusOf(old.status) === 'cancelled') fail('รายการที่ยกเลิกแล้วแก้ไขไม่ได้');
  const id = old ? String(old.id) : uuid();
  const cats = [...new Set(items.map(x => x.category))];
  const rec = { number: old ? old.number : await nextExpenseNumber(ctx, date), date, creditDays: credit, dueDate,
    vendorId: clean(input.vendorId, 100), vendorName, vendorAddress: clean(input.vendorAddress, 1000), vendorTaxId: clean(input.vendorTaxId, 50), vendorBranch: clean(input.vendorBranch, 100),
    projectName: clean(input.projectName, 250), refNo: clean(input.refNo, 100), priceType, category: cats.length === 1 ? cats[0] : 'หลายหมวด', description,
    subtotal: c.subtotal, discountPct, discountAmt: c.discountAmt, amountBeforeVat: c.net, vatRate, vatAmount: c.vat, total: c.total, whtRate, whtAmount: c.wht,
    payMethod: ['cash', 'cheque', 'transfer', 'card'].includes(input.payMethod) ? input.payMethod : '', payRef: clean(input.payRef, 100),
    notes: clean(input.notes, 1000), internalNotes: clean(input.internalNotes, 1000), currency: 'THB', status, updatedAt: new Date() };
  if (old) { await ctx.update('expenses', id, rec); await ctx.exec('DELETE FROM expense_items WHERE expense_id = $1', [id]); }
  else await ctx.insert('expenses', Object.assign(rec, { id, createdAt: new Date(), createdBy: ctx.username() }));
  await ctx.insertMany('expense_items', items.map((x, i) => Object.assign({ id: uuid(), expenseId: id, lineNo: i + 1 }, x)));
  await ctx.log('EXPENSE:' + id, old ? 'UPDATE' : 'CREATE', rec.number + ' / ' + rec.category + ' / ' + c.total + (old && status !== expStatusOf(old.status) ? ' | สถานะ: ' + expStatusOf(old.status) + '→' + status : ''));
  return { success: true, id, number: rec.number, total: c.total, status };
}
async function setExpenseStatus(ctx, id, status) {
  if (!EXP_STATUS.includes(status)) fail('สถานะไม่ถูกต้อง');
  await lockT(ctx);
  const e = await findExpense(ctx, id);
  if (!e) fail('ไม่พบรายการค่าใช้จ่าย');
  const prev = expStatusOf(e.status);
  if (prev === 'cancelled') fail('รายการที่ยกเลิกแล้วเปลี่ยนสถานะไม่ได้');
  if (prev === status) return { success: true };
  await ctx.update('expenses', e.id, { status, updatedAt: new Date() });
  await ctx.log('EXPENSE:' + e.id, 'STATUS', e.number + ': ' + prev + '→' + status);
  if (status === 'cancelled') await require('./print').archiveCancelledPdf(ctx, e.id);
  return { success: true };
}
async function deleteExpense(ctx, id) {
  await lockT(ctx);
  const e = await findExpense(ctx, id);
  if (!e) fail('ไม่พบรายการค่าใช้จ่าย');
  await require('./trash').trashRecord(ctx, { kind: 'expense', table: 'expenses', itemsTable: 'expense_items', fk: 'expense_id', id: e.id, number: e.number, docType: 'expense', label: e.vendorName || e.category });
  await ctx.exec('DELETE FROM expenses WHERE id = $1', [e.id]);
  await ctx.log('EXPENSE:' + e.id, 'DELETE', e.number + ' / ' + e.category + ' / ' + e.total);
  return { success: true };
}

// ===================== ใบสั่งซื้อ (PO) / ใบรับสินค้า (GR) =====================
async function nextPurchaseNumber(ctx, prefix) {
  const start = prefix + '-' + compactDay() + '-';
  const rows = await ctx.all("SELECT number FROM purchase_docs WHERE tenant_id = $1 AND number LIKE $2 UNION SELECT doc_number FROM trash_items WHERE tenant_id = $1 AND kind = 'purchase' AND status = 'trashed' AND doc_number LIKE $2", [T(ctx), start + '%']);
  const nums = rows.map(r => parseInt(String(r.number).slice(start.length), 10)).filter(Number.isFinite);
  return start + String(Math.max(0, ...nums) + 1).padStart(4, '0');
}
async function findPurchase(ctx, id) { return ctx.one('SELECT * FROM purchase_docs WHERE tenant_id = $1 AND id::text = $2', [T(ctx), String(id || '')]); }
async function purchaseItems(ctx, id) { return ctx.all('SELECT * FROM purchase_items WHERE document_id = $1 ORDER BY line_no', [id]); }
const numCols = o => { ['subtotal', 'discount', 'vatRate', 'vatAmount', 'total'].forEach(k => { o[k] = Number(o[k]) || 0; }); return o; };
async function purchaseDocPublic(ctx, d) {
  const o = numCols(mPublic(d));
  o.items = (await purchaseItems(ctx, d.id)).map(x => ({ id: x.id, documentId: x.documentId, productId: String(x.productId || ''), description: x.description, quantity: Number(x.quantity),
    receivedQty: (x.receivedQty === '' || x.receivedQty == null) ? '' : Number(x.receivedQty), unit: x.unit, price: Number(x.price), discount: Number(x.discount), amount: Number(x.amount) }));
  return o;
}
async function listPurchaseDocs(ctx, opts) {
  opts = opts || {};
  const type = clean(opts.type, 10), q = clean(opts.keyword, 200).toLowerCase();
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const items = (await ctx.all(`SELECT * FROM purchase_docs WHERE tenant_id = $1 AND ($2 = '' OR type = $2) AND ($3 = '' OR lower(COALESCE(number,'')) LIKE $4
      OR lower(COALESCE(vendor_name,'')) LIKE $4 OR lower(COALESCE(status,'')) LIKE $4 OR lower(COALESCE(notes,'')) LIKE $4) ORDER BY updated_at DESC LIMIT 1000`, [T(ctx), type, q, like]))
    .map(d => numCols(mPublic(d)));
  return { items };
}
async function getPurchaseDoc(ctx, id) { const d = await findPurchase(ctx, id); if (!d) fail('ไม่พบเอกสาร'); return purchaseDocPublic(ctx, d); }
// ใบสั่งซื้อที่มีใบรับสินค้า (รับของแล้ว) = "รับของแล้ว"; ยกเลิก/ลบใบรับสินค้าทั้งหมด = กลับเป็น "ออกเอกสารแล้ว"
async function syncPoReceived(ctx, poId) {
  if (!poId) return;
  const po = await findPurchase(ctx, poId);
  if (!po || po.type !== 'po' || po.status === 'cancelled') return;
  const got = await ctx.one("SELECT 1 FROM purchase_docs WHERE tenant_id = $1 AND source_document_id = $2 AND type = 'gr' AND status = 'received' LIMIT 1", [T(ctx), po.id]);
  let next = String(po.status);
  if (got) next = 'received'; else if (next === 'received') next = 'issued';
  if (next === String(po.status)) return;
  await ctx.update('purchase_docs', po.id, { status: next, updatedAt: new Date() });
  await ctx.log(po.id, 'STATUS', po.number + ': ' + po.status + '→' + next + ' (อัตโนมัติตามใบรับสินค้า)');
}
async function savePurchaseDoc(ctx, input) {
  input = input || {};
  if (!PURCHASE_TYPES.includes(input.type)) fail('ประเภทเอกสารไม่ถูกต้อง');
  const vendorName = needName(input.vendorName, 'ชื่อผู้ขาย/ซัพพลายเออร์');
  if (!Array.isArray(input.items) || !input.items.length) fail('กรุณาเพิ่มรายการสินค้า');
  await lockT(ctx);
  const old = input.id ? await findPurchase(ctx, input.id) : null;
  if (input.id && !old) fail('ไม่พบเอกสารที่ต้องการแก้ไข');
  if (old && old.type !== input.type) fail('ไม่สามารถเปลี่ยนประเภทเอกสารเดิมได้');
  if (old && old.status === 'cancelled') fail('เอกสารที่ยกเลิกแล้วไม่สามารถแก้ไขได้');
  const id = old ? String(old.id) : uuid(), isGr = input.type === 'gr';
  const items = input.items.map((it, i) => {
    const quantity = num(it.quantity, 'จำนวน'), price = num(it.price, 'ราคา'), discount = num(it.discount || 0, 'ส่วนลด');
    if (quantity <= 0 || price < 0 || discount < 0 || discount > quantity * price) fail('ตรวจสอบจำนวน ราคา และส่วนลด แถว ' + (i + 1));
    const description = clean(it.description, 500);
    if (!description) fail('กรุณากรอกรายละเอียดรายการที่ ' + (i + 1));
    return { id: uuid(), documentId: id, lineNo: i + 1, productId: clean(it.productId, 100), description, quantity, receivedQty: isGr ? quantity : '', unit: clean(it.unit || 'รายการ', 50), price, discount, amount: round2(quantity * price - discount) };
  });
  const subtotal = round2(items.reduce((s, x) => s + x.quantity * x.price, 0)), discount = round2(items.reduce((s, x) => s + x.discount, 0));
  const net = round2(subtotal - discount), vatRate = parseVat(input.vatRate), vatAmount = round2(net * vatRate / 100), total = round2(net + vatAmount);
  const date = mDate(input.date, 'วันที่เอกสาร', true), expectedDate = mDate(input.expectedDate, 'วันที่กำหนดรับของ', false);
  const comp = await require('./documents').getCompany(ctx, false);
  const companyId = (old && old.companyId) ? String(old.companyId) : String(comp.id);
  if (String(comp.vatRegistered || '') === 'no' && vatRate !== 0 && !(old && Number(old.vatRate) === vatRate)) fail('บริษัทนี้ไม่ได้จดทะเบียนภาษีมูลค่าเพิ่ม กรุณาเลือก "ไม่คิด VAT"');
  const sourceDocumentId = old ? String(old.sourceDocumentId || '') : clean(input.sourceDocumentId, 100);
  if (sourceDocumentId) { const src = await findPurchase(ctx, sourceDocumentId); if (!isGr || !src || src.type !== 'po') fail('ไม่พบใบสั่งซื้อต้นทาง'); }
  if (old && String(old.sourceDocumentId || '') !== sourceDocumentId) fail('ไม่สามารถเปลี่ยนเอกสารต้นทางได้');
  const status = clean(input.status || 'draft', 20), prev = old ? String(old.status) : '';
  if (!PURCHASE_STATUS[input.type].includes(status)) fail('สถานะนี้ใช้กับเอกสารประเภทนี้ไม่ได้');
  if (old && status !== 'cancelled' && status !== prev && PURCHASE_RANK[status] < PURCHASE_RANK[prev]) fail('ไม่สามารถย้อนสถานะเอกสารได้ หากต้องแก้ไขให้ยกเลิกแล้วออกเอกสารใหม่');
  const oldItems = old ? await purchaseItems(ctx, id) : [];
  const apply = isGr && status === 'received';
  const rec = { number: old ? old.number : await nextPurchaseNumber(ctx, PURCHASE_PREFIX[input.type]), type: input.type, date, expectedDate, companyId,
    vendorId: clean(input.vendorId, 100), vendorName, vendorTaxId: clean(input.vendorTaxId, 50), vendorAddress: clean(input.vendorAddress, 1000), vendorPhone: clean(input.vendorPhone, 50),
    subtotal, discount, vatRate, vatAmount, total, notes: clean(input.notes, 2000), status, sourceDocumentId, stockApplied: apply ? '1' : '', updatedAt: new Date() };
  // สต็อก: ย้อนยอดที่เคยรับเข้าของฉบับนี้ก่อน แล้วรับเข้าใหม่ตามรายการล่าสุด
  if (old && String(old.stockApplied) === '1') await stockAdjust(ctx, oldItems, -1);
  if (apply) await stockAdjust(ctx, items, +1);
  if (old) { await ctx.update('purchase_docs', id, rec); await ctx.exec('DELETE FROM purchase_items WHERE document_id = $1', [id]); }
  else await ctx.insert('purchase_docs', Object.assign(rec, { id, createdAt: new Date(), createdBy: ctx.username() }));
  await ctx.insertMany('purchase_items', items);
  if (isGr && sourceDocumentId) await syncPoReceived(ctx, sourceDocumentId);
  await ctx.log(id, old ? 'UPDATE' : 'CREATE', rec.number + (old && status !== prev ? ' | สถานะ: ' + prev + '→' + status : '') + (apply ? ' | รับเข้าสต็อก' : ''));
  return { success: true, id, number: rec.number, total, status };
}
async function convertPurchase(ctx, poId) {
  await lockT(ctx);
  const po = await findPurchase(ctx, poId);
  if (!po || po.type !== 'po') fail('สร้างใบรับสินค้าจากใบสั่งซื้อเท่านั้น');
  if (po.status === 'cancelled') fail('ไม่สามารถแปลงเอกสารที่ยกเลิกแล้ว');
  const existing = await ctx.one("SELECT id, number FROM purchase_docs WHERE tenant_id = $1 AND source_document_id = $2 AND type = 'gr' AND status <> 'cancelled' LIMIT 1", [T(ctx), po.id]);
  if (existing) return { success: true, id: existing.id, number: existing.number, alreadyExists: true };
  const items = await purchaseItems(ctx, po.id);
  if (!items.length) fail('ใบสั่งซื้อไม่มีรายการสินค้า');
  const id = uuid(), now = new Date(), number = await nextPurchaseNumber(ctx, 'GR');
  await ctx.insert('purchase_docs', { id, number, type: 'gr', date: todayStr(), expectedDate: '', companyId: po.companyId, vendorId: po.vendorId, vendorName: po.vendorName,
    vendorTaxId: po.vendorTaxId, vendorAddress: po.vendorAddress, vendorPhone: po.vendorPhone, subtotal: Number(po.subtotal) || 0, discount: Number(po.discount) || 0,
    vatRate: parseVat(po.vatRate), vatAmount: Number(po.vatAmount) || 0, total: Number(po.total) || 0, notes: 'อ้างอิง ' + po.number, status: 'draft', sourceDocumentId: String(po.id),
    stockApplied: '', createdAt: now, updatedAt: now, createdBy: ctx.username() });
  await ctx.insertMany('purchase_items', items.map((x, i) => ({ id: uuid(), documentId: id, lineNo: i + 1, productId: x.productId, description: x.description, quantity: Number(x.quantity),
    receivedQty: Number(x.quantity), unit: x.unit, price: Number(x.price), discount: Number(x.discount), amount: Number(x.amount) })));
  await ctx.log(id, 'CONVERT', po.number + ' -> ' + number);
  return { success: true, id, number };
}
// สร้างใบสั่งซื้อ (PO) จากใบเสนอราคาฝั่งขาย — คัดลอกรายการมาเป็น draft ให้ผู้ใช้เลือกผู้ขาย/ซัพพลายเออร์ภายหลัง
async function createPoFromQuotation(ctx, quotationId) {
  await lockT(ctx);
  const D = require('./documents');
  const q = await D.findDoc(ctx, quotationId);
  if (!q) fail('ไม่พบใบเสนอราคา');
  if (q.type !== 'quotation') fail('สร้างใบสั่งซื้อจากใบเสนอราคาเท่านั้น');
  const items = await D.docItems(ctx, q.id);
  if (!items.length) fail('ใบเสนอราคาไม่มีรายการสินค้า');
  const comp = await D.getCompany(ctx, false);
  const vatRate = parseVat(q.vatRate);
  const subtotal = round2(items.reduce((s, x) => s + x.quantity * x.price, 0)), discount = round2(items.reduce((s, x) => s + x.discount, 0));
  const net = round2(subtotal - discount), vatAmount = round2(net * vatRate / 100), total = round2(net + vatAmount);
  const id = uuid(), now = new Date(), number = await nextPurchaseNumber(ctx, PURCHASE_PREFIX.po);
  await ctx.insert('purchase_docs', { id, number, type: 'po', date: todayStr(), expectedDate: '', companyId: String(comp.id),
    vendorName: '', subtotal, discount, vatRate, vatAmount, total, notes: 'อ้างอิงใบเสนอราคา ' + q.number, status: 'draft', sourceDocumentId: '',
    createdAt: now, updatedAt: now, createdBy: ctx.username() });
  await ctx.insertMany('purchase_items', items.map((x, i) => ({ id: uuid(), documentId: id, lineNo: i + 1, productId: '', description: x.description, quantity: x.quantity, receivedQty: '', unit: x.unit, price: x.price, discount: x.discount, amount: x.amount })));
  await ctx.log(id, 'CREATE', number + ' | สร้างใบสั่งซื้อจากใบเสนอราคา ' + q.number);
  return { success: true, id, number };
}
async function deletePurchaseDoc(ctx, id) {
  await lockT(ctx);
  const d = await findPurchase(ctx, id);
  if (!d) fail('ไม่พบเอกสาร');
  const child = await ctx.one('SELECT number FROM purchase_docs WHERE tenant_id = $1 AND source_document_id = $2 LIMIT 1', [T(ctx), d.id]);
  if (child) fail('ลบไม่ได้: มีเอกสารที่สร้างต่อจากฉบับนี้ (' + child.number + ') กรุณาลบเอกสารปลายทางก่อน');
  if (String(d.stockApplied) === '1') await stockAdjust(ctx, await purchaseItems(ctx, d.id), -1);
  await require('./trash').trashRecord(ctx, { kind: 'purchase', table: 'purchase_docs', itemsTable: 'purchase_items', fk: 'document_id', id: d.id, number: d.number, docType: d.type, label: d.vendorName });
  await ctx.exec('DELETE FROM purchase_docs WHERE id = $1', [d.id]);
  if (d.type === 'gr' && d.sourceDocumentId) await syncPoReceived(ctx, String(d.sourceDocumentId));
  await ctx.log(d.id, 'DELETE', d.number + ' / ' + d.type + ' / ' + d.status + ' / ยอดสุทธิ ' + d.total);
  return { success: true };
}

// ---------- แปลงเป็นรูปแบบเอกสารสำหรับแม่แบบพิมพ์ ----------
const EMPTY_PAY = { projectName: '', whtRate: 0, payMethods: '', payBank: '', payNo: '', payDate: '', payAmount: '' };
async function purchaseAsPrintDoc(ctx, id) {
  const d = await findPurchase(ctx, id);
  if (!d) return null;
  const p = await purchaseDocPublic(ctx, d);
  return Object.assign({}, EMPTY_PAY, { id: p.id, number: p.number, type: p.type, date: p.date, dueDate: p.expectedDate || '', companyId: p.companyId,
    customerName: p.vendorName, customerTaxId: p.vendorTaxId, customerAddress: p.vendorAddress, customerPhone: p.vendorPhone,
    subtotal: p.subtotal, discount: p.discount, vatRate: p.vatRate, vatAmount: p.vatAmount, total: p.total, notes: p.notes, status: p.status, sourceDocumentId: p.sourceDocumentId,
    items: p.items.map(x => ({ description: x.description, quantity: x.quantity, unit: x.unit, price: x.price, discount: x.discount, amount: x.amount })) });
}
async function expenseAsPrintDoc(ctx, id) {
  const e = await findExpense(ctx, id);
  if (!e) return null;
  const o = expPublic(e), items = await expItemsOf(ctx, e), r = Number(o.vatRate) || 0;
  const inc = o.priceType === 'include' && r > 0, k = inc ? 1 / (1 + r / 100) : 1;
  const subtotal = round2(o.subtotal * k);
  return Object.assign({}, EMPTY_PAY, { id: o.id, number: o.number, type: 'expense', date: o.date, dueDate: o.dueDate || '', companyId: '',
    customerName: o.vendorName || '', customerTaxId: o.vendorTaxId || '', customerAddress: o.vendorAddress || '', customerPhone: '',
    subtotal, discount: inc ? round2(subtotal - o.amountBeforeVat) : o.discountAmt, vatRate: r, vatAmount: o.vatAmount, total: o.total,
    notes: [o.description, o.notes].filter(Boolean).join('\n'), status: o.status, sourceDocumentId: '', projectName: o.projectName || '', whtRate: Number(o.whtRate) || 0,
    items: items.map(x => ({ description: (x.category ? '[' + x.category + '] ' : '') + x.description, quantity: x.quantity, unit: x.unit, price: x.price, discount: 0, amount: x.amount })) });
}
async function productAsPrintDoc(ctx, id) {
  const p = await ctx.one('SELECT * FROM products WHERE tenant_id = $1 AND id::text = $2', [T(ctx), String(id || '')]);
  if (!p) return null;
  const price = Number(p.price) || 0, vr = String(p.vatType) === 'novat' ? 0 : 7, vat = round2(price * vr / 100);
  const no = String(p.sku || '').replace(/[\\\/:*?"<>|\s]+/g, '-') || ('PRD-' + String(p.id).slice(0, 6));
  return Object.assign({}, EMPTY_PAY, { id: String(p.id), number: no, type: 'product', date: todayStr(), dueDate: '', companyId: '',
    customerName: '', customerTaxId: '', customerAddress: '', customerPhone: '', subtotal: price, discount: 0, vatRate: vr, vatAmount: vat, total: round2(price + vat),
    notes: String(p.note || ''), status: String(p.status || ''), sourceDocumentId: '',
    items: [{ description: String(p.name || '') + (p.type === 'service' ? ' (บริการ)' : ''), quantity: 1, unit: String(p.unit || ''), price, discount: 0, amount: price }] });
}

module.exports = { expStatusOf, listContacts, saveContact, deleteContact, importContactsFromDocs, listProducts, saveProduct, deleteProduct,
  listExpenses, getExpense, saveExpense, setExpenseStatus, deleteExpense, listExpenseCategories, saveExpenseCategory, deleteExpenseCategory,
  listPurchaseDocs, getPurchaseDoc, savePurchaseDoc, convertPurchase, createPoFromQuotation, deletePurchaseDoc, findPurchase, purchaseItems, stockAdjust, syncPoReceived, purchaseAsPrintDoc, expenseAsPrintDoc, productAsPrintDoc };
