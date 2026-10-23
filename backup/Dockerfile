# ตัวสำรองข้อมูลอัตโนมัติ: pg_dump (ฐานข้อมูล) + rclone (ส่งขึ้น Google Drive / ที่เก็บอื่น)
FROM postgres:16-alpine
RUN apk add --no-cache rclone tzdata
ENV TZ=Asia/Bangkok
COPY backup.sh entry.sh /backup/
CMD ["/bin/sh", "/backup/entry.sh"]
