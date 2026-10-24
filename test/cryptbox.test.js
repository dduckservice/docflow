// test/cryptbox.test.js —เข้ารหัส/ถอดรหัสไฟล์สำรอง (Security Review C1/C2)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const CB = require('../src/cryptbox');

test('encrypt -> decrypt round-trip returns original', () => {
  const data = crypto.randomBytes(5000);
  const enc = CB.encrypt(data, 'correct horse battery staple');
  assert.ok(CB.isEnc(enc));
  assert.notDeepStrictEqual(enc.subarray(50, 50 + data.length), data);
  assert.deepStrictEqual(CB.decrypt(enc, 'correct horse battery staple'), data);
});

test('decrypt with wrong passphrase throws (GCM integrity)', () => {
  const enc = CB.encrypt(Buffer.from('secret db dump'), 'pass-1');
  assert.throws(() => CB.decrypt(enc, 'pass-2'));
});

test('any byte flip in ciphertext is detected', () => {
  const enc = CB.encrypt(Buffer.from('secret db dump'), 'p');
  const bad = Buffer.from(enc); bad[bad.length - 5] ^= 0xff;
  assert.throws(() => CB.decrypt(bad, 'p'));
});

test('isEnc rejects plain/gzip/short buffers', () => {
  assert.equal(CB.isEnc(Buffer.from('plain json string')), false);
  assert.equal(CB.isEnc(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0])), false);
  assert.equal(CB.isEnc(Buffer.alloc(10)), false);
  assert.equal(CB.isEnc(null), false);
});
