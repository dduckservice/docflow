// ส่งอีเมล (แทน MailApp) — ตั้งค่า SMTP_URL เช่น smtps://user:app-password@smtp.gmail.com:465 และ MAIL_FROM
// ถ้าไม่ได้ตั้งค่า ระบบจะเขียนลง log แทนการส่งจริง
const nodemailer = require('nodemailer');
let tx = null;
async function sendMail(to, subject, text) {
  if (!process.env.SMTP_URL) { console.log('[mail:disabled]', to, subject); return false; }
  if (!tx) tx = nodemailer.createTransport(process.env.SMTP_URL);
  await tx.sendMail({ from: process.env.MAIL_FROM || 'DocFlow <no-reply@localhost>', to, subject, text });
  return true;
}
module.exports = { sendMail };
