// scripts/secret-scan.js — เฝ้ารัง (CI guard): ห้ามมีไฟล์ความลับ/ข้อมูลผู้ใช้ถูก commit เข้า git อีก (Security Review C1)
// ทำงานแบบ dependency-free: รวบลิสต์ไฟล์จาก git แล้วตรวจชื่อ+content-pattern ต้องผ่านจึง deploy ได้
const { execFileSync } = require('child_process');
const path = require('path');

// 1) ชื่อไฟล์ต้องห้าม (ข้อมูลผู้ใช้/backup/.env ต้องไม่มีในรีโปเด็ดขาด — anchor ที่ root เท่านั้น ตัวพิมพ์ใหญ่-เล็กสำคัญ: src/storage/ ไม่เกี่ยวกับ Storage/)
const FORBIDDEN_PATH = /^\.env$/i;
const FORBIDDEN_DATA = /^Storage\/|^Backups\/|\.tar$|\.tar\.gz$|\.json\.gz$|Thumbs\.db$|^backup\/rclone\.conf$/;
// (ยกเว้นที่ซ่อนตามปกติถ้าจำเป็น — ต้องเพิ่มโดยเจ้าของผ่านการรีวิวเท่านั้น)
const ALLOW = new Set([path.join('backup', 'rclone.conf.example')]);

// 2) pattern ความลับในตัวไฟล์ที่ควรตรวจพบ (พบเมื่อไหร่ fail เสมอ ยกเว้นเป็นตัวอย่างใน env.example)
const SECRET_PATTERNS = [
  { re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, why: 'private key' },
  { re: /glpat-[A-Za-z0-9_-]{20}/, why: 'GitLab PAT' },
  { re: /github_pat_[A-Za-z0-9_]{40,}/, why: 'GitHub fine-grained PAT' },
  { re: /ghp_[A-Za-z0-9]{36}/, why: 'GitHub classic PAT' },
  { re: /gho_[A-Za-z0-9]{36}/, why: 'GitHub OAuth token' },
  { re: /sk-[A-Za-z0-9]{32,}/, why: 'OpenAI-style key' },
  { re: /AKIA[0-9A-Z]{16}/, why: 'AWS access key' },
  { re: /xox[baprs]-[0-9A-Za-z-]{10,}/, why: 'Slack token' },
  { re: /smtp:\/\/\S+:[^\s@"']{@/i, why: 'SMTP URL ที่ฝังรหัสผ่าน' },
  { re: /^POSTGRES_PASSWORD=(?!\s*$|change-me|your-|<)[^\s]+$/m, why: 'POSTGRES_PASSWORD เป็นค่าจริง (ไม่ใช่ placeholder)' },
  { re: /^TOKEN_SECRET=[0-9a-f]{64,}$/mi, why: 'TOKEN_SECRET ค่าจริงถูก commit' },
  { re: /^CLOUDFLARE_TUNNEL_TOKEN=(?!\s*$)[A-Za-z0-9_=-]{20,}$/mi, why: 'Cloudflare tunnel token จริง' },
  { re: /^TELEGRAM_BOT_TOKEN=\d{6,10}:A[A-Za-z0-9_-]{30,}$/m, why: 'Telegram bot token จริง' },
  { re: /^BACKUP_PASSPHRASE=(?!\s*$|<)[^\s]+$/mi, why: 'BACKUP_PASSPHRASE ค่าจริงถูก commit' },
  { re: /^BOOTSTRAP_ADMIN_KEY=(?!\s*$|<)[^\s]+$/mi, why: 'BOOTSTRAP_ADMIN_KEY ค่าจริงถูก commit' }
];

let files;
try { files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }).split('\0').filter(Boolean); }
catch (e) { console.error('secret-scan: เรียก git ls-files ไม่ได้ →', e.message); process.exit(2); }

const problems = [];
const SKIP_CONTENT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz|tar|mp4|webm)$/i;
for (const f of files) {
  if (ALLOW.has(f)) continue;
  if (FORBIDDEN_PATH.test(f) && !/example|\.template$/i.test(f)) { problems.push('ไฟล์ต้องห้ามติดใน git: ' + f + ' (ต้อง git rm --cached + เขียน .gitignore)'); continue; }
  if (FORBIDDEN_DATA.test(f)) { problems.push('ไฟล์ข้อมูลผู้ใช้/backup ติดใน git: ' + f); continue; }
  if (SKIP_CONTENT.test(f)) continue;
  let content; try { content = execFileSync('git', ['show', 'HEAD:' + f], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }); } catch (e) { try { content = require('fs').readFileSync(f, 'utf8'); } catch (_) { continue; } }
  if (/^# *nosecret-scan$/m.test(content)) continue;   //  escape hatch ต้อง explicit เท่านั้น
  for (const { re, why } of SECRET_PATTERNS) {
    if (re.test(content)) { problems.push(why + ' พบใน: ' + f); break; }
  }
}
if (problems.length) { console.error('❌ secret-scan พบปัญหา:\n' + problems.map(p => ' - ' + p).join('\n')); process.exit(1); }
console.log('✓ secret-scan ผ่าน (' + files.length + ' ไฟล์ที่ track อยู่)');
