#!/usr/bin/env bash
# Restore test: loads the newest MySQL dump into a separate schema, verifies key tables, then
# clears ONLY that schema and records the result. Never touches DB_NAME.
#
# The application database user normally has no CREATE/DROP DATABASE privilege. Either:
#   1. pre-create the restore schema once and grant the app user access to it:
#        CREATE DATABASE arthvex_restore_test CHARACTER SET utf8mb4;
#        GRANT ALL PRIVILEGES ON arthvex_restore_test.* TO 'arthvex_app'@'127.0.0.1';
#   2. or grant CREATE/DROP on `arthvex_restore_test` only.
#
# Usage: sudo -u arthvex ./deploy/scripts/restore-test.sh
# Optional: RESTORE_DB=arthvex_restore_test
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/arthvex/backend.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/arthvex}"
RESTORE_DB="${RESTORE_DB:-arthvex_restore_test}"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# backup_runs.started_at is DATETIME; the ISO-8601 form with T/Z is rejected by MySQL.
STARTED_SQL="$(date -u +'%Y-%m-%d %H:%M:%S')"
T0=$(date +%s)

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${DB_HOST:?}" "${DB_PORT:?}" "${DB_USER:?}" "${DB_PASSWORD:?}" "${DB_NAME:?}"
export MYSQL_PWD="$DB_PASSWORD"

if [[ "$RESTORE_DB" == "$DB_NAME" ]]; then
  echo "Refusing to restore over the live database ($DB_NAME)." >&2
  exit 1
fi

LATEST="$(find "$BACKUP_DIR" -maxdepth 1 -name 'arthvex-db-*.sql.gz' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -1 | cut -d' ' -f2-)"
if [[ -z "$LATEST" ]]; then
  echo "No database dump found in $BACKUP_DIR" >&2
  exit 1
fi
if ! gzip -t "$LATEST"; then
  echo "Dump $LATEST is not a valid gzip archive." >&2
  exit 1
fi
echo "Verifying $LATEST"

MYSQL=(mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER")

if ! "${MYSQL[@]}" -e "CREATE DATABASE IF NOT EXISTS \`$RESTORE_DB\` CHARACTER SET utf8mb4" 2>/dev/null; then
  if ! "${MYSQL[@]}" "$RESTORE_DB" -e 'SELECT 1' >/dev/null 2>&1; then
    echo "Cannot create or access '$RESTORE_DB' with $DB_USER." >&2
    echo "Pre-create it and grant access, e.g.:" >&2
    echo "  CREATE DATABASE $RESTORE_DB CHARACTER SET utf8mb4;" >&2
    echo "  GRANT ALL PRIVILEGES ON $RESTORE_DB.* TO '$DB_USER'@'$DB_HOST';" >&2
    exit 1
  fi
  echo "Using the existing restore schema $RESTORE_DB."
fi

# Clearing the target is safe because it is explicitly a different, separately named schema.
clear_target() {
  local list
  list="$("${MYSQL[@]}" -N -B -e "SELECT CONCAT('DROP TABLE IF EXISTS \`', table_name, '\`;') FROM information_schema.tables WHERE table_schema='${RESTORE_DB//\'/\'\'}'")"
  if [[ -n "$list" ]]; then
    printf 'SET FOREIGN_KEY_CHECKS=0;\n%s\nSET FOREIGN_KEY_CHECKS=1;\n' "$list" | "${MYSQL[@]}" "$RESTORE_DB"
  fi
}
cleanup() { clear_target || true; }
trap cleanup EXIT

clear_target
gzip -dc "$LATEST" | "${MYSQL[@]}" "$RESTORE_DB"
TOOK=$(( $(date +%s) - T0 ))

TABLES=$("${MYSQL[@]}" -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$RESTORE_DB'")
USERS=$("${MYSQL[@]}" -N -B "$RESTORE_DB" -e 'SELECT COUNT(*) FROM users')
MAILBOXES=$("${MYSQL[@]}" -N -B "$RESTORE_DB" -e 'SELECT COUNT(*) FROM mailboxes')
SCHEMA=$("${MYSQL[@]}" -N -B "$RESTORE_DB" -e 'SELECT COUNT(*) FROM schema_migrations')
echo "Restored tables=$TABLES users=$USERS mailboxes=$MAILBOXES migrations=$SCHEMA in ${TOOK}s"

record_result() {
  if ! "${MYSQL[@]}" "$DB_NAME" -e "INSERT INTO backup_runs (kind, scope, status, started_at, finished_at, message) VALUES ('restore_test','mysql','$1','$STARTED_SQL',NOW(3),'$2')"; then
    echo "WARNING: could not record the restore result in backup_runs." >&2
  fi
}

if [[ "$TABLES" -lt 20 || "$SCHEMA" -lt 1 ]]; then
  record_result failed 'restored database failed validation'
  echo "Restore validation FAILED" >&2
  exit 1
fi

record_result succeeded "tables=$TABLES users=$USERS mailboxes=$MAILBOXES seconds=$TOOK"
echo "Restore test succeeded."
