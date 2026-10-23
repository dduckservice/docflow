// ============================================================
//  fullbackup.js — สำรอง / กู้คืนข้อมูลทั้งระบบจากหน้าเว็บ (เฉพาะ Super Admin)
//
//  ไฟล์สำรอง 1 ชุด = 1 ไฟล์ .tar ในโฟลเดอร์ Backups/full บนเครื่องเซิร์ฟเวอร์
//    docflow-2026-10-22_193000-manual.tar
//      ├─ manifest.json      รายละเอียดชุดสำรอง (เวลา ผู้สร้าง จำนวนข้อมูล checksum)
//      ├─ database.json.gz   ข้อมูลทุกตารางในฐานข้อมูล
//      └─ storage.tar.gz     ไฟล์ทั้งหมดในโฟลเดอร์ Storage (PDF, ไฟล์อัปโหลด, ไฟล์แชท, ถังขยะ)
//  คัดลอกไฟล์ .tar ลงแฟลชไดรฟ์ได้เลย · จะกู้คืนจากแฟลชไดรฟ์: คัดลอกไฟล์กลับมาไว้ใน Backups/full แล้วกดกู้คืนในหน้าเว็บ
//
//  กู้คืน: ตรวจไฟล์ → สำรองข้อมูลปัจจุบันก่อน (กันพลาด) → ปิดระบบชั่วคราว → แตกไฟล์ → นำเข้าฐานข้อมูล (transaction เดียว
//  ถ้าพังกลางทางข้อมูลเดิมไม่เปลี่ยน) → สลับโฟลเดอร์ Storage → เปิดระบบ · ทุกขั้นตอนบันทึกเป็น log
// ============================================================
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { pool } = require('./db');
const { exportAll, importAll, TABLES } = require('./backup');
const hub = require('./hub');
const { fail, tsOut } = require('./util');

const ROOT = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'Backups'));
const DIR = path.join(ROOT, 'full');
const STORAGE = path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'Storage'));
const WORK = path.join(ROOT, '.work');
const HISTORY = path.join(DIR, 'history.jsonl');
const SCHED_FILE = path.join(DIR, 'schedule.json');   // ตารางเวลาสำรองอัตโนมัติ (เก็บเป็นไฟล์ ไม่หายเมื่อกู้คืนข้อมูล)
const NAME_RE = /^docflow-(\d{4}-\d{2}-\d{2})_(\d{6})-(manual|auto|before-restore)\.tar$/;
const KIND_TH = { manual: 'สำรองเอง', auto: 'สำรองอัตโนมัติ', 'before-restore': 'สำรองก่อนกู้คืน' };
const SKIP_STORAGE = ['03 สำรองข้อมูล'];   // ไฟล์สำรอง JSON รายวันเดิม ไม่ต้องรวม

// ---------- สถานะงาน (ทำได้ทีละงาน) ----------
let JOB = null;            // งานปัจจุบัน/ล่าสุด
const JOBS = new Map();    // id → job (เก็บ 20 งานล่าสุด)
let MAINT = false;         // true = ระหว่างกู้คืน ปิดการใช้งานชั่วคราว
const maint = () => MAINT;

function newJob(type, by, extra) {
  if (JOB && JOB.state === 'running') fail('มีงานสำรอง/กู้คืนกำลังทำอยู่ กรุณารอให้เสร็จก่อน');
  const job = { id: crypto.randomBytes(12).toString('hex'), type, by, state: 'running', step: '', log: [], startedAt: new Date().toISOString(), finishedAt: '', file: '', ...extra };
  JOB = job; JOBS.set(job.id, job);
  if (JOBS.size > 20) JOBS.delete(JOBS.keys().next().value);
  return job;
}
function log(job, msg, lvl) {
  const line = { t: new Date().toISOString(), msg, lvl: lvl || 'info' };
  job.log.push(line); if (lvl !== 'detail') job.step = msg;
  console.log('[' + job.type + '] ' + msg);
}
async function history(job) {
  await fsp.mkdir(DIR, { recursive: true });
  const h = { id: job.id, type: job.type, state: job.state, by: job.by, file: job.type === 'restore' ? job.source : job.file, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error || '', summary: job.preFile ? 'ข้อมูลเดิมก่อนกู้คืนเก็บไว้ที่ ' + job.preFile : '' };
  await fsp.appendFile(HISTORY, JSON.stringify(h) + '\n');
}
function run(cmd, args, opts) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...opts });
    let err = ''; p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', rej);
    p.on('close', code => code === 0 ? res() : rej(new Error(cmd + ' ล้มเหลว: ' + (err.trim().split('\n').pop() || 'code ' + code))));
  });
}
function runOut(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); const out = [];
    p.stdout.on('data', d => out.push(d)); p.on('error', rej);
    p.on('close', code => code === 0 ? res(Buffer.concat(out)) : rej(new Error(cmd + ' code ' + code)));
  });
}
async function sha256(file) { const h = crypto.createHash('sha256'); await pipeline(fs.createReadStream(file), h); return h.digest('hex'); }
async function dirSize(d) {
  let n = 0, files = 0;
  let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (e) { return { bytes: 0, files: 0 }; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { const s = await dirSize(p); n += s.bytes; files += s.files; }
    else if (e.isFile()) { try { n += (await fsp.stat(p)).size; files++; } catch (_) {} }
  }
  return { bytes: n, files };
}
async function freeBytes(d) { try { const s = await fsp.statfs(d); return s.bavail * s.bsize; } catch (e) { return Infinity; } }
const mb = n => (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + ' MB';
const stampOf = d => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {}); return `${p.year}-${p.month}-${p.day}_${p.hour === '24' ? '00' : p.hour}${p.minute}${p.second}`; };
const rmrf = p => fsp.rm(p, { recursive: true, force: true }).catch(() => {});
function safeName(name) { name = path.basename(String(name || '')); if (!NAME_RE.test(name)) fail('ชื่อไฟล์สำรองไม่ถูกต้อง'); return name; }

// ---------- สร้างไฟล์สำรอง ----------
async function doBackup(job, kind, note) {
  await fsp.mkdir(DIR, { recursive: true });
  const work = path.join(WORK, job.id + '-' + kind); await rmrf(work); await fsp.mkdir(work, { recursive: true });
  try {
    const sc = require('./maint').storageState(); if (!sc.ok) throw new Error(sc.msg);
    log(job, 'ตรวจขนาดไฟล์ใน Storage');
    const st = await dirSize(STORAGE), free = await freeBytes(ROOT);
    log(job, `Storage ${st.files} ไฟล์ (${mb(st.bytes)}) · พื้นที่ว่าง ${free === Infinity ? '-' : mb(free)}`, 'detail');
    if (free < st.bytes * 1.1 + 200 * 1048576) throw new Error(`พื้นที่ดิสก์ไม่พอ (ว่าง ${mb(free)} ต้องการประมาณ ${mb(st.bytes * 1.1 + 200 * 1048576)}) กรุณาลบไฟล์สำรองเก่าหรือย้ายออกก่อน`);

    log(job, 'สำรองฐานข้อมูล');
    const c = await pool.connect(); let data;
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); await c.query('SET LOCAL statement_timeout = 0');
      data = await exportAll(c); await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    const counts = {}; for (const t of TABLES) counts[t] = (data.tables[t] || []).length;
    await fsp.writeFile(path.join(work, 'database.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(data))));
    data = null;
    const dbSize = (await fsp.stat(path.join(work, 'database.json.gz'))).size;
    log(job, `ฐานข้อมูล: บริษัท ${counts.tenants} · ผู้ใช้ ${counts.users} · เอกสาร ${counts.documents} · ค่าใช้จ่าย ${counts.expenses} (${mb(dbSize)})`, 'detail');

    log(job, `สำรองไฟล์ใน Storage (${st.files} ไฟล์)`);
    await run('tar', ['-czf', path.join(work, 'storage.tar.gz'), '-C', STORAGE, ...SKIP_STORAGE.map(x => '--exclude=./' + x), '--exclude=./.restore-*', '.']);
    const stSize = (await fsp.stat(path.join(work, 'storage.tar.gz'))).size;
    log(job, `ไฟล์ Storage บีบอัดแล้ว ${mb(stSize)}`, 'detail');

    log(job, 'ตรวจสอบความถูกต้องและรวมเป็นไฟล์เดียว');
    const now = new Date(), name = `docflow-${stampOf(now)}-${kind}.tar`;
    const manifest = { app: 'docflow', format: 1, kind, note: String(note || '').slice(0, 200), createdAt: now.toISOString(), createdBy: job.by,
      tables: counts, storage: { files: st.files, bytes: st.bytes },
      sha256: { 'database.json.gz': await sha256(path.join(work, 'database.json.gz')), 'storage.tar.gz': await sha256(path.join(work, 'storage.tar.gz')) } };
    await fsp.writeFile(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const part = path.join(DIR, name + '.part');
    await run('tar', ['-cf', part, '-C', work, 'manifest.json', 'database.json.gz', 'storage.tar.gz']);
    await fsp.rename(part, path.join(DIR, name));
    const size = (await fsp.stat(path.join(DIR, name))).size;
    job.file = name; MAN_CACHE.delete(name);
    log(job, `บันทึกไฟล์ ${name} (${mb(size)}) ที่โฟลเดอร์ Backups/full`);
    if (kind === 'auto') await pruneAuto(job);
    return { name, size, manifest };
  } finally { await rmrf(work); }
}
async function pruneAuto(job) {
  const autos = (await fsp.readdir(DIR)).filter(n => NAME_RE.test(n) && n.endsWith('-auto.tar')).sort().reverse();
  for (const n of autos.slice(SCHED.keep)) { await fsp.unlink(path.join(DIR, n)).catch(() => {}); log(job, 'ลบไฟล์สำรองอัตโนมัติเก่า ' + n, 'detail'); }
}
async function finish(job, err) {
  job.finishedAt = new Date().toISOString();
  if (err) { job.state = 'error'; job.error = String(err.message || err); log(job, 'ไม่สำเร็จ: ' + job.error, 'error'); }
  else { job.state = 'done'; log(job, job.type === 'restore' ? 'กู้คืนข้อมูลเสร็จสมบูรณ์' : 'สำรองข้อมูลเสร็จสมบูรณ์', 'ok'); }
  await history(job).catch(() => {});
  try { hub.toSupers({ type: 'backup', action: job.state, kind: job.kind || '', jobType: job.type }); } catch (e) {}
}
function startBackup(by, kind, note) {
  const job = newJob('backup', by, { kind });
  log(job, 'เริ่มสำรองข้อมูล' + (note ? ' — ' + note : ''));
  (async () => { try { const r = await doBackup(job, kind, note); job.summary = r.name; await finish(job); } catch (e) { await finish(job, e); } })();
  return job;
}

// ---------- กู้คืน ----------
async function readManifest(file) { return JSON.parse((await runOut('tar', ['-xOf', file, 'manifest.json'])).toString('utf8')); }
async function swapStorage(job, fresh) {
  const old = path.join(STORAGE, '.restore-old');
  await rmrf(old); await fsp.mkdir(old, { recursive: true });
  const keep = new Set([...SKIP_STORAGE, '.restore-old', '.restore-new']);
  for (const n of await fsp.readdir(STORAGE)) if (!keep.has(n) && !n.startsWith('.')) await fsp.rename(path.join(STORAGE, n), path.join(old, n));
  for (const n of await fsp.readdir(fresh)) if (!keep.has(n)) await fsp.rename(path.join(fresh, n), path.join(STORAGE, n));
  await rmrf(old); await rmrf(fresh);
}
function startRestore(by, name) {
  name = safeName(name);
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) fail('ไม่พบไฟล์สำรอง ' + name);
  const job = newJob('restore', by, { source: name });
  log(job, 'เริ่มกู้คืนข้อมูลจาก ' + name);
  (async () => {
    const work = path.join(WORK, job.id), fresh = path.join(STORAGE, '.restore-new');
    try {
      await rmrf(work); await fsp.mkdir(work, { recursive: true });
      log(job, 'ตรวจสอบไฟล์สำรอง');
      try { await run('tar', ['-xf', file, '-C', work]); } catch (e) { throw new Error('ไฟล์สำรองเสียหายหรือไม่ใช่ไฟล์สำรองของ DocFlow (เปิดไฟล์ไม่ได้) — ถ้าคัดลอกมาจากแฟลชไดรฟ์ ลองคัดลอกใหม่'); }
      let m; try { m = JSON.parse(await fsp.readFile(path.join(work, 'manifest.json'), 'utf8')); } catch (e) { throw new Error('ไม่ใช่ไฟล์สำรองของ DocFlow (ไม่มี manifest.json)'); }
      if (m.app !== 'docflow') throw new Error('ไม่ใช่ไฟล์สำรองของ DocFlow');
      for (const f of ['database.json.gz', 'storage.tar.gz']) {
        if (!fs.existsSync(path.join(work, f))) throw new Error('ไฟล์สำรองไม่ครบ (ไม่พบ ' + f + ')');
        if (m.sha256 && m.sha256[f] && m.sha256[f] !== await sha256(path.join(work, f))) throw new Error('ไฟล์สำรองเสียหาย (' + f + ' ไม่ตรงกับ checksum) — ลองคัดลอกไฟล์จากแฟลชไดรฟ์ใหม่');
      }
      log(job, `ไฟล์สมบูรณ์ · สร้างเมื่อ ${tsOut(m.createdAt)} โดย ${m.createdBy || '-'} · บริษัท ${m.tables.tenants} · เอกสาร ${m.tables.documents} · ไฟล์ ${m.storage.files}`, 'detail');

      log(job, 'สำรองข้อมูลปัจจุบันไว้ก่อน (ใช้ย้อนกลับได้ถ้ากู้คืนผิดชุด)');
      const pre = await doBackup(job, 'before-restore', 'ก่อนกู้คืนจาก ' + name);
      log(job, 'สำรองข้อมูลปัจจุบันแล้ว: ' + pre.name, 'detail');
      job.preFile = pre.name;

      log(job, 'ปิดการใช้งานระบบชั่วคราว');
      MAINT = true; hub.toAll({ type: 'maint', on: true });
      await new Promise(r => setTimeout(r, 1500));   // รอคำขอที่ค้างอยู่ทำงานเสร็จ

      log(job, 'แตกไฟล์ Storage');
      await rmrf(fresh); await fsp.mkdir(fresh, { recursive: true });
      await run('tar', ['-xzf', path.join(work, 'storage.tar.gz'), '-C', fresh]);

      log(job, 'นำเข้าฐานข้อมูล');
      const data = JSON.parse(zlib.gunzipSync(await fsp.readFile(path.join(work, 'database.json.gz'))).toString('utf8'));
      const c = await pool.connect();
      try { await c.query('BEGIN'); await importAll(c, data); await c.query('COMMIT'); }
      catch (e) { await c.query('ROLLBACK').catch(() => {}); throw new Error('นำเข้าฐานข้อมูลไม่สำเร็จ ข้อมูลเดิมยังอยู่ครบ (' + e.message + ')'); }
      finally { c.release(); }
      log(job, 'นำเข้าฐานข้อมูลแล้ว ' + Object.keys(data.tables).length + ' ตาราง', 'detail');

      log(job, 'สลับไฟล์ใน Storage เป็นชุดที่กู้คืน');
      await swapStorage(job, fresh);
      job.summary = name;
      await finish(job);
    } catch (e) { await rmrf(fresh); await finish(job, e); }
    finally {
      await rmrf(work);
      if (MAINT) { MAINT = false; hub.toAll({ type: job.state === 'done' ? 'restored' : 'maint', on: false }); }
    }
  })();
  return job;
}

// ---------- ตั้งเวลาสำรองอัตโนมัติ ----------
//  mode: off | daily | weekly | monthly · time 'HH:MM' (เวลาไทย) · weekdays [0=อา..6=ส] · monthDays [1..31, 'last' = วันสุดท้ายของเดือน]
function defaultSched() {
  const c = String(process.env.FULL_BACKUP_CRON || '0 1 * * *').trim().split(/\s+/);
  const off = /^(0|false|off)$/i.test(c[0]) && c.length === 1;
  const time = /^\d+$/.test(c[0]) && /^\d+$/.test(c[1]) ? String(c[1]).padStart(2, '0') + ':' + String(c[0]).padStart(2, '0') : '01:00';
  return { mode: off ? 'off' : 'daily', time, weekdays: [1], monthDays: [1], keep: Math.max(1, Number(process.env.FULL_BACKUP_KEEP || 7)) };
}
function cleanSched(x) {
  const d = defaultSched(); x = x || {};
  const mode = ['off', 'daily', 'weekly', 'monthly'].includes(x.mode) ? x.mode : d.mode;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.time || '')) ? String(x.time) : d.time;
  const weekdays = [...new Set((Array.isArray(x.weekdays) ? x.weekdays : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const monthDays = [...new Set((Array.isArray(x.monthDays) ? x.monthDays : []).map(v => v === 'last' ? 'last' : Number(v)).filter(v => v === 'last' || (Number.isInteger(v) && v >= 1 && v <= 31)))]
    .sort((a, b) => (a === 'last' ? 99 : a) - (b === 'last' ? 99 : b));
  const keep = Math.min(365, Math.max(1, Math.floor(Number(x.keep) || d.keep)));
  if (mode === 'weekly' && !weekdays.length) fail('กรุณาเลือกวันในสัปดาห์อย่างน้อย 1 วัน');
  if (mode === 'monthly' && !monthDays.length) fail('กรุณาเลือกวันที่ของเดือนอย่างน้อย 1 วัน');
  return { mode, time, weekdays: weekdays.length ? weekdays : d.weekdays, monthDays: monthDays.length ? monthDays : d.monthDays, keep };
}
let SCHED = defaultSched();
try { SCHED = cleanSched(JSON.parse(fs.readFileSync(SCHED_FILE, 'utf8'))); } catch (e) {}
const bkk = d => { const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(d).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { y: +p.year, m: +p.month, d: +p.day, hm: (p.hour === '24' ? '00' : p.hour) + ':' + p.minute, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }; };
function dayMatches(sc, y, m, d, wd) {
  if (sc.mode === 'daily') return true;
  if (sc.mode === 'weekly') return sc.weekdays.includes(wd);
  if (sc.mode === 'monthly') { const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return sc.monthDays.some(x => x === 'last' ? d === last : (x === d || (x > last && d === last))); }   // วันที่ 31 ในเดือนที่มี 30 วัน → ทำวันสุดท้าย
  return false;
}
function nextRun(sc, from) {
  if (sc.mode === 'off') return null;
  const [hh, mm] = sc.time.split(':').map(Number);
  for (let i = 0; i < 400; i++) {
    const day = new Date((from || Date.now()) + i * 864e5), b = bkk(day);
    const at = new Date(Date.UTC(b.y, b.m - 1, b.d, hh - 7, mm));   // เวลาไทย → UTC
    if (at.getTime() <= (from || Date.now())) continue;
    const wd = new Date(Date.UTC(b.y, b.m - 1, b.d)).getUTCDay();
    if (dayMatches(sc, b.y, b.m, b.d, wd)) return at.toISOString();
  }
  return null;
}
let LAST_SLOT = '';
function schedulerTick() {
  if (SCHED.mode === 'off') return;
  const b = bkk(new Date()), slot = `${b.y}-${b.m}-${b.d} ${b.hm}`;
  if (b.hm !== SCHED.time || slot === LAST_SLOT) return;
  const wd = new Date(Date.UTC(b.y, b.m - 1, b.d)).getUTCDay();
  if (!dayMatches(SCHED, b.y, b.m, b.d, wd)) return;
  LAST_SLOT = slot; autoBackup();
}
let TICKER = null;
function startScheduler() { if (!TICKER) TICKER = setInterval(schedulerTick, 20e3); TICKER.unref && TICKER.unref(); }
async function backupSaveSchedule(ctx, x) {
  const sc = cleanSched(x);
  await fsp.mkdir(DIR, { recursive: true });
  await fsp.writeFile(SCHED_FILE, JSON.stringify(sc, null, 2));
  SCHED = sc;
  return { schedule: SCHED, nextRun: nextRun(SCHED) };
}

// ---------- รายการไฟล์สำรอง ----------
const MAN_CACHE = new Map();   // name → { mtime, manifest }
async function listBackups() {
  await fsp.mkdir(DIR, { recursive: true });
  const out = [];
  for (const n of await fsp.readdir(DIR)) {
    const m = n.match(NAME_RE); if (!m) continue;
    const st = await fsp.stat(path.join(DIR, n)).catch(() => null); if (!st) continue;
    let man = MAN_CACHE.get(n);
    if (!man || man.mtime !== st.mtimeMs) { man = { mtime: st.mtimeMs, manifest: await readManifest(path.join(DIR, n)).catch(() => null) }; MAN_CACHE.set(n, man); }
    const mf = man.manifest || {};
    out.push({ name: n, date: m[1], time: m[2].replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3'), kind: m[3], kindTh: KIND_TH[m[3]], size: st.size,
      createdBy: mf.createdBy || '', note: mf.note || '', ok: !!man.manifest,
      counts: mf.tables ? { companies: mf.tables.tenants, users: mf.tables.users, documents: mf.tables.documents, expenses: mf.tables.expenses, uploads: mf.tables.uploads } : null,
      files: mf.storage ? mf.storage.files : null });
  }
  return out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
}
async function readHistory() {
  try { return (await fsp.readFile(HISTORY, 'utf8')).trim().split('\n').filter(Boolean).slice(-40).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse(); }
  catch (e) { return []; }
}
const jobOut = j => j && { id: j.id, type: j.type, state: j.state, step: j.step, by: j.by, file: j.file, source: j.source || '', error: j.error || '', startedAt: j.startedAt, finishedAt: j.finishedAt, log: j.log };

// ---------- API (Super Admin) ----------
const who = ctx => String(ctx.user.displayName || ctx.user.username);
async function backupOverview(ctx) {
  const items = await listBackups(), free = await freeBytes(ROOT);
  let total = null; try { const s = await fsp.statfs(ROOT); total = s.blocks * s.bsize; } catch (e) {}
  return { items, history: await readHistory(), job: jobOut(JOB), disk: { free: free === Infinity ? null : free, total }, folder: path.join(process.env.BACKUP_HOST_PATH || 'Backups', 'full').replace(/\\/g, '/'), storageHost: process.env.STORAGE_HOST_PATH || './Storage', storageState: require('./maint').storageState(), storageDisk: await require('./maint').diskOf(STORAGE), schedule: SCHED, nextRun: nextRun(SCHED) };
}
async function backupCreate(ctx, note) { const j = startBackup(who(ctx), 'manual', String(note || '').trim()); return { jobId: j.id }; }
async function backupRestore(ctx, name, confirm) {
  if (String(confirm || '').trim() !== 'กู้คืน') fail('กรุณาพิมพ์คำว่า กู้คืน เพื่อยืนยัน');
  const j = startRestore(who(ctx), name); return { jobId: j.id };
}
async function backupDelete(ctx, name) {
  name = safeName(name);
  if (JOB && JOB.state === 'running') fail('มีงานสำรอง/กู้คืนกำลังทำอยู่ กรุณารอให้เสร็จก่อน');
  await fsp.unlink(path.join(DIR, name)).catch(() => fail('ไม่พบไฟล์'));
  MAN_CACHE.delete(name);
  return true;
}
// ลิงก์ดาวน์โหลดใช้ครั้งเดียว อายุ 2 นาที (ไม่ต้องใส่ token ใน URL)
const TICKETS = new Map();
async function backupTicket(ctx, name) {
  name = safeName(name);
  if (!fs.existsSync(path.join(DIR, name))) fail('ไม่พบไฟล์');
  const t = crypto.randomBytes(18).toString('hex'); TICKETS.set(t, { name, exp: Date.now() + 120e3 });
  for (const [k, v] of TICKETS) if (v.exp < Date.now()) TICKETS.delete(k);
  return { url: 'api/backup/download/' + t };
}
function takeTicket(t) { const v = TICKETS.get(String(t)); TICKETS.delete(String(t)); return v && v.exp > Date.now() ? path.join(DIR, v.name) : null; }
function jobStatus(id) { return jobOut(JOBS.get(String(id))); }
// สำรองอัตโนมัติ (cron)
function autoBackup() { if (JOB && JOB.state === 'running') return; try { startBackup('ระบบ (อัตโนมัติ)', 'auto', ''); } catch (e) { console.error('auto backup', e.message); } }
// ล้างงานค้างจากการรีสตาร์ทกลางคัน
(async () => { await rmrf(WORK); await rmrf(path.join(STORAGE, '.restore-new')); try { for (const n of await fsp.readdir(DIR)) if (n.endsWith('.part')) await fsp.unlink(path.join(DIR, n)); } catch (e) {} })();

module.exports = { startScheduler, backupSaveSchedule, nextRun, cleanSched, maint, backupOverview, backupCreate, backupRestore, backupDelete, backupTicket, takeTicket, jobStatus, autoBackup, DIR };
