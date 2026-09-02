#!/usr/bin/env bash
set -euo pipefail
ARCHIVE="${1:-/tmp/backend-deploy.tgz}"
id remote-api >/dev/null 2>&1 || useradd --system --home /var/lib/universal-remote-api --shell /usr/sbin/nologin remote-api
mkdir -p /opt/universal-remote-api /var/lib/universal-remote-api
tar -xzf "$ARCHIVE" -C /opt/universal-remote-api
chown -R remote-api:remote-api /opt/universal-remote-api /var/lib/universal-remote-api
sudo -u remote-api env npm_config_cache=/tmp/remote-api-npm npm --prefix /opt/universal-remote-api ci
sudo -u remote-api npm --prefix /opt/universal-remote-api run build
sudo -u remote-api npm --prefix /opt/universal-remote-api prune --omit=dev
if [[ -f /etc/universal-remote-api.env ]]; then
  echo "Preservando /etc/universal-remote-api.env existente"
else
  admin_password="$(openssl rand -base64 18)"
  jwt_secret="$(openssl rand -hex 32)"
  cat > /etc/universal-remote-api.env <<EOF
PORT=3000
HOST=127.0.0.1
JWT_SECRET=$jwt_secret
ADMIN_PASSWORD=$admin_password
CORS_ORIGINS=http://localhost:4200,https://app-btv.vercel.app
DEVICE_HOST=btv-sogra
ADB_PORT=5555
DATABASE_PATH=/var/lib/universal-remote-api/app.db
EOF
  printf '%s\n' "$admin_password" > /home/ubuntu/INITIAL_ADMIN_PASSWORD
  chown ubuntu:ubuntu /home/ubuntu/INITIAL_ADMIN_PASSWORD
  chmod 600 /home/ubuntu/INITIAL_ADMIN_PASSWORD
fi
cp /opt/universal-remote-api/deploy/universal-remote-api.service /etc/systemd/system/universal-remote-api.service
systemctl daemon-reload
systemctl enable --now universal-remote-api
rm -f "$ARCHIVE"
curl -fsS http://127.0.0.1:3000/health
