FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js db.js photo.js phone.js egrul.js esia.js miniapp-server.js disable-tls.js match-flow.js staff-flow.js data.example.json ./
COPY miniapp ./miniapp

RUN mkdir -p /app/miniapp/uploads \
  && cp /app/data.example.json /app/data.json

ENV MINI_APP_PORT=8080
EXPOSE 8080

CMD ["node", "bot.js"]
