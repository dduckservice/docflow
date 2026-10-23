require('dotenv').config();
const { migrate, withCtx, pool } = require('../src/db');
module.exports = async function run(fn) {
  try { await migrate(); const r = await withCtx(fn); if (r !== undefined) console.log(r); await pool.end(); }
  catch (e) { console.error('ผิดพลาด:', e.message); process.exit(1); }
};
