#!/bin/sh
# ============================================================
#  แก้ปัญหา "password authentication failed" ของ PostgreSQL
#  ทำให้ผู้ใช้/รหัสผ่าน/ฐานข้อมูลใน Postgres ตรงกับไฟล์ .env โดยไม่ลบข้อมูลเดิม
#  วิธีใช้ (ในโฟลเดอร์โปรเจกต์):  sh scripts/fix-db-login.sh
# ============================================================
set -e
cd "$(dirname "$0")/.."

get() { grep -E "^$1=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" | tr -d '\r'; }
U=$(get POSTGRES_USER);     U=${U:-docflow}
P=$(get POSTGRES_PASSWORD); P=${P:-docflow}
D=$(get POSTGRES_DB);       D=${D:-docflow}
echo "ค่าจาก .env → ผู้ใช้: $U | ฐานข้อมูล: $D"

docker compose up -d db >/dev/null
printf 'รอฐานข้อมูลพร้อม'
i=0; until docker compose exec -T db pg_isready -q >/dev/null 2>&1; do i=$((i+1)); [ $i -gt 60 ] && { echo ' หมดเวลา'; exit 1; }; printf '.'; sleep 1; done; echo ' พร้อม'

# หาบัญชีผู้ดูแลที่มีอยู่จริงในฐานข้อมูล (ภายในคอนเทนเนอร์เข้าได้โดยไม่ต้องใช้รหัสผ่าน)
ADMIN=""
for r in "$U" docflow postgres; do
  if docker compose exec -T db psql -U "$r" -d postgres -tAc 'select 1' >/dev/null 2>&1; then ADMIN=$r; break; fi
done
[ -z "$ADMIN" ] && { echo 'ไม่พบบัญชีผู้ดูแลในฐานข้อมูล — ถ้ายังไม่มีข้อมูลสำคัญ ให้รัน: docker compose down -v && docker compose up -d'; exit 1; }
echo "เชื่อมต่อด้วยบัญชี: $ADMIN"

docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U "$ADMIN" -d postgres -v u="$U" -v p="$P" -v d="$D" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN SUPERUSER', :'u') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN SUPERUSER PASSWORD %L', :'u', :'p') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'d', :'u') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'d') \gexec
SQL

echo "ตั้งรหัสผ่านของ $U ให้ตรงกับ .env แล้ว — กำลังเริ่มแอปใหม่"
docker compose up -d
echo "เสร็จแล้ว: เข้า Adminer ด้วย Server=db, Username=$U, Database=$D และรหัสผ่านใน .env"
