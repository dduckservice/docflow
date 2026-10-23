// ============================================================
//  hub.js — ส่งแจ้งเตือนแบบทันที (Server-Sent Events) ไปยังหน้าเว็บที่เปิดอยู่
//  GET /api/chat/stream?token=...  → เชื่อมค้างไว้ เซิร์ฟเวอร์ส่ง event เมื่อมีข้อความแชทใหม่
// ============================================================
const clients = new Set();   // { uid, sup, res }
function add(uid, sup, res) { const c = { uid: String(uid), sup: !!sup, res }; clients.add(c); return () => clients.delete(c); }
function write(c, data) { try { c.res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch (e) { clients.delete(c); } }
function toUser(uid, data) { for (const c of clients) if (c.uid === String(uid)) write(c, data); }
function toAll(data) { for (const c of clients) write(c, data); }
function toSupers(data) { for (const c of clients) if (c.sup) write(c, data); }
// ส่งสัญญาณกันการเชื่อมต่อหลุด (proxy บางตัวตัดเมื่อเงียบนาน)
setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (e) { clients.delete(c); } } }, 25000).unref();
function onlineIds() { return new Set([...clients].map(c => c.uid)); }
module.exports = { sockets: () => [...clients].map(c => c.res), add, toUser, toSupers, toAll, onlineIds, count: () => clients.size };
