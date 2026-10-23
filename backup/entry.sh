#!/bin/sh
# ตั้งเวลาสำรองอัตโนมัติ (ค่าเริ่มต้นทุกวัน 02:30 น.) แล้วรอทำงาน
CRON="${BACKUP_ALL_CRON:-30 2 * * *}"
mkdir -p /etc/crontabs
echo "$CRON /bin/sh /backup/backup.sh > /proc/1/fd/1 2>&1" > /etc/crontabs/root
echo "[backup] ตั้งเวลาสำรองข้อมูล: $CRON (เวลาไทย) · ปลายทาง: ${RCLONE_REMOTE:-เฉพาะในเครื่อง} · สั่งสำรองทันที: docker compose exec backup sh /backup/backup.sh"
exec crond -f -l 8
