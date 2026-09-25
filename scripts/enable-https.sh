#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [ -z "$DOMAIN" ]; then
  echo "Использование: ./scripts/enable-https.sh example.ru [email@example.ru]"
  exit 1
fi

cd "$(dirname "$0")/.."
mkdir -p nginx/certbot nginx/extra

if ! command -v certbot >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y certbot
fi

docker compose up -d nginx

if [ -n "$EMAIL" ]; then
  EMAIL_ARGS=(-m "$EMAIL")
else
  EMAIL_ARGS=(--register-unsafely-without-email)
fi

sudo certbot certonly --webroot -w "$PWD/nginx/certbot" -d "$DOMAIN" \
  --agree-tos --non-interactive "${EMAIL_ARGS[@]}" \
  --deploy-hook "docker exec effective-business-nginx nginx -s reload"

cat > nginx/extra/https.conf <<EOF
server {
    listen 443 ssl;
    http2 on;
    server_name ${DOMAIN};
    client_max_body_size 8m;

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://miniapp;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }
}
EOF

if grep -q '^MINI_APP_URL=' .env; then
  sed -i "s|^MINI_APP_URL=.*|MINI_APP_URL=https://${DOMAIN}|" .env
else
  echo "MINI_APP_URL=https://${DOMAIN}" >> .env
fi

docker compose up -d
docker exec effective-business-nginx nginx -s reload

echo "Готово: https://${DOMAIN}"
echo "Укажите этот адрес мини-приложения в настройках бота в MAX."
