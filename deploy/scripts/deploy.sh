#!/usr/bin/env bash
# ARTHVEX Mail release: install, migrate, restart API+worker, verify health.
# Safe by default: requires CONFIRM_DEPLOY=yes, takes a database backup first, and does NOT modify
# Apache, firewall, DNS or the mail server configuration.
#
# Usage: CONFIRM_DEPLOY=yes ./deploy/scripts/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/arthvex}"
ENV_FILE="${ENV_FILE:-/etc/arthvex/backend.env}"
PHP_USER="${APP_USER:-arthvex}"

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
CPU_ARCH="$(uname -m)"
echo "Deploying to $APP_DIR on $CPU_ARCH"

cd "$APP_DIR"
echo "==> Installing locked dependencies"
npm ci --omit=dev=false

echo "==> Building frontend"
npm run build

echo "==> Typecheck and tests (refuse to deploy broken code)"
npm run typecheck
npm test
npm run test:web

echo "==> Backing up before migration"
ENV_FILE="$ENV_FILE" ./deploy/scripts/backup.sh

echo "==> Applying database migrations"
npm run db:migrate

echo "==> Restarting services"
systemctl restart arthvex-api.service
systemctl restart arthvex-worker.service
sleep 3

chown -R "$PHP_USER:$PHP_USER" "$APP_DIR/frontend/dist" "$APP_DIR/backend/var"

echo "==> Health verification"
ENV_FILE="$ENV_FILE" ./deploy/scripts/healthcheck.sh

echo "Deployment finished. Rollback: restore the pre-deploy backup and check out the previous release"
echo "then rerun migrations only after reviewing docs/backup-restore.md."
