#!/bin/sh
# ============================================================
#  สำรองข้อมูล DocFlow ทั้งระบบ
#  1) ฐานข้อมูล (pg_dump) + .env + docker-compose.yml → ไฟล์เดียว daily/docflow-YYYY-MM-DD_HHMM.tar.gz
#  2) โฟลเดอร์ Storage → คัดลอกเฉพาะไฟล์ใหม่/ที่เปลี่ยน ไปที่ Storage/ (ไม่ลบไฟล์ที่ปลายทาง)
#  ปลายทาง: /backups (โฟลเดอร์ในเครื่อง) และ RCLONE_REMOTE (เช่น gdrive:DocFlow-Backup) ถ้าตั้งค่าไว้
#  เก็บรายวันย้อนหลัง BACKUP_KEEP_DAYS วัน (ค่าเริ่มต้น 30) + ชุดวันที่ 1 ของทุกเดือนไว้ 365 วัน
# ============================================================
set -e
STAMP=$(date +%Y-%m-%d_%H%M)
KEEP=${BACKUP_KEEP_DAYS:-30}
DEST=${BACKUP_DIR:-/backups}
STORAGE=${STORAGE_SRC:-/storage}
CONF=${CONFIG_DIR:-/config}
RCONF=${RCLONE_CONFIG_FILE:-/backup-config/rclone.conf}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "[backup] เริ่มสำรองข้อมูล $STAMP"

# 1) ฐานข้อมูล
PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h "${PGHOST:-db}" -p "${PGPORT:-5432}" -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > "$TMP/database.dump"
[ -f "$CONF/.env" ] && cp "$CONF/.env" "$TMP/env.txt" || true
[ -f "$CONF/docker-compose.yml" ] && cp "$CONF/docker-compose.yml" "$TMP/docker-compose.yml" || true
cat > "$TMP/README.txt" <<TXT
DocFlow backup $STAMP
- database.dump       ฐานข้อมูล (กู้คืนด้วย pg_restore หรือ scripts/restore-all.sh)
- env.txt             ไฟล์ .env (มีรหัสผ่าน เก็บให้ปลอดภัย)
- docker-compose.yml  ไฟล์ตั้งค่า Docker
ไฟล์ใน Storage อยู่ในโฟลเดอร์ Storage/ ข้างโฟลเดอร์ daily/
TXT
mkdir -p "$DEST/daily"
ARCH="$DEST/daily/docflow-$STAMP.tar.gz"
tar -czf "$ARCH" -C "$TMP" .
echo "[backup] ฐานข้อมูล → $ARCH ($(du -h "$ARCH" | cut -f1))"

# 2) Storage (ไม่รวม 03 สำรองข้อมูล ซึ่งเป็นสำรอง JSON ของระบบอยู่แล้ว)
mkdir -p "$DEST/Storage"
rclone copy "$STORAGE" "$DEST/Storage" --exclude "/03 สำรองข้อมูล/**" --exclude ".*" --log-level ERROR
echo "[backup] Storage → $DEST/Storage"

# 3) ลบชุดรายวันที่เก่าเกินกำหนด (เก็บชุดวันที่ 1 ของเดือนไว้ 365 วัน)
find "$DEST/daily" -name 'docflow-*.tar.gz' ! -name 'docflow-*-01_*' -mtime +"$KEEP" -delete 2>/dev/null || true
find "$DEST/daily" -name 'docflow-*.tar.gz' -mtime +365 -delete 2>/dev/null || true

# 4) ส่งขึ้นที่เก็บนอกเครื่อง (Google Drive ฯลฯ)
if [ -n "$RCLONE_REMOTE" ]; then
  if [ ! -f "$RCONF" ]; then echo "[backup] ไม่พบ $RCONF — ข้ามการส่งขึ้น $RCLONE_REMOTE"; exit 0; fi
  R="--config $RCONF --log-level ERROR"
  rclone copy "$ARCH" "$RCLONE_REMOTE/daily" $R
  rclone copy "$STORAGE" "$RCLONE_REMOTE/Storage" --exclude "/03 สำรองข้อมูล/**" --exclude ".*" $R
  rclone delete "$RCLONE_REMOTE/daily" --min-age "${KEEP}d" --exclude 'docflow-*-01_*' $R || true
  rclone delete "$RCLONE_REMOTE/daily" --min-age 365d $R || true
  echo "[backup] ส่งขึ้น $RCLONE_REMOTE แล้ว"
fi
echo "[backup] เสร็จ $STAMP"
