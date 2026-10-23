FROM node:22-bookworm-slim

# Chromium สำหรับสร้าง PDF + ฟอนต์ไทย (สำรองกรณีโหลด Sarabun จาก Google Fonts ไม่ได้)
# base image เป็น -slim จึงต้องติดตั้งไลบรารีที่ Chromium ต้องใช้ตอนรันให้ครบ ไม่งั้นจะ "Failed to launch the browser process!"
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-thai-tlwg fonts-noto-core fonts-liberation \
      libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
      libgbm1 libasound2 libatspi2.0-0 libxshmfence1 libpango-1.0-0 libcairo2 \
      libx11-6 libxcb1 libxext6 libxi6 libexpat1 libglib2.0-0 \
      tzdata ca-certificates \
 && fc-cache -f \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Asia/Bangkok \
    CHROMIUM_PATH=/usr/bin/chromium \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PORT=3000 \
    STORAGE_DIR=/app/Storage

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY . .
RUN mkdir -p /app/Storage /app/Backups/full && chown -R node:node /app && chmod +x /app/docker-entrypoint.sh
# เริ่มเป็น root เพื่อปรับสิทธิ์โฟลเดอร์ Storage แล้ว entrypoint สลับไปรันแอปด้วยผู้ใช้ node
ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
