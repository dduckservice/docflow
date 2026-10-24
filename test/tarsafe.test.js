// test/tarsafe.test.js — ตรวจการป้องกัน zip-slip/symlink ก่อนแตกไฟล์สำรอง (Security Review H1)
const test = require('node:test');
const assert = require('node:assert');
const { assertTypes, assertPaths } = require('../src/tarsafe');

test('assertTypes accepts regular files and directories', () => {
  assert.doesNotThrow(() => assertTypes(
    '-rw-r--r-- user/group 1024 2026-10-24 08:15 a.txt\n' +
    'drwxr-xr-x user/group 0 2026-10-24 08:15 sub/\n' +
    '-rw------- user/group 9999 2026-10-24 08:15 sub/deep.bin'));
});

test('assertTypes rejects symlink / hardlink / device / fifo members', () => {
  assert.throws(() => assertTypes('lrwxrwxrwx user/group 0 2026-10-24 escape -> /etc/passwd'));
  assert.throws(() => assertTypes('hrw-r--r-- user/group 0 2026-10-24 link'));
  assert.throws(() => assertTypes('brw-r--r-- user/group 0 2026-10-24 disk'));
  assert.throws(() => assertTypes('prw-r--r-- user/group 0 2026-10-24 fifo'));
});

test('assertPaths allows plain relative paths (incl. ./ prefix and spaces)', () => {
  assert.doesNotThrow(() => assertPaths('./\n./Storage/\n./manifest.json\n./database.enc'));
});

test('assertPaths rejects absolute paths and ".." traversal', () => {
  assert.throws(() => assertPaths('/etc/passwd'));
  assert.throws(() => assertPaths('../../root/.ssh/id_rsa'));
  assert.throws(() => assertPaths('./Storage/../../app/server.js'));
  assert.throws(() => assertPaths('..'));
});
