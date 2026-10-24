// test/util.test.js — ตัวช่วยกลาง: ตรวจ regression ที่เคยเป็นช่องโหว่/บั๊กจาก Security Review 2.1
const test = require('node:test');
const assert = require('node:assert');
const u = require('../src/util');

test('dayShift ไม่ crash กับ input เสีย (L1) — คืนค่าว่าง', () => {
  assert.equal(u.dayShift('bad-date', 3), '');
  assert.equal(u.dayShift('', 1), '');
  assert.equal(u.dayShift(null, 1), '');
  assert.equal(u.dayShift('2026-01-31', 1), '2026-02-01');   // case จริงยังต้องใช้ได้
});

test('safeFolderName ปฏิเสธชื่อ "." และ ".." (L3)', () => {
  assert.equal(u.safeFolderName('..', 'FB'), 'FB');
  assert.equal(u.safeFolderName('.', 'FB'), 'FB');
  assert.ok(u.safeFolderName('../x', 'FB') !== '..' && u.safeFolderName('../x', 'FB') !== '.');   // ไม่มีทางได้ชื่อ traversal ล้วน
  assert.ok(!u.safeFolderName('a/../../b', 'FB').includes('/'));                                   // ตัวคั่นถูกตัดเสมอ
  assert.equal(u.safeFolderName('ลูกค้า A', 'FB'), 'ลูกค้า A');
  assert.equal(u.safeFolderName('   ', 'FB'), 'FB');
});

test('sniffMime จับ signature จริง/ปลอม (L2)', () => {
  assert.equal(u.sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png');
  assert.equal(u.sniffMime(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)])), 'image/jpeg');
  assert.equal(u.sniffMime(Buffer.from('%PDF-1.7\n%âãÏÓ')), 'application/pdf');
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(u.sniffMime(webp), 'image/webp');
  assert.equal(u.sniffMime(Buffer.from('GIF89a....')), 'image/gif');
  assert.equal(u.sniffMime(Buffer.from('<?php system($_GET["c"]); ?>')), '');                 // file ปลอม
  assert.equal(u.sniffMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), '');     // svg ถูกปฏิเสธ
  assert.equal(u.sniffMime(Buffer.from([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0])), '');   // EXE/MZ
});

test('csvCell บล็อก formula injection แต่ไม่แตะตัวเลข/ข้อความปกติ (M3)', () => {
  assert.equal(u.csvCell('=1+1'), "'=1+1");
  assert.equal(u.csvCell('=cmd|\' /C calc\'!A0'), "'=cmd|' /C calc'!A0");
  assert.equal(u.csvCell('+1'), "'+1");
  assert.equal(u.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(u.csvCell('-2+3+cmd'), "'-2+3+cmd");
  assert.equal(u.csvCell(-123.45), '-123.45');                 // ตัวเลขจริงต้องเหมือนเดิม
  assert.equal(u.csvCell('-5'), '-5');
  assert.equal(u.csvCell('hello'), 'hello');
  assert.equal(u.csvCell('a,"b"'), '"a,""b"""');               // ยัง quote ตาม RFC4180
});

test('toCsv ใส่ BOM + header + escape ครบ', () => {
  const csv = u.toCsv([{ a: 1, b: 'x,y' }, { a: '=-1', b: null }]);
  assert.ok(csv.charCodeAt(0) === 0xFEFF);
  const lines = csv.slice(1).split('\r\n');
  assert.equal(lines[0], 'a,b');
  assert.equal(lines[1], '1,"x,y"');
  assert.equal(lines[2], "'=-1,");
});

test('bahtText ครอบคลุมเคสพิจิต (ศูนย์/สิบ/ร้อย/เอ็ด/ล้าน/สตางค์)', () => {
  assert.equal(u.bahtText(0), 'ศูนย์บาทถ้วน');
  assert.equal(u.bahtText(1), 'หนึ่งบาทถ้วน');
  assert.equal(u.bahtText(11), 'สิบเอ็ดบาทถ้วน');
  assert.equal(u.bahtText(21), 'ยี่สิบเอ็ดบาทถ้วน');
  assert.equal(u.bahtText(1000001), 'หนึ่งล้านเอ็ดบาทถ้วน');   // หนึ่ง...เอ็ด คือไวยากรณ์ที่ถูกต้องเมื่อ 1 อยู่ท้ายจำนวน
  assert.equal(u.bahtText(0.01), 'หนึ่งสตางค์');
  assert.equal(u.bahtText(1.5), 'หนึ่งบาทห้าสิบสตางค์');
});
