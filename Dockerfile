FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt \
    -o /usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
  && curl -fsSL https://gu-st.ru/content/lending/russian_trusted_sub_ca_pem.crt \
    -o /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt \
  && update-ca-certificates \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bot.js db.js cities.js photo.js phone.js egrul.js esia.js miniapp-server.js disable-tls.js match-flow.js staff-flow.js ./
COPY miniapp ./miniapp

RUN mkdir -p /app/miniapp/uploads /app/data

ENV DATA_FILE=/app/data/data.json
ENV MINI_APP_PORT=8080
EXPOSE 8080

CMD ["node", "bot.js"]
