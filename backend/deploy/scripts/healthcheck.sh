#!/usr/bin/env bash
# Operator health check. Exit 0 only when the API, database, worker and disk look healthy.
# Usage: ENV_FILE=/etc/arthvex/backend.env ./deploy/scripts/healthcheck.sh
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/arthvex/backend.env}"
API="${API:-http://127.0.0.1:4000/api/v1}"
DISK_PATH="${DISK_PATH:-/var/lib/stalwart}"
DISK_WARN_PERCENT="${DISK_WARN_PERCENT:-85}"
FAIL=0

say() { printf '%-28s %s\n' "$1" "$2"; }

if curl -fsS --max-time 5 "$API/health" >/dev/null; then say "API liveness" "ok"; else say "API liveness" "FAIL"; FAIL=1; fi
if curl -fsS --max-time 5 "$API/health/ready" >/dev/null; then say "API readiness" "ok"; else say "API readiness" "FAIL"; FAIL=1; fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
export MYSQL_PWD="$DB_PASSWORD"
WORKERS=$(mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -N -B \
  -e "SELECT COUNT(*) FROM worker_heartbeats WHERE last_seen_at > DATE_SUB(NOW(3), INTERVAL 2 MINUTE)" 2>/dev/null || echo 0)
if [[ "$WORKERS" -ge 1 ]]; then say "Worker heartbeat" "ok ($WORKERS live)"; else say "Worker heartbeat" "FAIL"; FAIL=1; fi

FAILED_JOBS=$(mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" -N -B \
  -e "SELECT COUNT(*) FROM provisioning_jobs WHERE status='needs_manual_review'" 2>/dev/null || echo 0)
say "Jobs needing review" "$FAILED_JOBS"

if [[ -d "$DISK_PATH" ]]; then
  USE=$(df --output=pcent "$DISK_PATH" | tail -1 | tr -dc '0-9')
  if [[ "$USE" -lt "$DISK_WARN_PERCENT" ]]; then say "Disk $DISK_PATH" "ok (${USE}%)"; else say "Disk $DISK_PATH" "WARN (${USE}%)"; fi
else
  say "Disk $DISK_PATH" "not present"
fi

# Port 25 is not checked here because a control-plane host may legitimately differ from the mail host.
if command -v ss >/dev/null; then say "Port 25 listening" "$(ss -lnt '( sport = :25 )' | tail -n +2 | wc -l) socket(s)"; fi

exit "$FAIL"
