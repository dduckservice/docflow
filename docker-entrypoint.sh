#!/bin/sh
# เตรียมโฟลเดอร์ Storage ให้ผู้ใช้ node เขียนได้ (โฟลเดอร์ที่ mount จากเครื่องมักเป็นของ root) แล้วรันแอปด้วยผู้ใช้ node
set -e
DIR="${STORAGE_DIR:-/app/Storage}"
BK="${BACKUP_DIR:-/app/Backups}"
mkdir -p "$DIR" "$BK/full"
if [ "$(id -u)" = "0" ]; then
  find "$DIR" ! -user node -exec chown node:node {} + 2>/dev/null || true
  chown node:node "$BK" "$BK/full" 2>/dev/null || true
  find "$BK/full" ! -user node -exec chown node:node {} + 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
