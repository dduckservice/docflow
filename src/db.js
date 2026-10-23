// การเชื่อมต่อ PostgreSQL + ตัวช่วยอ่าน/เขียนแบบเดียวกับ table_/writeRecord_ เดิม
// - ชื่อคอลัมน์ในฐานข้อมูลเป็น snake_case ส่วนในโค้ด/หน้าเว็บเป็น camelCase (แปลงให้อัตโนมัติ)
// - ค่าว่าง '' ตอนเขียน = NULL, ค่า NULL ตอนอ่าน = '' (ให้หน้าเว็บเดิมทำงานได้เหมือนตอนใช้ Google Sheets)
const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');
const { uuid } = require('./util');

types.setTypeParser(1700, v => (v === null ? null : parseFloat(v)));   // numeric → number
types.setTypeParser(20, v => (v === null ? null : parseInt(v, 10)));    // int8 → number
types.setTypeParser(1082, v => v);                                      // date → 'YYYY-MM-DD'

const pool = new Pool({
  // ใช้ DATABASE_URL ถ้ามี ไม่งั้นใช้ค่าแยกช่อง (รองรับรหัสผ่านที่มีอักขระพิเศษ เช่น @ โดยไม่ต้องเข้ารหัส URL)
  ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
    host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'docflow', password: process.env.PGPASSWORD || 'docflow', database: process.env.PGDATABASE || 'docflow' }),
  max: Number(process.env.PG_POOL_MAX || 10),
  // กันระบบค้าง: รอเชื่อมต่อไม่เกิน 15 วิ · คำสั่ง SQL เดียวไม่เกิน 60 วิ · transaction ที่ค้างเฉย ๆ ถูกตัดใน 2 นาที (ปลดล็อกบริษัทให้เอง)
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT || 15000),
  idleTimeoutMillis: 30000,
  statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT || 60000),
  idle_in_transaction_session_timeout: Number(process.env.PG_IDLE_TX_TIMEOUT || 120000),
  ssl: /^(1|true|require)$/i.test(process.env.PG_SSL || '') ? { rejectUnauthorized: false } : undefined
});

// การเชื่อมต่อที่ว่างอยู่หลุด (เช่น รีสตาร์ทฐานข้อมูล) → ไม่ให้ทั้งแอปล่ม pool จะเปิดการเชื่อมต่อใหม่เอง
pool.on('error', e => console.error('PostgreSQL pool error:', e.message));

const camel = s => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const snake = s => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
function mapRow(r) {
  if (!r) return r;
  const o = {};
  for (const k of Object.keys(r)) { const v = r[k]; o[camel(k)] = v === null ? '' : v; }
  return o;
}

let COLS = null;   // { table: Set(columns) }
async function loadColumns() {
  const { rows } = await pool.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`);
  COLS = {};
  rows.forEach(r => { (COLS[r.table_name] = COLS[r.table_name] || new Set()).add(r.column_name); });
}
async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
  await loadColumns();
}

function toDbValue(v) {
  if (v === '' || v === undefined) return null;
  if (v instanceof Date || Buffer.isBuffer(v) || typeof v === 'boolean' || typeof v === 'number' || v === null) return v;
  return String(v);
}
function pickCols(table, obj) {
  const cols = COLS[table];
  if (!cols) throw new Error('ไม่รู้จักตาราง ' + table);
  const out = [];
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    const c = snake(k);
    if (cols.has(c)) out.push([c, toDbValue(obj[k])]);
  }
  return out;
}

// ctx ต่อ 1 คำขอ: ใช้ client เดียว (อยู่ใน transaction) + ผู้ใช้ + บริษัทที่เลือก
function makeCtx(client) {
  const ctx = {
    db: client, user: null, tenantId: '',
    async all(sql, params) { const r = await client.query(sql, params || []); return r.rows.map(mapRow); },
    async one(sql, params) { const r = await client.query(sql, params || []); return r.rows.length ? mapRow(r.rows[0]) : null; },
    async exec(sql, params) { return client.query(sql, params || []); },
    async insert(table, obj) {
      obj = Object.assign({}, obj);
      if (COLS[table].has('tenant_id') && !obj.tenantId && ctx.tenantId) obj.tenantId = ctx.tenantId;
      if (COLS[table].has('id') && !obj.id && table !== 'audit_log' && table !== 'pdf_backups') obj.id = uuid();
      const kv = pickCols(table, obj);
      await client.query(`INSERT INTO ${table} (${kv.map(x => x[0]).join(',')}) VALUES (${kv.map((_, i) => '$' + (i + 1)).join(',')})`, kv.map(x => x[1]));
      return obj;
    },
    async insertMany(table, objs) { for (const o of objs) await ctx.insert(table, o); },
    async update(table, id, obj) {
      const kv = pickCols(table, obj).filter(x => x[0] !== 'id' && x[0] !== 'tenant_id');
      if (!kv.length) return;
      const params = kv.map(x => x[1]); params.push(id);
      let where = `id = $${params.length}`;
      if (COLS[table].has('tenant_id') && ctx.tenantId) { params.push(ctx.tenantId); where += ` AND tenant_id = $${params.length}`; }
      await client.query(`UPDATE ${table} SET ${kv.map((x, i) => x[0] + ' = $' + (i + 1)).join(', ')} WHERE ${where}`, params);
    },
    // บันทึกประวัติ (เดิม: แท็บ AuditLog)
    async log(documentId, action, detail) {
      await client.query('INSERT INTO audit_log (tenant_id, document_id, action, detail, username) VALUES ($1,$2,$3,$4,$5)',
        [ctx.tenantId || null, String(documentId), action, String(detail || '').slice(0, 2000), ctx.username()]);
    },
    username() { return ctx.user && ctx.user.username ? String(ctx.user.username) : ''; },
    // ล็อกต่อบริษัท (แทน LockService เดิม) — คงอยู่จนจบ transaction
    async lock(key) { await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(key || 'global')]); },
    // งานที่ต้องทำหลังบันทึกสำเร็จ (เช่น แจ้งเตือนแชทแบบทันที)
    _after: [], afterCommit(fn) { ctx._after.push(fn); }
  };
  return ctx;
}

// รันงาน 1 ชุดใน transaction เดียว
async function withCtx(fn) {
  let client;
  try { client = await pool.connect(); }
  catch (e) { throw new Error('ระบบฐานข้อมูลไม่ว่างหรือเชื่อมต่อไม่ได้ กรุณาลองใหม่อีกครั้ง'); }
  try {
    await client.query('BEGIN');
    const ctx = makeCtx(client);
    const out = await fn(ctx);
    await client.query('COMMIT');
    for (const f of ctx._after) { try { f(); } catch (e) { console.warn('afterCommit:', e.message); } }
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

async function getSetting(ctx, key) { const r = await ctx.one('SELECT value FROM app_settings WHERE key = $1', [key]); return r ? String(r.value) : ''; }
async function setSetting(ctx, key, value) {
  await ctx.exec('INSERT INTO app_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(value == null ? '' : value)]);
}

module.exports = { pool, migrate, withCtx, makeCtx, mapRow, camel, snake, getSetting, setSetting };
