// เก็บไฟล์ในระบบ (ดิสก์ของเซิร์ฟเวอร์) ใต้โฟลเดอร์ Storage — ref ของโฟลเดอร์/ไฟล์ = path แบบสัมพัทธ์ใต้ STORAGE_DIR
const fs = require('fs/promises');
const path = require('path');
const { ROOT_NAME } = require('./layout');

const BASE = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', '..', 'Storage'));
const abs = rel => { const p = path.resolve(BASE, rel); if (p !== BASE && !p.startsWith(BASE + path.sep)) throw new Error('path ไม่ถูกต้อง'); return p; };
const exists = p => fs.access(p).then(() => true, () => false);
const { partsOf } = require('../util');
const stamp = () => { const p = partsOf(); return p.year + p.month + p.day + '-' + p.hour + p.minute + p.second; };

// ลบโฟลเดอร์ว่างที่เหลือหลังกู้คืน/ลบถาวร
async function pruneEmpty(dir) {
  // ไล่ลบโฟลเดอร์ว่างขึ้นไปเรื่อย ๆ แต่ไม่ลบโฟลเดอร์หลัก (01 เอกสาร PDF, 99 ถังขยะ ฯลฯ)
  const roots = Object.values(ROOT_NAME).map(r => abs(r));
  const top = roots.find(r => dir.startsWith(r + path.sep));
  if (!top) return;
  while (dir.startsWith(top + path.sep)) {
    if ((await fs.readdir(dir).catch(() => ['x'])).length) return;
    await fs.rmdir(dir).catch(() => {}); dir = path.dirname(dir);
  }
}

module.exports = {
  kind: 'local',
  async root(which) { const r = ROOT_NAME[which]; await fs.mkdir(abs(r), { recursive: true }); return r; },
  async folder(parent, name) { const r = path.posix.join(parent, name); await fs.mkdir(abs(r), { recursive: true }); return r; },
  async uniqueName(folder, name, st) {
    if (!(await exists(abs(path.posix.join(folder, name))))) return name;
    const m = name.match(/^(.*?)(\.[A-Za-z0-9]{1,5})$/);
    return m ? m[1] + '_' + st + m[2] : name + '_' + st;
  },
  async put(folder, name, mime, buf) { const sc = require('../maint').storageState(); if (!sc.ok) throw new Error(sc.msg); const id = path.posix.join(folder, name); await fs.writeFile(abs(id), buf); return { id, url: '' }; },
  async get(id) { return fs.readFile(abs(id)); },
  // ลบ = ย้ายไป "99 ถังขยะ" โดยคงโครงสร้างโฟลเดอร์เดิมไว้ → คืน { id ในถังขยะ, folder เดิม, name เดิม } (null ถ้าไม่มีไฟล์)
  async trash(id) {
    const src = abs(id); if (!(await exists(src))) return null;
    const tid = path.posix.join(ROOT_NAME.trash, path.posix.dirname(id), stamp() + '_' + path.posix.basename(id));
    await fs.mkdir(path.dirname(abs(tid)), { recursive: true }); await fs.rename(src, abs(tid));
    return { id: tid, folder: path.posix.dirname(id), name: path.posix.basename(id) };
  },
  // กู้คืนจากถังขยะไปโฟลเดอร์เดิม (ถ้าชื่อซ้ำจะเติมเวลาต่อท้าย)
  async restore(tid, folder, name) {
    if (!(await exists(abs(tid)))) throw new Error('ไม่พบไฟล์ในถังขยะ');
    await fs.mkdir(abs(folder), { recursive: true });
    const n = await module.exports.uniqueName(folder, name, stamp());
    const id = path.posix.join(folder, n);
    await fs.rename(abs(tid), abs(id));
    await pruneEmpty(path.dirname(abs(tid)));
    return id;
  },
  // รายชื่อไฟล์ทั้งหมดใน "99 ถังขยะ" (ใช้ดึงไฟล์ที่ถูกลบก่อนมีระบบบันทึกถังขยะมาแสดง)
  async listTrashFiles() {
    const out = [];
    async function walk(rel) {
      const ents = await fs.readdir(abs(rel), { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        const r = path.posix.join(rel, e.name);
        if (e.isDirectory()) await walk(r);
        else if (e.isFile() && !e.name.startsWith('.')) { const st = await fs.stat(abs(r)); out.push({ id: r, size: st.size, mtime: st.mtime }); }
      }
    }
    await walk(ROOT_NAME.trash);
    return out;
  },
  // ลบถาวร
  async purge(tid) { await fs.rm(abs(tid), { force: true }); await pruneEmpty(path.dirname(abs(tid))); },
  async move(id, folder) {
    let dst = path.posix.join(folder, path.posix.basename(id));
    if (dst === id) return id;
    if (await exists(abs(dst))) dst = path.posix.join(folder, stamp() + '_' + path.posix.basename(id));
    await fs.rename(abs(id), abs(dst)); return dst;
  },
  async listFolders(ref) {
    const ents = await fs.readdir(abs(ref), { withFileTypes: true }).catch(() => []);
    return ents.filter(e => e.isDirectory()).map(e => ({ ref: path.posix.join(ref, e.name), name: e.name }));
  },
  async trashFolder(ref) { await fs.rm(abs(ref), { recursive: true, force: true }); },
  async check() { for (const k of Object.keys(ROOT_NAME)) await fs.mkdir(abs(ROOT_NAME[k]), { recursive: true }); return 'local: ' + BASE; }
};
