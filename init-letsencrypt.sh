#!/usr/bin/env bash
# One-time bootstrap: nginx won't start without a cert, and certbot can't
# issue one until nginx is up to serve the challenge. Fakes a cert, starts
# nginx, swaps in the real one. Not needed again unless the domain changes.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo ".env not found. Copy .env.example to .env and set DOMAIN and EMAIL first." >&2
  exit 1
fi
set -a; source .env; set +a
: "${DOMAIN:?Set DOMAIN in .env}"
: "${EMAIL:?Set EMAIL in .env}"
staging="${STAGING:-0}"

echo "### Creating a dummy certificate for $DOMAIN so nginx can start..."
docker compose run --rm --entrypoint "\
  mkdir -p /etc/letsencrypt/live/$DOMAIN" certbot
docker compose run --rm --entrypoint "\
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout '/etc/letsencrypt/live/$DOMAIN/privkey.pem' \
    -out '/etc/letsencrypt/live/$DOMAIN/fullchain.pem' \
    -subj '/CN=localhost'" certbot

echo "### Starting nginx..."
docker compose up -d nginx

echo "### Deleting dummy certificate..."
docker compose run --rm --entrypoint "\
  rm -rf /etc/letsencrypt/live/$DOMAIN \
         /etc/letsencrypt/archive/$DOMAIN \
         /etc/letsencrypt/renewal/$DOMAIN.conf" certbot

echo "### Requesting the real certificate from Let's Encrypt..."
staging_arg=""
if [ "$staging" != "0" ]; then staging_arg="--staging"; fi
docker compose run --rm --entrypoint "\
  certbot certonly --webroot -w /var/www/certbot \
    $staging_arg \
    --email $EMAIL -d $DOMAIN \
    --rsa-key-size 2048 --agree-tos --no-eff-email --force-renewal" certbot

echo "### Reloading nginx with the real certificate..."
docker compose exec nginx nginx -s reload

echo "Done. Start the app + renewal loop with: docker compose up -d"
echo "https://$DOMAIN should now be live."
