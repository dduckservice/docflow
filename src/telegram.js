// ============================================================
//  telegram.js — ผูกแชท DocFlow กับ Telegram Bot
//  - ผู้ใช้ส่งข้อความในแชท → Bot แจ้งเข้า Telegram ของ Super Admin (ข้อความ + รูป/PDF)
//  - กด Reply ที่ข้อความนั้นใน Telegram → คำตอบเข้าแชทของผู้ใช้ในระบบทันที (ส่งรูป/PDF ตอบได้)
//  - คำสั่ง: /start หรือ /id (ดู chat ID) · /list (ห้องที่รอตอบ) · ตอบ /close (ปิดเรื่อง) · /help
//  ใช้ long polling (getUpdates) → ไม่ต้องเปิดพอร์ตหรือตั้ง webhook
//  ตั้งค่าใน .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS (คั่นด้วย , รับคำสั่งเฉพาะ chat เหล่านี้), TELEGRAM_REPLY_AS (ไม่บังคับ)
// ============================================================
const { pool, withCtx } = require('./db');
const storage = require('./storage');
const P = () => require('./platform');
const CH = () => require('./chat');

const TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = String(process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '');
const ALLOWED = new Set(String(process.env.TELEGRAM_CHAT_IDS || '').split(/[,\s]+/).map(x => x.trim()).filter(Boolean));
const MIMES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };
const STATE = { enabled: !!TOKEN, ok: false, bot: '', chats: ALLOWED.size, lastError: '', lastOk: '' };
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, body, opts) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const r = await fetch(`${API}/bot${TOKEN}/${method}`, { method: 'POST', body: isForm ? body : JSON.stringify(body || {}),
    headers: isForm ? undefined : { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout((opts && opts.timeout) || 20000) });
  const j = await r.json().catch(() => ({ ok: false, description: 'HTTP ' + r.status }));
  if (!j.ok) { const e = new Error(j.description || 'Telegram error'); e.code = j.error_code; throw e; }
  return j.result;
}
const send = (chatId, text, extra) => tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) });

// ---------- จับคู่ข้อความ Telegram ↔ ห้องแชท ----------
async function link(chatId, messageId, threadId) {
  await pool.query('INSERT INTO telegram_links (chat_id, message_id, thread_id) VALUES ($1,$2,$3) ON CONFLICT (chat_id, message_id) DO UPDATE SET thread_id = EXCLUDED.thread_id', [String(chatId), Number(messageId), threadId]);
}
async function threadFor(chatId, messageId) {
  const r = await pool.query('SELECT thread_id FROM telegram_links WHERE chat_id = $1 AND message_id = $2', [String(chatId), Number(messageId)]);
  return r.rows[0] ? String(r.rows[0].thread_id) : null;
}
async function userInfo(userId) {
  const u = (await pool.query('SELECT username, display_name, tenant_ids FROM users WHERE id = $1', [userId])).rows[0] || {};
  let companies = '';
  if (String(u.tenant_ids || '').trim() === '*') companies = 'ทุกบริษัท';
  else if (u.tenant_ids) {
    const ids = String(u.tenant_ids).split(',').map(x => x.trim()).filter(Boolean);
    if (ids.length) companies = (await pool.query('SELECT company_name FROM tenants WHERE id::text = ANY($1)', [ids])).rows.map(r => r.company_name).join(', ');
  }
  return { username: u.username || '', name: u.display_name || u.username || 'ผู้ใช้', companies };
}

// ---------- แจ้งเตือนข้อความจากผู้ใช้ (เรียกจาก chat.js หลังบันทึกแล้ว) ----------
function notifyUserMessage(threadId, userId, msg) {
  if (!TOKEN || !ALLOWED.size) return;
  (async () => {
    const u = await userInfo(userId);
    const head = `💬 <b>${esc(u.name)}</b>${u.username && u.username !== u.name ? ' (' + esc(u.username) + ')' : ''}${u.companies ? '\n🏢 ' + esc(u.companies) : ''}`;
    const body = msg.text ? '\n\n' + esc(msg.text) : '';
    const foot = '\n\n<i>↩️ กด Reply ที่ข้อความนี้เพื่อตอบกลับ</i>';
    let file = null;
    if (msg.file && msg.fileId) { try { file = { buf: await storage.get(String(msg.fileId)), name: msg.file.name, mime: msg.file.mime }; } catch (e) { file = null; } }
    for (const chatId of ALLOWED) {
      try {
        let r;
        if (file) {
          const fd = new FormData(); fd.append('chat_id', chatId); fd.append('parse_mode', 'HTML');
          fd.append('caption', (head + body).slice(0, 900) + foot);
          const isImg = /^image\/(png|jpeg|webp)$/.test(file.mime);
          fd.append(isImg ? 'photo' : 'document', new Blob([file.buf], { type: file.mime }), file.name);
          r = await tg(isImg ? 'sendPhoto' : 'sendDocument', fd, { timeout: 60000 });
        } else r = await send(chatId, (head + body).slice(0, 3900) + foot);
        await link(chatId, r.message_id, threadId);
        STATE.lastOk = new Date().toISOString();
      } catch (e) { STATE.lastError = 'ส่งแจ้งเตือนไม่สำเร็จ: ' + e.message; console.warn('telegram notify:', e.message); }
    }
  })().catch(e => console.warn('telegram notify:', e.message));
}

// ข้อความแจ้งเตือนทั่วไปถึง Super Admin (เช่น คำขอลบบริษัท)
function notifyText(html) {
  if (!TOKEN || !ALLOWED.size) return;
  for (const chatId of ALLOWED) send(chatId, String(html).slice(0, 3900)).catch(e => { STATE.lastError = 'ส่งแจ้งเตือนไม่สำเร็จ: ' + e.message; });
}
// ---------- รับคำสั่ง / คำตอบจาก Telegram ----------
async function replyUser() {
  const want = String(process.env.TELEGRAM_REPLY_AS || '').trim().toLowerCase();
  return withCtx(async ctx => {
    const sup = [...await P().superIdsPublic(ctx)];
    const users = (await ctx.all("SELECT * FROM users WHERE status = 'active' AND id = ANY($1::uuid[]) ORDER BY created_at NULLS LAST, username", [sup]));
    return users.find(u => want && String(u.username).toLowerCase() === want) || users[0] || null;
  });
}
async function asStaff(fn) {
  const u = await replyUser();
  if (!u) throw new Error('ไม่พบบัญชี Super Admin ที่ใช้งานอยู่');
  return withCtx(async ctx => { ctx.user = u; ctx.meta = { ip: 'telegram', agent: 'Telegram Bot' }; await P().initSecret(ctx); return fn(ctx); });
}
async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await fetch(`${API}/file/bot${TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('ดาวน์โหลดไฟล์จาก Telegram ไม่ได้');
  return Buffer.from(await r.arrayBuffer());
}
async function listWaiting(chatId) {
  const rows = (await pool.query(`SELECT t.id, t.user_id, t.last_preview, t.staff_unread, t.status FROM chat_threads t
      WHERE t.status = 'open' ORDER BY t.last_msg_at DESC LIMIT 10`)).rows;
  if (!rows.length) return send(chatId, '✅ ไม่มีห้องแชทที่รอตอบ');
  await send(chatId, `📋 ห้องแชทที่รอตอบ ${rows.length} ห้อง (กด Reply ที่ข้อความด้านล่างเพื่อตอบ)`);
  for (const t of rows) {
    const u = await userInfo(t.user_id);
    const r = await send(chatId, `💬 <b>${esc(u.name)}</b>${u.companies ? ' · ' + esc(u.companies) : ''}${Number(t.staff_unread) ? ' · ยังไม่อ่าน ' + t.staff_unread : ''}\n${esc(t.last_preview || '')}`);
    await link(chatId, r.message_id, t.id);
  }
}
const HELP = '🤖 <b>DocFlow Bot</b>\n\n• ข้อความจากลูกค้าจะเด้งเข้ามาที่นี่\n• <b>กด Reply</b> ที่ข้อความของลูกค้า แล้วพิมพ์คำตอบ (ส่งรูปหรือ PDF ได้)\n• ตอบด้วย /close เพื่อปิดเรื่อง\n• /list ดูห้องแชทที่รอตอบ\n• /id ดู chat ID';
async function handle(msg) {
  const chatId = String(msg.chat && msg.chat.id), text = String(msg.text || msg.caption || '').trim(), cmd = (text.match(/^\/(\w+)/) || [])[1];
  const allowed = ALLOWED.has(chatId);
  if (cmd === 'start' || cmd === 'id') {
    return send(chatId, allowed ? '✅ เชื่อมต่อกับ DocFlow แล้ว\n\n' + HELP
      : `🔐 chat ID ของคุณคือ <code>${esc(chatId)}</code>\n\nนำไปใส่ในไฟล์ .env ของ DocFlow:\n<code>TELEGRAM_CHAT_IDS=${esc(chatId)}</code>\nแล้วรัน <code>docker compose up -d</code> จากนั้นพิมพ์ /start อีกครั้ง`);
  }
  if (!allowed) return;   // คนอื่นที่ทักมา: ไม่ตอบอะไร
  if (cmd === 'help') return send(chatId, HELP);
  if (cmd === 'list') return listWaiting(chatId);
  const rt = msg.reply_to_message;
  if (!rt) return send(chatId, 'ℹ️ กด <b>Reply</b> (ตอบกลับ) ที่ข้อความของลูกค้าเพื่อตอบ หรือพิมพ์ /list ดูห้องที่รอตอบ');
  const threadId = await threadFor(chatId, rt.message_id);
  if (!threadId) return send(chatId, '⚠️ ไม่พบห้องแชทของข้อความนี้ (อาจเป็นข้อความเก่า) — พิมพ์ /list แล้ว Reply ที่ข้อความใหม่', { reply_to_message_id: msg.message_id });
  if (cmd === 'close') {
    await asStaff(ctx => CH().chatSetStatus(ctx, threadId, 'closed'));
    return send(chatId, '🔒 ปิดเรื่องแล้ว', { reply_to_message_id: msg.message_id });
  }
  let file = null;
  if (msg.photo && msg.photo.length) file = { fileName: 'telegram-' + msg.message_id + '.jpg', mimeType: 'image/jpeg', id: msg.photo[msg.photo.length - 1].file_id };
  else if (msg.document) {
    const mime = String(msg.document.mime_type || '').toLowerCase();
    if (!MIMES[mime]) return send(chatId, '⚠️ ส่งได้เฉพาะรูปภาพหรือ PDF', { reply_to_message_id: msg.message_id });
    file = { fileName: msg.document.file_name || ('telegram-' + msg.message_id + '.' + MIMES[mime]), mimeType: mime, id: msg.document.file_id };
  }
  if (!text && !file) return send(chatId, '⚠️ ส่งได้เฉพาะข้อความ รูปภาพ หรือ PDF', { reply_to_message_id: msg.message_id });
  if (file) file = { fileName: file.fileName, mimeType: file.mimeType, base64: (await downloadFile(file.id)).toString('base64') };
  const r = await asStaff(ctx => CH().chatReply(ctx, threadId, text, file));
  const u = await userInfo((await pool.query('SELECT user_id FROM chat_threads WHERE id = $1', [threadId])).rows[0].user_id);
  const ok = await send(chatId, `✅ ส่งถึง <b>${esc(u.name)}</b> แล้ว`, { reply_to_message_id: msg.message_id });
  await link(chatId, msg.message_id, threadId); await link(chatId, ok.message_id, threadId);   // Reply ต่อที่ข้อความไหนในห้องเดียวกันก็ได้
  return r;
}

let RUNNING = false;
async function loop() {
  let offset = 0, wait = 3000;
  try { await tg('deleteWebhook', { drop_pending_updates: false }); } catch (e) {}
  while (RUNNING) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] }, { timeout: 65000 });
      STATE.ok = true; STATE.lastError = ''; wait = 3000;
      for (const u of ups) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message).catch(e => {
          const ref = Date.now().toString(36).slice(-6).toUpperCase();
          console.warn('telegram handle [ERR ' + ref + ']:', e && e.stack || e);
          send(String(u.message.chat.id), '⚠️ ดำเนินการไม่สำเร็จชั่วคราว (รหัสอ้างอิง ' + ref + ') กรุณาลองใหม่').catch(() => {});
        });
      }
    } catch (e) {
      STATE.ok = false;
      STATE.lastError = e.code === 409 ? 'Bot นี้ถูกเชื่อมต่อจากเครื่องอื่นอยู่ (ใช้ token เดียวกันได้ทีละเครื่อง)' : e.code === 401 ? 'Bot Token ไม่ถูกต้อง' : 'เชื่อมต่อ Telegram ไม่ได้: ' + e.message;
      console.warn('telegram:', STATE.lastError);
      await sleep(wait); wait = Math.min(wait * 2, 60000);
    }
  }
}
async function start() {
  if (!TOKEN || RUNNING) return;
  RUNNING = true;
  try { const me = await tg('getMe', {}); STATE.bot = me.username || ''; STATE.ok = true; console.log('Telegram bot @' + STATE.bot + (ALLOWED.size ? ' · แจ้งเตือน ' + ALLOWED.size + ' แชท' : ' · ยังไม่ได้ตั้ง TELEGRAM_CHAT_IDS (พิมพ์ /start ที่ Bot เพื่อดู chat ID)')); }
  catch (e) { STATE.lastError = e.code === 401 ? 'Bot Token ไม่ถูกต้อง' : 'เชื่อมต่อ Telegram ไม่ได้: ' + e.message; console.warn('telegram:', STATE.lastError); }
  loop();
}
function stop() { RUNNING = false; }
async function telegramStatus(ctx) { return { ...STATE }; }
module.exports = { start, stop, notifyText, notifyUserMessage, telegramStatus, handle };
