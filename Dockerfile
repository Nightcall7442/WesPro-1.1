# Деплой бильярдной системы на хостинг (Railway/Render/VPS).
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# База на подключённом диске хостинга (переживает redeploy):
# создайте volume и смонтируйте его в /data.
ENV BILLIARDS_DATABASE_PATH=/data/billiards.db
RUN mkdir -p /data

EXPOSE 8000
CMD ["node", "src/server.js"]
