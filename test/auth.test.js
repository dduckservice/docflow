// test/auth.test.js — ตรวจ logic ของ token/session/logout/super โดยไม่ต้องมีฐานข้อมูลจริง (ctx ปลอม)
const test = require('node:test');
const assert = require('node:assert');
process.env.TOKEN_SECRET = process.env.TOKEN_SECRET || 'a'.repeat(96);   // initSecret ต้องการ env นี้ (fail-closed ตั้งแต่ 2.1)
const P = require('../src/platform');

function ctx(u) {
  return {
    user: u, tenantId: 't1', _after: [],
    _store: { super: new Set(u && u.isSuper ? [String(u.id)] : []) },
    afterCommit() {},
    async one(sql, params) {
      if (/FROM users WHERE id/.test(sql)) return u && String(u.id) === String(params[0]) && u.status === 'active' ? u : null;
      return null;
    },
    async all(sql) {
      if (/FROM users WHERE is_super/.test(sql)) return [...this._store.super].map(id => ({ id }));
      return [];
    },
    async exec(sql) { if (/DELETE FROM app_settings/.test(sql)) return {}; return {}; },
    async log() {},
    username() { return u ? String(u.username) : ''; },
    async lock() {},
  };
}

test('makeToken -> authUser คืน user เดียวกัน (รูปแบบใหม่ 3 ส่วน, ไม่มี password hash)', async () => {
  const u = { id: '11111111-1111-1111-1111-111111111111', username: 'bob', status: 'active', role: 'viewer',
    passwordHash: P.hashPw('pw', 's'), salt: 's', sessionId: 'sess-1' };
  const tk = P.makeToken(u);
  const parts = Buffer.from(tk.split('.')[0], 'base64url').toString().split('|');
  assert.equal(parts.length, 3, 'payload ต้องเป็น uid|exp|sid (ไม่ใส่ hash อีกต่อไป)');
  const r = await P.authUser(ctx(u), tk);
  assert.ok(r.user && String(r.user.id) === String(u.id));
});

test('authUser ปฏิเสธ token ที่แก้ sid/uid ไม่ตรง session ใน DB', async () => {
  const u = { id: 'u1', username: 'bob', status: 'active', passwordHash: P.hashPw('pw', 's'), salt: 's', sessionId: 'sess-1' };
  const tk = P.makeToken(u);
  const r = await P.authUser(ctx({ ...u, sessionId: 'other' }), tk);
  assert.equal(r.why, 'replaced');
});

test('authUser ปฏิเสธลายเซ็นปลอม/รูปแบบผิด', async () => {
  assert.equal((await P.authUser(ctx({ id: 'u1' }), 'not-a-token')).why, 'expired');
  assert.equal((await P.authUser(ctx({ id: 'u1' }), 'aaaa.bbbb')).why, 'expired');
});

test('superIds fail-closed: ไม่มี is_super = ว่าง (ไม่ดึง admin ธรรมดาขึ้นมาเป็น Super)', async () => {
  const c = { _after: [], async all() { return []; }, async one() { return null; }, async exec() {} };
  assert.equal((await P.superIdsPublic(c)).size, 0);
});

test('initSecret ไม่ throw เมื่อ TOKEN_SECRET ถูกต้อง', async () => {
  const c = { async exec() {} };
  await assert.doesNotThrow(() => P.initSecret(c));
});
