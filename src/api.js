// ============================================================
//  api.js — จุดเข้าเดียวของ JSON API (เดิม: apiTable_() + api() ใน Platfrom.gs)
//  [ฟังก์ชัน, สิทธิ์ขั้นต่ำ, ต้องเลือกบริษัท?]
// ============================================================
const { withCtx } = require('./db');
const P = require('./platform');
const D = require('./documents');
const M = require('./modules');
const U = require('./uploads');
const R = require('./reports');
const PR = require('./print');
const TR = require('./trash');
const CH = require('./chat');
const MO = require('./monitor');
const AN = require('./announce');
const FB = require('./fullbackup');
const DR = require('./delreq');
const CX = require('./coexport');
const UP = require('./upgrade');

const ping = async () => ({ ok: true });
// [ฟังก์ชัน, สิทธิ์ขั้นต่ำ, ต้องเลือกบริษัท?, ใช้ได้แม้ License หมดอายุ?]
const TABLE = {
  getSession: [P.getSession, 'viewer', false, true],
  ping: [ping, 'viewer', false, true],
  redeemLicenseKey: [P.redeemLicenseKey, 'viewer', false, true],
  // แชทติดต่อเจ้าหน้าที่
  chatMine: [CH.chatMine, 'viewer', false, true],
  chatPoll: [CH.chatPoll, 'viewer', false, true],
  chatSend: [CH.chatSend, 'viewer', false, true],
  chatUnread: [CH.chatUnread, 'viewer', false, true],
  chatFile: [CH.chatFile, 'viewer', false, true],
  monitorUsers: [MO.monitorUsers, 'audit', false],
  backupOverview: [FB.backupOverview, 'super', false],
  backupCreate: [FB.backupCreate, 'super', false],
  backupRestore: [FB.backupRestore, 'super', false],
  backupDelete: [FB.backupDelete, 'super', false],
  backupTicket: [FB.backupTicket, 'super', false],
  backupSaveSchedule: [FB.backupSaveSchedule, 'super', false],
  exportCompany: [CX.exportCompany, 'audit', false],
  listCompanyExports: [CX.listCompanyExports, 'audit', false],
  exportTicket: [CX.exportTicket, 'audit', false, true],
  setMyAvatar: [require('./platform').setMyAvatar, 'viewer', false, true],
  requestDeleteTenant: [DR.requestDeleteTenant, 'audit', false],
  myDeleteRequests: [DR.myDeleteRequests, 'audit', false],
  cancelDeleteRequest: [DR.cancelDeleteRequest, 'audit', false],
  listDeleteRequests: [DR.listDeleteRequests, 'super', false],
  decideDeleteRequest: [DR.decideDeleteRequest, 'super', false],
  requestUpgrade: [UP.requestUpgrade, 'audit', false],
  myUpgradeRequests: [UP.myUpgradeRequests, 'audit', false],
  cancelUpgradeRequest: [UP.cancelUpgradeRequest, 'audit', false],
  listUpgradeRequests: [UP.listUpgradeRequests, 'super', false],
  decideUpgradeRequest: [UP.decideUpgradeRequest, 'super', false],
  telegramStatus: [require('./telegram').telegramStatus, 'super', false],
  announceActive: [AN.announceActive, 'viewer', false, true],
  announceRead: [AN.announceRead, 'viewer', false, true],
  announceList: [AN.announceList, 'super', false],
  announceSave: [AN.announceSave, 'super', false],
  announceStop: [AN.announceStop, 'super', false],
  announceDelete: [AN.announceDelete, 'super', false],
  chatInbox: [CH.chatInbox, 'super', false],
  chatThread: [CH.chatThread, 'super', false],
  chatReply: [CH.chatReply, 'super', false],
  chatSetStatus: [CH.chatSetStatus, 'super', false],
  chatDeleteMessage: [CH.chatDeleteMessage, 'super', false],
  changeMyPassword: [P.changeMyPassword, 'admin', false],
  listLicenses: [P.listLicenses, 'super', false],
  saveLicense: [P.saveLicense, 'super', false],
  renewLicense: [P.renewLicense, 'super', false],
  saveContactInfo: [P.saveContactInfo, 'super', false],
  saveSignupSettings: [P.saveSignupSettings, 'super', false],
  createLicenseKey: [P.createLicenseKey, 'super', false],
  listLicenseKeys: [P.listLicenseKeys, 'super', false],
  revokeLicenseKey: [P.revokeLicenseKey, 'super', false],
  deleteLicenseKey: [P.deleteLicenseKey, 'super', false],
  sendLicenseNotices: [P.sendLicenseNotices, 'super', false],
  listTrash: [TR.listTrash, 'audit', false],
  restoreTrash: [TR.restoreTrash, 'audit', false],
  deleteTrashItem: [TR.deleteTrashItem, 'audit', false],
  listDocuments: [D.listDocuments, 'viewer', true],
  getDocument: [D.getDocument, 'viewer', true],
  getDocHistory: [D.getDocHistory, 'viewer', true],
  getCompanySettings: [D.getCompanySettings, 'viewer', true],
  getLogoPreview: [D.getLogoPreview, 'viewer', true],
  getPrintHtml: [PR.getPrintHtml, 'viewer', true],
  createPdf: [PR.createPdf, 'viewer', true],
  getSummary: [D.getSummary, 'viewer', true],
  uploadMeta: [U.uploadMeta, 'viewer', true],
  listUploads: [U.listUploads, 'viewer', true],
  getUpload: [U.getUpload, 'viewer', true],
  getUploadFile: [U.getUploadFile, 'viewer', true],
  uploadFile: [U.uploadFile, 'staff', true],
  updateUpload: [U.updateUpload, 'staff', true],
  deleteUpload: [U.deleteUpload, 'audit', true],
  getIncomeReport: [R.getIncomeReport, 'viewer', false],
  getDashboardData: [R.getDashboardData, 'viewer', false],
  saveDocument: [D.saveDocument, 'staff', true],
  convertDocument: [D.convertDocument, 'staff', true],
  deleteDocument: [D.deleteDocument, 'audit', true],
  saveCompanySettings: [D.saveCompanySettings, 'audit', true],
  createTenant: [P.createTenant, 'audit', false],
  deleteTenant: [P.deleteTenant, 'super', false],
  listCompanies: [P.listCompanies, 'audit', false],
  companyQuotaInfo: [P.companyQuotaInfo, 'audit', false],
  listUsers: [P.listUsers, 'audit', false],
  saveUser: [P.saveUser, 'audit', false],
  setUserQuota: [P.setUserQuota, 'super', false],
  setCompanyQuota: [P.setCompanyQuota, 'super', false],
  deleteUser: [P.deleteUser, 'audit', false],
  listContacts: [M.listContacts, 'viewer', true],
  saveContact: [M.saveContact, 'staff', true],
  deleteContact: [M.deleteContact, 'audit', true],
  importContactsFromDocs: [M.importContactsFromDocs, 'staff', true],
  listProducts: [M.listProducts, 'viewer', true],
  saveProduct: [M.saveProduct, 'staff', true],
  deleteProduct: [M.deleteProduct, 'audit', true],
  listExpenses: [M.listExpenses, 'viewer', true],
  saveExpense: [M.saveExpense, 'staff', true],
  deleteExpense: [M.deleteExpense, 'audit', true],
  getExpense: [M.getExpense, 'viewer', true],
  setExpenseStatus: [M.setExpenseStatus, 'staff', true],
  listExpenseCategories: [M.listExpenseCategories, 'viewer', true],
  saveExpenseCategory: [M.saveExpenseCategory, 'staff', true],
  deleteExpenseCategory: [M.deleteExpenseCategory, 'audit', true],
  listPurchaseDocs: [M.listPurchaseDocs, 'viewer', true],
  getPurchaseDoc: [M.getPurchaseDoc, 'viewer', true],
  savePurchaseDoc: [M.savePurchaseDoc, 'staff', true],
  convertPurchase: [M.convertPurchase, 'staff', true],
  deletePurchaseDoc: [M.deletePurchaseDoc, 'audit', true]
};
// ฟังก์ชันที่เรียกได้โดยไม่ต้องล็อกอิน
const PUBLIC = { authStatus: P.authStatus, signup: P.signup, login: P.login, createFirstAdmin: P.createFirstAdmin, activateLicense: P.activateLicense };

const MAINT_MSG = 'ระบบกำลังกู้คืนข้อมูล กรุณารอสักครู่แล้วลองใหม่';
const SEEN = new Map();   // บันทึก last_seen ไม่เกินนาทีละครั้งต่อผู้ใช้
async function callApi(token, tenantId, fn, args, meta) {
  const def = Object.prototype.hasOwnProperty.call(TABLE, fn) ? TABLE[fn] : null;
  if (!def) throw new Error('ไม่อนุญาตให้เรียกฟังก์ชันนี้');
  if (FB.maint()) throw new Error(MAINT_MSG);
  const out = await callApiTx(def, token, tenantId, args, meta);
  // งานช้าที่ไม่ใช้ฐานข้อมูล (เช่น สร้าง PDF ด้วย Chromium) ทำหลังปิด transaction แล้ว → ไม่ถือการเชื่อมต่อ/ล็อกค้างไว้
  return out && typeof out.__defer === 'function' ? out.__defer() : out;
}
function callApiTx(def, token, tenantId, args, meta) {
  return withCtx(async ctx => {
    await P.initSecret(ctx);
    const a = await P.authUser(ctx, token);
    if (!a.user) throw new Error(a.why === 'replaced' ? 'SESSION_REPLACED' : 'SESSION_EXPIRED');
    const user = a.user;
    // fail-closed: role ที่ไม่รู้จัก = สิทธิ์ 0
    if ((P.ROLE_RANK[String(user.role)] || 0) < (def[1] === 'super' ? P.ROLE_RANK.admin : (P.ROLE_RANK[def[1]] || 99))) throw new Error('ไม่มีสิทธิ์ทำรายการนี้');
    const lic = P.licenseOf(user, await P.isSuper(ctx, user));
    if (lic.state === 'expired' && !def[3]) throw new Error('LICENSE_EXPIRED: ' + P.licMsg(lic));
    ctx.user = user; ctx.meta = meta || {};
    const uid = String(user.id), now = Date.now();
    if (now - (SEEN.get(uid) || 0) > 60000) {
      SEEN.set(uid, now);
      await ctx.exec('UPDATE users SET last_seen = now(), last_ip = $2, last_agent = $3 WHERE id = $1', [user.id, String(ctx.meta.ip || '').slice(0, 80) || null, String(ctx.meta.agent || '').slice(0, 300) || null]);
    }
    if (def[1] === 'super') await P.superOnly(ctx);
    if (def[2]) await P.setTenant(ctx, tenantId);
    return def[0](ctx, ...(Array.isArray(args) ? args : []));
  });
}
async function callPublic(fn, args, meta) {
  const f = Object.prototype.hasOwnProperty.call(PUBLIC, fn) ? PUBLIC[fn] : null;
  if (!f) throw new Error('ไม่อนุญาตให้เรียกฟังก์ชันนี้');
  if (FB.maint()) throw new Error(MAINT_MSG);
  meta = meta || {};
  try {
    return await withCtx(async ctx => { ctx.meta = meta; await P.initSecret(ctx); return f(ctx, ...(Array.isArray(args) ? args : [])); });
  } catch (e) {
    if (fn === 'login') {   // บันทึกการเข้าสู่ระบบไม่สำเร็จ (นอก transaction ที่ถูกยกเลิก)
      const un = String((args || [])[0] || '').trim().toLowerCase().slice(0, 100);
      withCtx(ctx => ctx.exec('INSERT INTO login_events (user_id, username, ok, ip, agent, note) VALUES ((SELECT id FROM users WHERE lower(username) = $1 OR (lower(email) = $1 AND length(email) > 0) ORDER BY (lower(username) = $1) DESC LIMIT 1), $1, false, $2, $3, $4)',
        [un, String(meta.ip || '').slice(0, 80), String(meta.agent || '').slice(0, 300), String(e.message).slice(0, 120)])).catch(() => {});
    }
    throw e;
  }
}

module.exports = { callApi, callPublic, TABLE };
