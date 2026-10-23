// ============================================================
//  chat.js — แชทติดต่อเจ้าหน้าที่ (ผู้ใช้ ↔ Super Admin)
//  - ผู้ใช้ทุกคน (รวม License หมดอายุ) คุยในห้องของตัวเองได้ 1 ห้อง
//  - Super Admin เห็นทุกห้องในเมนู "กล่องข้อความ" ตอบ / แนบไฟล์ / เปลี่ยนสถานะ
//  - ไฟล์แนบเก็บที่ Storage / 04 ไฟล์แชท / [ชื่อผู้ใช้] / [yyyy-MM]
//  - ถ้าตั้ง SMTP ไว้: แจ้งอีเมลเมื่อมีข้อความใหม่ที่ยังไม่ได้อ่าน (ครั้งแรกของรอบ)
// ============================================================
const storage = require('./storage');
const { sendMail } = require('./mail');
const hub = require('./hub');
const { fail, uuid, clean, tsOut, partsOf, safeFolderName, thDate } = require('./util');

const MAX_FILE = Number(process.env.CHAT_MAX_MB || 5) * 1024 * 1024;
const MIMES = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const STATUS = ['open', 'answered', 'closed'];

const P = () => require('./platform');
async function superOnly(ctx) { await P().superOnly(ctx); }
async function amSuper(ctx) { return P().isSuper(ctx, ctx.user); }

function msgOut(m) {
  return { id: Number(m.id), from: m.senderRole, name: m.senderName || '', text: m.body || '', at: tsOut(m.createdAt), atIso: m.createdAt ? new Date(m.createdAt).toISOString() : '',
    file: m.fileId ? { name: m.fileName || 'file', mime: m.mimeType || '', size: m.size === '' ? 0 : Number(m.size) } : null };
}
async function threadOf(ctx, userId, create) {
  let t = await ctx.one('SELECT * FROM chat_threads WHERE user_id = $1', [userId]);
  if (!t && create) {
    await ctx.exec('INSERT INTO chat_threads (id, user_id, status) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING', [uuid(), userId, 'open']);
    t = await ctx.one('SELECT * FROM chat_threads WHERE user_id = $1', [userId]);
  }
  return t;
}
async function messages(ctx, threadId, afterId) {
  const rows = afterId ? await ctx.all('SELECT * FROM chat_messages WHERE thread_id = $1 AND id > $2 ORDER BY id', [threadId, Number(afterId) || 0])
    : await ctx.all('SELECT * FROM (SELECT * FROM chat_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 300) x ORDER BY id', [threadId]);
  return rows.map(msgOut);
}
// บันทึกไฟล์แนบ (base64) → { fileId, fileName, mimeType, size }
async function saveFile(ctx, owner, f) {
  if (!f || !f.base64) return {};
  const mime = String(f.mimeType || '').toLowerCase().replace('image/jpg', 'image/jpeg'), ext = MIMES[mime];
  if (!ext) fail('แนบได้เฉพาะรูปภาพ (PNG, JPG, WEBP, GIF) หรือ PDF');
  const b64 = String(f.base64).replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) fail('ข้อมูลไฟล์ไม่ถูกต้อง');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length || buf.length > MAX_FILE) fail('ไฟล์แนบต้องไม่เกิน ' + (MAX_FILE / 1048576) + ' MB');
  let name = safeFolderName(f.fileName, 'file');
  if (!new RegExp('\\.' + ext + '$', 'i').test(name)) name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.' + ext;
  const p = partsOf(), folder = await storage.path('chat', [safeFolderName(owner, 'user'), p.year + '-' + p.month]);
  name = await storage.uniqueName(folder, name, p.hour + p.minute + p.second);
  const r = await storage.put(folder, name, mime, buf);
  return { fileId: r.id, fileName: name, mimeType: mime, size: buf.length };
}
async function insertMsg(ctx, t, role, text, file) {
  const body = clean(text, 4000);
  if (!body && !file.fileId) fail('กรุณาพิมพ์ข้อความหรือแนบไฟล์');
  const r = await ctx.one(`INSERT INTO chat_messages (thread_id, sender_id, sender_name, sender_role, body, file_id, file_name, mime_type, size)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [t.id, ctx.user.id, String(ctx.user.displayName || ctx.user.username), role, body || null,
    file.fileId || null, file.fileName || null, file.mimeType || null, file.size || null]);
  const preview = (body || ('📎 ' + file.fileName)).slice(0, 120);
  if (role === 'user') {
    await ctx.exec("UPDATE chat_threads SET last_msg_at = now(), last_preview = $2, last_from = 'user', staff_unread = staff_unread + 1, status = 'open' WHERE id = $1", [t.id, preview]);
  } else {
    await ctx.exec("UPDATE chat_threads SET last_msg_at = now(), last_preview = $2, last_from = 'staff', user_unread = user_unread + 1, status = CASE WHEN status = 'closed' THEN 'closed' ELSE 'answered' END WHERE id = $1", [t.id, preview]);
  }
  return msgOut(r);
}
function notify(to, subject, text) { if (to) sendMail(String(to).trim(), subject, text).catch(e => console.warn('chat mail:', e.message)); }

// ---------- ฝั่งผู้ใช้ ----------
async function chatMine(ctx) {
  const t = await threadOf(ctx, ctx.user.id, false);
  if (!t) return { status: 'new', messages: [], unread: 0 };
  if (Number(t.userUnread)) await ctx.exec('UPDATE chat_threads SET user_unread = 0 WHERE id = $1', [t.id]);
  return { status: t.status, messages: await messages(ctx, t.id), unread: 0 };
}
async function chatPoll(ctx, afterId) {
  const t = await threadOf(ctx, ctx.user.id, false);
  if (!t) return { status: 'new', messages: [] };
  const m = await messages(ctx, t.id, afterId);
  if (m.length && Number(t.userUnread)) await ctx.exec('UPDATE chat_threads SET user_unread = 0 WHERE id = $1', [t.id]);
  return { status: t.status, messages: m };
}
async function chatSend(ctx, text, file) {
  if (await amSuper(ctx)) fail('Super Admin ตอบแชทได้ที่เมนู "กล่องข้อความ"');
  await ctx.lock('chat:' + ctx.user.id);
  const t = await threadOf(ctx, ctx.user.id, true);
  const first = Number(t.staffUnread) === 0;
  const f = await saveFile(ctx, ctx.user.username, file);
  const msg = await insertMsg(ctx, t, 'user', text, f);
  const uid = ctx.user.id, tid = t.id, who = String(ctx.user.displayName || ctx.user.username), pv = (msg.text || '📎 ' + (msg.file && msg.file.name)).slice(0, 80);
  const tgMsg = { text: msg.text, file: msg.file, fileId: f.fileId };
  ctx.afterCommit(() => { hub.toSupers({ type: 'chat', from: 'user', threadId: tid, name: who, preview: pv }); hub.toUser(uid, { type: 'chat', from: 'user', threadId: tid }); require('./telegram').notifyUserMessage(tid, uid, tgMsg); });
  if (first) {   // แจ้ง Super Admin ทางอีเมล (เฉพาะข้อความแรกที่ยังไม่ได้อ่าน)
    const sup = await P().superIdsPublic(ctx);
    for (const s of await ctx.all("SELECT email FROM users WHERE status = 'active' AND email IS NOT NULL AND id = ANY($1::uuid[])", [[...sup]]))
      notify(s.email, '[DocFlow] ข้อความใหม่จาก ' + ctx.user.username, (msg.text || '(ไฟล์แนบ)') + '\n\nตอบได้ที่เมนู "กล่องข้อความ" ในระบบ DocFlow');
  }
  return { message: msg };
}
async function chatUnread(ctx) {
  if (await amSuper(ctx)) {
    const r = await ctx.one('SELECT COALESCE(sum(staff_unread),0)::int AS n, count(*) FILTER (WHERE staff_unread > 0)::int AS t FROM chat_threads');
    return { unread: r.n, threads: r.t, staff: true };
  }
  const t = await threadOf(ctx, ctx.user.id, false);
  return { unread: t ? Number(t.userUnread) || 0 : 0, staff: false };
}
// เปิดไฟล์แนบ: เจ้าของห้อง หรือ Super Admin
async function chatFile(ctx, messageId) {
  const m = await ctx.one('SELECT m.*, t.user_id FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id WHERE m.id = $1', [Number(messageId) || 0]);
  if (!m || !m.fileId) fail('ไม่พบไฟล์');
  if (String(m.userId) !== String(ctx.user.id) && !(await amSuper(ctx))) fail('ไม่มีสิทธิ์เปิดไฟล์นี้');
  const buf = await storage.get(String(m.fileId));
  return { name: m.fileName, mimeType: m.mimeType, base64: buf.toString('base64') };
}

// ---------- ฝั่ง Super Admin ----------
async function chatInbox(ctx) {
  await superOnly(ctx);
  const rows = await ctx.all(`SELECT t.*, u.username, u.display_name, u.email, u.phone, u.role, u.status AS user_status, u.tenant_ids, u.license_plan, u.license_expire, u.license_note, u.avatar, u.avatar_mime
    FROM chat_threads t JOIN users u ON u.id = t.user_id ORDER BY (t.staff_unread > 0) DESC, t.last_msg_at DESC LIMIT 500`);
  const tenants = await ctx.all('SELECT id, company_name FROM tenants');
  const tn = id => (tenants.find(x => String(x.id) === id) || {}).companyName;
  return rows.map(r => {
    const lic = P().licenseOf(r, false);
    return { id: r.id, userId: String(r.userId), username: r.username, displayName: r.displayName || r.username, email: r.email || '', phone: r.phone || '', role: r.role,
      companies: String(r.tenantIds).trim() === '*' ? ['ทุกบริษัท'] : String(r.tenantIds || '').split(',').map(x => tn(x.trim())).filter(Boolean),
      avatar: P().avatarUrl(r), status: r.status, lastAt: tsOut(r.lastMsgAt), lastAtIso: new Date(r.lastMsgAt).toISOString(), preview: r.lastPreview || '', lastFrom: r.lastFrom || '', unread: Number(r.staffUnread) || 0,
      license: { state: lic.state, expire: lic.expire, daysLeft: lic.daysLeft, trial: /ทดลองใช้/.test(lic.note) } };
  });
}
async function inboxThread(ctx, id) {
  const t = await ctx.one('SELECT * FROM chat_threads WHERE id::text = $1', [String(id || '')]);
  if (!t) fail('ไม่พบห้องแชท');
  return t;
}
async function chatThread(ctx, id, afterId) {
  await superOnly(ctx);
  const t = await inboxThread(ctx, id);
  const m = await messages(ctx, t.id, afterId);
  if (Number(t.staffUnread)) await ctx.exec('UPDATE chat_threads SET staff_unread = 0 WHERE id = $1', [t.id]);
  return { status: t.status, messages: m };
}
async function chatReply(ctx, id, text, file) {
  await superOnly(ctx);
  await ctx.lock('chat:' + id);
  const t = await inboxThread(ctx, id);
  const u = await ctx.one('SELECT username, email FROM users WHERE id = $1', [t.userId]);
  const first = Number(t.userUnread) === 0;
  const f = await saveFile(ctx, u ? u.username : 'user', file);
  const msg = await insertMsg(ctx, t, 'staff', text, f);
  const uid2 = t.userId, tid2 = t.id, pv2 = (msg.text || '📎 ' + (msg.file && msg.file.name)).slice(0, 80);
  ctx.afterCommit(() => { hub.toUser(uid2, { type: 'chat', from: 'staff', threadId: tid2, preview: pv2 }); hub.toSupers({ type: 'chat', from: 'staff', threadId: tid2 }); });
  await ctx.exec('UPDATE chat_threads SET staff_unread = 0 WHERE id = $1', [t.id]);
  if (first && u) notify(u.email, '[DocFlow] เจ้าหน้าที่ตอบข้อความของคุณแล้ว', (msg.text || '(ไฟล์แนบ)') + '\n\nเปิดระบบ DocFlow แล้วกดปุ่ม 💬 เพื่อดูและตอบกลับ');
  return { message: msg };
}
async function chatSetStatus(ctx, id, status) {
  await superOnly(ctx);
  if (!STATUS.includes(status)) fail('สถานะไม่ถูกต้อง');
  const t = await inboxThread(ctx, id);
  await ctx.exec('UPDATE chat_threads SET status = $2 WHERE id = $1', [t.id, status]);
  const tid3 = t.id, uid3 = t.userId;
  ctx.afterCommit(() => { hub.toSupers({ type: 'status', threadId: tid3 }); hub.toUser(uid3, { type: 'status', threadId: tid3 }); });
  return { success: true };
}
// Super Admin ลบข้อความในแชทได้ (ลบไฟล์แนบด้วย) · อัปเดตตัวอย่างล่าสุดของห้อง
async function chatDeleteMessage(ctx, messageId) {
  await superOnly(ctx);
  const m = await ctx.one('SELECT * FROM chat_messages WHERE id = $1', [Number(messageId) || 0]);
  if (!m) fail('ไม่พบข้อความ');
  const tid = m.threadId, fid = m.fileId;
  await ctx.exec('DELETE FROM chat_messages WHERE id = $1', [m.id]);
  const last = await ctx.one('SELECT * FROM chat_messages WHERE thread_id = $1 ORDER BY id DESC LIMIT 1', [tid]);
  if (last) {
    const pv = (last.body || ('📎 ' + (last.fileName || 'file'))).slice(0, 80);
    await ctx.exec('UPDATE chat_threads SET last_msg_at = $2, last_preview = $3, last_from = $4 WHERE id = $1', [tid, last.createdAt, pv, last.senderRole]);
  } else {
    await ctx.exec("UPDATE chat_threads SET last_preview = '', last_from = '' WHERE id = $1", [tid]);
  }
  const t = await ctx.one('SELECT user_id FROM chat_threads WHERE id = $1', [tid]);
  const uid = t ? String(t.userId) : '';
  ctx.afterCommit(() => {
    if (fid) storage.purge(String(fid)).catch(() => {});
    hub.toSupers({ type: 'chat', from: 'staff', threadId: tid, deleted: String(messageId) });
    if (uid) hub.toUser(uid, { type: 'chat', from: 'staff', threadId: tid, deleted: String(messageId) });
  });
  return { success: true, id: String(messageId) };
}
// โพสต์ข้อความระบบเข้าห้องแชทของผู้ใช้ปัจจุบัน (ให้คำขอต่าง ๆ โผล่ในกล่องข้อความของ Super Admin)
async function postUserNote(ctx, text) {
  const uid = ctx.user.id, who = String(ctx.user.displayName || ctx.user.username);
  await ctx.lock('chat:' + uid);
  const t = await threadOf(ctx, uid, true);
  const msg = await insertMsg(ctx, t, 'user', text, {});
  const tid = t.id, pv = (msg.text || '').slice(0, 80);
  ctx.afterCommit(() => { hub.toSupers({ type: 'chat', from: 'user', threadId: tid, name: who, preview: pv }); hub.toUser(uid, { type: 'chat', from: 'user', threadId: tid }); });
  return msg;
}

module.exports = { chatMine, chatPoll, chatSend, chatUnread, chatFile, chatInbox, chatThread, chatReply, chatSetStatus, chatDeleteMessage, postUserNote };
