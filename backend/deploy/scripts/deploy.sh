#!/usr/bin/env bash
# ARTHVEX Mail release: install, migrate, restart API+worker, verify health (systemd).
# Safe by default: requires CONFIRM_DEPLOY=yes, takes a database backup first, and does NOT modify
# Apache, firewall, DNS or the mail server configuration.
#
# For a PM2 host use deploy/scripts/deploy-pm2.sh instead.
# Usage: CONFIRM_DEPLOY=yes ./deploy/scripts/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/arthvex}"
ENV_FILE="${ENV_FILE:-/etc/arthvex/backend.env}"
APP_USER="${APP_USER:-arthvex}"

if [[ "${CONFIRM_DEPLOY:-no}" != "yes" ]]; then
  echo "Refusing to deploy without CONFIRM_DEPLOY=yes." >&2
  exit 1
fi
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (systemctl and file ownership)." >&2
  exit 1
fi
if [[ ! -r "$ENV_FILE" ]]; then
  echo "Missing env file $ENV_FILE" >&2
  exit 1
fi
if [[ ! -d "$APP_DIR/backend" || ! -d "$APP_DIR/frontend" ]]; then
  echo "$APP_DIR must contain backend/ and frontend/." >&2
  exit 1
fi

echo "Deploying to $APP_DIR ($(uname -m))"
# Export the real environment so npm scripts and tsx see it (an existing env var wins over .env).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

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

echo "==> Restarting services"
systemctl restart arthvex-api.service
systemctl restart arthvex-worker.service
sleep 3

chown -R "$APP_USER:$APP_USER" "$APP_DIR/frontend/dist" "$APP_DIR/backend/var"

echo "==> Health verification"
ENV_FILE="$ENV_FILE" "$APP_DIR/backend/deploy/scripts/healthcheck.sh"

echo "Deployment finished. Rollback: restore the pre-deploy backup and check out the previous release"
echo "then rerun migrations only after reviewing docs/backup-restore.md."
