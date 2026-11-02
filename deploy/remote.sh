#!/usr/bin/env bash
# Runs on the host, from deploy.sh. Touches only tuichess files: /opt/tuichess, /var/lib/tuichess,
# /var/www/tuichess.dev, /var/www/tuichess-acme, /etc/nginx/sites-*/tuichess-*, tuichess.service.
set -euo pipefail
PERRY_VERSION="0.5.1664"
PUBLIC_IP="84.32.98.163"
# The host's Let's Encrypt account (it has two; most sites renew with this one).
ACME_ACCOUNT="6946352564a3d9f778db4b351fbb27b8"
BUILD=/opt/tuichess/build
PERRY_DIR=/opt/tuichess/perry
cd "$BUILD"

# A private Perry, so the host's global /usr/bin/perry stays as other services expect it.
if [ "$("$PERRY_DIR/perry" --version 2>/dev/null || true)" != "perry $PERRY_VERSION" ]; then
  echo "Installing Perry $PERRY_VERSION into $PERRY_DIR..."
  rm -rf "$PERRY_DIR" && mkdir -p "$PERRY_DIR"
  base="https://github.com/PerryTS/perry/releases/download/v$PERRY_VERSION/perry-linux-x86_64.tar.gz"
  curl -fsSL -o /tmp/perry.tgz "$base"
  expected="$(curl -fsSL "$base.sha256" | awk '{print $1}')"
  echo "$expected  /tmp/perry.tgz" | sha256sum -c -
  tar xzf /tmp/perry.tgz -C "$PERRY_DIR" && rm /tmp/perry.tgz
fi

echo "Building the server with Perry..."
PERRY_RUNTIME_DIR="$PERRY_DIR" "$PERRY_DIR/perry" compile server/src/main.ts -o chess-server \
  --strict-eval --strict-dynamic-import --strict-unimplemented 2>&1 | grep -E "^(Wrote|Binary size|error|Error)" || true
test -x chess-server
CHESS_SERVER=./chess-server timeout 300 node tests/server.ts

id tuichess >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/tuichess --no-create-home tuichess
mkdir -p /opt/tuichess/bin
install -m 0755 chess-server /opt/tuichess/bin/chess-server.new
mv /opt/tuichess/bin/chess-server.new /opt/tuichess/bin/chess-server
install -m 0644 deploy/tuichess.service /etc/systemd/system/tuichess.service
systemctl daemon-reload
systemctl enable --quiet tuichess
systemctl restart tuichess
for _ in 1 2 3 4 5 6 7 8 9 10; do curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:8787/health >/dev/null && echo "Server running (pid $(systemctl show -p MainPID --value tuichess), Perry $PERRY_VERSION native)"

echo "Installing the site..."
mkdir -p /var/www/tuichess.dev /var/www/tuichess-acme
cp -r site/. /var/www/tuichess.dev/
chmod -R a+rX /var/www/tuichess.dev

resolves() { # every name resolves to this host
  for name in "$@"; do
    [ "$(dig +short A "$name" @1.1.1.1 | tail -1)" = "$PUBLIC_IP" ] || { echo "  $name does not resolve to $PUBLIC_IP yet"; return 1; }
  done
}
enable() { ln -sf "/etc/nginx/sites-available/$1" "/etc/nginx/sites-enabled/$1"; }
reload_nginx() { nginx -t -q && systemctl reload nginx; }

install -m 0644 deploy/nginx/tuichess-http.conf deploy/nginx/tuichess-com.conf deploy/nginx/tuichess-dev.conf /etc/nginx/sites-available/
enable tuichess-http.conf
reload_nginx

certificate() { # name, then every domain on it
  local cert="$1"; shift
  if [ ! -d "/etc/letsencrypt/live/$cert" ]; then
    if resolves "$@"; then
      # The host's own renewal run holds certbot's lock for a while; wait for it.
      for _ in $(seq 1 120); do pgrep -f "bin/certbot" >/dev/null || break; sleep 5; done
      args=(); for d in "$@"; do args+=(-d "$d"); done
      certbot certonly --webroot -w /var/www/tuichess-acme --cert-name "$cert" "${args[@]}" \
        --account "$ACME_ACCOUNT" --non-interactive --agree-tos --keep-until-expiring --deploy-hook "systemctl reload nginx"
    fi
  fi
  [ -d "/etc/letsencrypt/live/$cert" ]
}

if certificate tuichess.com tuichess.com www.tuichess.com; then enable tuichess-com.conf; echo "https://tuichess.com: on"; else echo "https://tuichess.com: waiting for DNS"; fi
if certificate tuichess.dev tuichess.dev www.tuichess.dev api.tuichess.dev; then enable tuichess-dev.conf; echo "https://tuichess.dev: on"; else echo "https://tuichess.dev: waiting for DNS"; fi
reload_nginx
echo "Done."
