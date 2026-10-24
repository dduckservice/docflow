// รายงานข้ามหลายบริษัท: รวมรายได้ และแดชบอร์ด (เดิม: Platfrom.gs)
const { round2, dateOut, yearNow } = require('./util');
const { allowedTenants } = require('./platform');
const { expStatusOf } = require('./modules');

async function targets(ctx, ids) {
  const allowed = await allowedTenants(ctx, ctx.user);
  let want = Array.isArray(ids) ? ids.map(String) : [];
  if (!want.length || want.includes('*')) want = allowed.map(t => t.id);
  return { allowed, list: allowed.filter(t => want.includes(t.id)) };
}
const nameMap = list => Object.fromEntries(list.map(t => [t.id, t.name]));

// opts: { tenantIds, year, month (0 = ทั้งปี), basis: receipt|invoice }  ยอดสุทธิ = หลังหักส่วนลด ก่อน VAT
async function getIncomeReport(ctx, opts) {
  opts = opts || {};
  const thisYear = yearNow(), year = Number(opts.year) || thisYear, month = Number(opts.month) || 0;
  const basis = opts.basis === 'invoice' ? 'invoice' : 'receipt';
  const { allowed, list } = await targets(ctx, opts.tenantIds), names = nameMap(list);
  const years = new Set([thisYear, year]), docs = [];
  if (list.length) {
    (await ctx.all('SELECT DISTINCT extract(year FROM date)::int AS y FROM documents WHERE tenant_id = ANY($1::uuid[])', [list.map(t => t.id)])).forEach(r => years.add(r.y));
    const rows = await ctx.all(`SELECT * FROM documents WHERE tenant_id = ANY($1::uuid[]) AND type = ANY($2::text[]) AND status NOT IN ('cancelled','draft')
      AND extract(year FROM date) = $3::int AND ($4::int = 0 OR extract(month FROM date) = $4::int)`, [list.map(t => t.id), basis === 'receipt' ? ['receipt', 'cashsale', 'deposit'] : ['invoice', 'deposit'], year, month]);
    // Phase 2: รวมใบรับเงินมัดจำเป็นรายได้ด้วย และหักยอดมัดจำออกจาก net ของเอกสารงวดสุดท้าย (กันนับซ้ำ)
    rows.forEach(d => docs.push({ id: String(d.id), tenantId: String(d.tenantId), company: names[String(d.tenantId)], number: String(d.number), date: dateOut(d.date),
      customerName: String(d.customerName || '').trim(), net: round2((Number(d.subtotal) || 0) - (Number(d.discount) || 0) - (Number(d.depositAmount) || 0)), vatRate: Number(d.vatRate) || 0,
      vat: Number(d.vatAmount) || 0, total: Number(d.total) || 0 }));
  }
  docs.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.number < b.number ? -1 : 1);
  return { year, month, basis, docs, companies: list.map(t => ({ id: t.id, name: t.name, error: '' })), tenants: allowed, years: [...years].sort((a, b) => b - a) };
}

// opts: { tenantIds, year } — คืนเอกสารทุกประเภท/สถานะของปีนั้น ให้หน้าเว็บกรองเดือน/วันเอง
async function getDashboardData(ctx, opts) {
  opts = opts || {};
  const thisYear = yearNow(), year = Number(opts.year) || thisYear;
  const { allowed, list } = await targets(ctx, opts.tenantIds), names = nameMap(list), ids = list.map(t => t.id);
  const years = new Set([thisYear, year]), docs = [], expenses = [];
  if (ids.length) {
    (await ctx.all('SELECT DISTINCT extract(year FROM date)::int AS y FROM documents WHERE tenant_id = ANY($1::uuid[])', [ids])).forEach(r => years.add(r.y));
    (await ctx.all('SELECT * FROM documents WHERE tenant_id = ANY($1::uuid[]) AND extract(year FROM date) = $2', [ids, year])).forEach(d => docs.push({
      tenantId: String(d.tenantId), company: names[String(d.tenantId)], type: String(d.type), status: String(d.status), date: dateOut(d.date), number: String(d.number),
      customerName: String(d.customerName || '').trim(), net: round2((Number(d.subtotal) || 0) - (Number(d.discount) || 0) - (Number(d.depositAmount) || 0)), total: Number(d.total) || 0 }));
    (await ctx.all('SELECT * FROM expenses WHERE tenant_id = ANY($1::uuid[]) AND extract(year FROM date) = $2', [ids, year])).forEach(e => {
      if (expStatusOf(e.status) === 'cancelled') return;
      expenses.push({ tenantId: String(e.tenantId), company: names[String(e.tenantId)], date: dateOut(e.date), category: String(e.category || 'อื่นๆ'), net: Number(e.amountBeforeVat) || 0, total: Number(e.total) || 0 });
    });
  }
  return { year, docs, expenses, companies: list.map(t => ({ id: t.id, name: t.name, error: '' })), tenants: allowed, years: [...years].sort((a, b) => b - a) };
}

module.exports = { getIncomeReport, getDashboardData };
