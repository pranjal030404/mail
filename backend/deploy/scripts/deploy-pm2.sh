#!/usr/bin/env bash
# ARTHVEX Mail release on a PM2 host (no Docker, no systemd units).
# Run as the deployment user that owns the PM2 process list (e.g. `arthvex`), NOT as root.
#
# Usage:
#   CONFIRM_DEPLOY=yes APP_DIR=/srv/arthvex ENV_FILE=/etc/arthvex/backend.env ./deploy/scripts/deploy-pm2.sh
#
# What it does: install, build the SPA, typecheck/test, back up the database, migrate, reload PM2,
# verify health. It does not touch Apache/nginx, the firewall, DNS or Stalwart.
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/arthvex}"
ENV_FILE="${ENV_FILE:-/etc/arthvex/backend.env}"

if [[ "${CONFIRM_DEPLOY:-no}" != "yes" ]]; then
  echo "Refusing to deploy without CONFIRM_DEPLOY=yes." >&2
  exit 1
fi
if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run as the PM2 owner (for example: sudo -u arthvex -H ...), not as root." >&2
  exit 1
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "pm2 is not installed or not in PATH. Install it with: npm i -g pm2" >&2
  exit 1
fi
if [[ ! -r "$ENV_FILE" ]]; then
  echo "Cannot read $ENV_FILE" >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/ecosystem.config.cjs" ]]; then
  echo "Missing $APP_DIR/ecosystem.config.cjs" >&2
  exit 1
fi

echo "Deploying $APP_DIR with PM2 ($(uname -m))"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
export ENV_FILE

echo "==> Installing locked backend dependencies"
cd "$APP_DIR/backend"
npm ci

echo "==> Installing frontend dependencies and building"
cd "$APP_DIR/frontend"
npm ci
npm run build

echo "==> Typecheck and tests (refuse to deploy broken code)"
npm run typecheck
npm test

cd "$APP_DIR/backend"
npm run typecheck
npm test

echo "==> Backing up before migration"
ENV_FILE="$ENV_FILE" "$APP_DIR/backend/deploy/scripts/backup.sh"

echo "==> Applying database migrations"
npm run db:migrate

echo "==> Reloading PM2 processes"
cd "$APP_DIR"
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

echo "==> Health verification"
ENV_FILE="$ENV_FILE" "$APP_DIR/backend/deploy/scripts/healthcheck.sh"

echo "Deployment finished. Check logs with: pm2 logs arthvex-api"
