# Деплой бильярдной системы на хостинг (Railway/Render/VPS).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Базы на подключённом диске хостинга (переживают redeploy):
# создайте volume и смонтируйте его в /data. БЕЗ ЭТОГО ДАННЫЕ ПРОПАДУТ
# при каждом обновлении — файловая система контейнера временная.
ENV BILLIARDS_DATABASE_PATH=/data/billiards.db
# База центральной панели сети клубов (подписки и оплаты) — отдельный файл.
ENV WESPRO_HUB_DATABASE_PATH=/data/hub.db
# Базы клубов сети (по файлу на клуб) — тоже на диске, а не в контейнере.
# Работает только вместе с WESPRO_NETWORK=1; переменную ставят в панели
# хостинга, чтобы этот же образ годился и для установки на один клуб.
ENV WESPRO_CLUBS_DIR=/data/clubs
# Снимки баз офлайн-клубов и загруженный WesPro.exe — тоже на диске.
ENV WESPRO_MIRRORS_DIR=/data/mirrors
ENV WESPRO_DOWNLOADS_DIR=/data/downloads
RUN mkdir -p /data

EXPOSE 8000
CMD ["node", "src/server.js"]
