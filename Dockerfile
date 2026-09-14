FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
EXPOSE 3000

# Railway/Renderでは Start Command を上書きして
#   Web用:  node src/server.js
#   Cron用: node src/cron.js
# のように使い分ける。
CMD ["node", "src/server.js"]
