// ตัวช่วยทั่วไป (เดิมกระจายอยู่ใน Code.gs / Platfrom.gs)
const crypto = require('crypto');
const TZ = process.env.APP_TZ || 'Asia/Bangkok';
const VAT_RATE = 7;

const uuid = () => crypto.randomUUID();
function fail(msg) { throw new Error(msg); }

// ---------- วันที่/เวลา ----------
const _fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function partsOf(d) { const o = {}; _fmt.formatToParts(d || new Date()).forEach(p => { o[p.type] = p.value; }); return o; }
function todayStr(d) { const p = partsOf(d); return `${p.year}-${p.month}-${p.day}`; }
function ymNow() { return todayStr().slice(0, 7); }
function yearNow() { return Number(todayStr().slice(0, 4)); }
function compactDay(d) { return todayStr(d).replace(/-/g, ''); }
// dd/MM/yyyy(พ.ศ.) HH:mm[:ss]
function beStamp(d, withSec) {
  const p = partsOf(d || new Date());
  return `${p.day}/${p.month}/${Number(p.year) + 543} ${p.hour}:${p.minute}` + (withSec === false ? '' : ':' + p.second);
}
function tsOut(v) {
  if (v === '' || v == null) return '';
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? String(v) : beStamp(d, false);
}
function tsMs(v) { if (!v) return 0; const d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? 0 : d.getTime(); }
function dateOut(v) {
  if (!v) return '';
  if (v instanceof Date) return todayStr(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(new Date(s + 'T00:00:00Z').getTime()); }
function ymdParse(s) { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
function ymdMs(s) { const p = ymdParse(s); return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN; }
function daysBetween(a, b) { return Math.round((ymdMs(b) - ymdMs(a)) / 86400000); }
function ymdFmt(y, m, d) { return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'); }
function addMonths(s, n) {
  const p = ymdParse(s); if (!p) return '';
  const t = p.y * 12 + (p.m - 1) + n, y = Math.floor(t / 12), m = (t % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ymdFmt(y, m, Math.min(p.d, last));
}
function dayShift(s, n) { const p = ymdParse(s); if (!p) return ''; const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return ymdFmt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); }

// ---------- ตรวจเนื้อไฟล์จริง (magic bytes) ให้ตรงกับ MIME ที่ผู้ใช้แจ้ง — กันไฟล์ชนิดอื่นแอบแนบมาในนามสกุลรูป/PDF ----------
// คืน mime ที่ตรวจพบ หรือ '' ถ้าไม่รู้จัก · รองรับ pdf/png/jpeg/webp/gif
function sniffMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return '';
  if (buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';   // 8-byte PNG signature
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6) { const g = buf.slice(0, 6).toString('ascii'); if (g === 'GIF87a' || g === 'GIF89a') return 'image/gif'; }
  return '';
}

// ---------- ข้อความ/ตัวเลข ----------
function clean(v, max = 2000) { return String(v == null ? '' : v).trim().slice(0, max); }
function num(v, label) {
  if (v === '' || v === null || v === undefined) fail('กรุณากรอก' + label);
  const n = Number(v);
  if (!Number.isFinite(n)) fail('ค่าตัวเลขไม่ถูกต้อง: ' + label);
  return n;
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }
function round3(n) { return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; }
function parseVat(v) {
  if (v === '' || v === null || v === undefined) return VAT_RATE;
  const n = Number(v);
  if (![0, 3, 7].includes(n)) fail('อัตราภาษีมูลค่าเพิ่มไม่ถูกต้อง');
  return n;
}
function parseWht(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(v);
  if (![0, 1, 2, 3, 5].includes(n)) fail('อัตราภาษีหัก ณ ที่จ่ายไม่ถูกต้อง');
  return n;
}
function fmt(n, d) {
  d = d === undefined ? 2 : d; const p = Math.pow(10, d);
  const s = (Math.round((Number(n) || 0) * p) / p).toFixed(d).split('.');
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); return s.join('.');
}
function thDate(v) { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + (Number(m[1]) + 543) : '-'; }
function ceDate(v) { const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1] : '-'; }
function bahtText(n) {
  const D = ['ศูนย์', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'], U = ['', 'สิบ', 'ร้อย', 'พัน', 'หมื่น', 'แสน'];
  const chunk = s => { let r = ''; const L = s.length;
    for (let i = 0; i < L; i++) { const d = +s[i], p = L - i - 1; if (!d) continue;
      if (p === 0 && d === 1 && L > 1) r += 'เอ็ด'; else if (p === 1 && d === 2) r += 'ยี่'; else if (!(p === 1 && d === 1)) r += D[d];
      r += U[p]; } return r; };
  const int = s => { s = s.replace(/^0+/, ''); if (!s) return ''; return s.length > 6 ? int(s.slice(0, -6)) + 'ล้าน' + chunk(s.slice(-6)) : chunk(s); };
  const parts = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2).split('.');
  const sat = parts[1] === '01' ? 'หนึ่ง' : chunk(parts[1]);
  if (parts[1] !== '00' && !int(parts[0])) return sat + 'สตางค์';
  return (int(parts[0]) || 'ศูนย์') + 'บาท' + (parts[1] === '00' ? 'ถ้วน' : sat + 'สตางค์');
}
function bahtTextEn(n) {
  const ones = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const b1000 = x => { let r = '';
    if (x >= 100) { r += ones[Math.floor(x / 100)] + ' Hundred'; x %= 100; if (x) r += ' '; }
    if (x >= 20) { r += tens[Math.floor(x / 10)]; if (x % 10) r += '-' + ones[x % 10]; } else if (x > 0) r += ones[x];
    return r; };
  const int = x => { if (x === 0) return 'Zero'; const sc = ['', ' Thousand', ' Million', ' Billion']; const out = [];
    for (let i = 0; x > 0 && i < sc.length; i++, x = Math.floor(x / 1000)) { const c = x % 1000; if (c) out.unshift(b1000(c) + sc[i]); }
    return out.join(' '); };
  const v = Math.round((Number(n) || 0) * 100) / 100, bt = Math.floor(v), st = Math.round((v - bt) * 100);
  return int(bt) + ' Baht' + (st ? ' and ' + int(st) + ' Satang' : ' Only');
}
function safeFolderName(s, fallback) {
  let v = String(s || '').replace(/[\\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (v === '.' || v === '..') v = '';   // กัน '../' ปลิว (ชื่อโฟลเดอร์พิเศษ ทำให้ path เพี้ยน)
  return v || fallback;
}
const MONTH_TH = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function monthFolderName(ym) { const p = ym.split('-'); return p[1] + ' ' + MONTH_TH[Number(p[1]) - 1]; }
function ymOf(d) { return /^\d{4}-\d{2}/.test(String(d || '')) ? String(d).slice(0, 7) : ymNow(); }
const localeTh = (a, b) => String(a).localeCompare(String(b), 'th');

// CSV (UTF-8 + BOM สำหรับ Excel) — กัน CSV formula injection: ค่าที่ขึ้นต้นด้วย = + - @ หรือ tab/CR
// จะถูก Excel/Sheets ตีความเป็นสูตร → ใส่ ' นำหน้า (M3 Security Review)
function csvCell(v) {
  if (v == null) return '';
  if (v instanceof Date) v = v.toISOString();
  else if (Buffer.isBuffer(v)) v = '(ไฟล์)';
  else if (typeof v === 'object') v = JSON.stringify(v);
  v = String(v);
  // บล็อก CSV formula injection: ค่าที่ขึ้นต้นด้วย = + @ tab CR หรือ - ตามด้วยสูตร (ไม่ใช่เลขติดลบล้วน) → ใส่ ' นำหน้า ให้ Excel มองเป็นข้อความ
  if (/^[=+@\t\r]/.test(v) || (/^-/.test(v) && !/^-?\d+(\.\d+)?$/.test(v))) v = "'" + v;
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function toCsv(rows) { if (!rows.length) return '\ufeff' /* BOM */; const cols = Object.keys(rows[0]); return '\ufeff' + [cols.join(','), ...rows.map(r => cols.map(c => csvCell(r[c])).join(','))].join('\r\n'); }

module.exports = { TZ, VAT_RATE, uuid, fail, partsOf, todayStr, ymNow, yearNow, compactDay, beStamp, tsOut, tsMs, dateOut, isYmd, ymdParse, daysBetween, addMonths, dayShift,
  clean, num, round2, round3, parseVat, parseWht, fmt, thDate, ceDate, bahtText, bahtTextEn, safeFolderName, sniffMime, csvCell, toCsv, MONTH_TH, monthFolderName, ymOf, localeTh };
