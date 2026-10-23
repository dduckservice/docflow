#!/bin/sh
# ============================================================
#  กู้คืน DocFlow ทั้งระบบจากชุดสำรอง (ใช้บนเครื่องใหม่หรือเครื่องเดิม)
#  วิธีใช้ (ในโฟลเดอร์ docflow):
#    sh scripts/restore-all.sh <ไฟล์ docflow-YYYY-MM-DD_HHMM.tar.gz> [โฟลเดอร์ Storage ที่สำรองไว้]
#  ตัวอย่าง: sh scripts/restore-all.sh Backups/daily/docflow-2026-10-22_0230.tar.gz Backups/Storage
#  ** ข้อมูลในฐานข้อมูลปัจจุบันจะถูกแทนที่ทั้งหมด **
# ============================================================
set -e
cd "$(dirname "$0")/.."
ARCH="$1"; SRC_STORAGE="$2"
[ -f "$ARCH" ] || { echo "ไม่พบไฟล์สำรอง: $ARCH"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
tar -xzf "$ARCH" -C "$TMP"
if [ ! -f .env ] && [ -f "$TMP/env.txt" ]; then cp "$TMP/env.txt" .env; echo "คืนค่า .env จากชุดสำรอง"; fi
get() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' | tr -d '\r'; }
U=$(get POSTGRES_USER); U=${U:-docflow}; D=$(get POSTGRES_DB); D=${D:-docflow}
printf "จะกู้คืนฐานข้อมูล %s จาก %s (ข้อมูลปัจจุบันจะถูกแทนที่) พิมพ์ yes เพื่อยืนยัน: " "$D" "$ARCH"; read ans
[ "$ans" = "yes" ] || { echo "ยกเลิก"; exit 1; }
docker compose stop app >/dev/null 2>&1 || true
docker compose up -d db >/dev/null
i=0; until docker compose exec -T db pg_isready -q >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo 'ฐานข้อมูลไม่พร้อม'; exit 1; }; sleep 1; done
docker compose exec -T db pg_restore -U "$U" -d "$D" --clean --if-exists --no-owner < "$TMP/database.dump"
echo "กู้คืนฐานข้อมูลแล้ว"
if [ -n "$SRC_STORAGE" ] && [ -d "$SRC_STORAGE" ]; then mkdir -p Storage; cp -R "$SRC_STORAGE"/. Storage/; echo "คัดลอกไฟล์ Storage แล้ว"; fi
docker compose up -d --build
echo "เสร็จแล้ว เปิดระบบได้ตามปกติ"
