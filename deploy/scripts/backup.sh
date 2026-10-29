#!/usr/bin/env bash
# ARTHVEX Mail backup: MySQL metadata + Stalwart data directory.
# Usage: sudo -u arthvex BACKUP_DIR=/var/backups/arthvex ./deploy/scripts/backup.sh
# Optional: BACKUP_ENCRYPT_CMD="age -r age1..." to encrypt each archive; BACKUP_RETENTION_DAYS=14.
# This script does not delete anything outside its own BACKUP_DIR and never prints secrets.
set -euo pipefail

ENV_FILE="${ENV_FILE:-/etc/arthvex/backend.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/arthvex}"
STALWART_DATA_DIR="${STALWART_DATA_DIR:-/var/lib/stalwart}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

if [[ ! -r "$ENV_FILE" ]]; then
  echo "Cannot read $ENV_FILE" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a
: "${DB_HOST:?}" "${DB_PORT:?}" "${DB_NAME:?}" "${DB_USER:?}" "${DB_PASSWORD:?}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP="$BACKUP_DIR/arthvex-db-$STAMP.sql.gz"
MAIL="$BACKUP_DIR/arthvex-mail-$STAMP.tar.gz"
STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# backup_runs.started_at is DATETIME: MySQL rejects the ISO-8601 "T...Z" form, so use a SQL-safe value.
STARTED_SQL="$(date -u +'%Y-%m-%d %H:%M:%S')"
export MYSQL_PWD="$DB_PASSWORD"

record() {
  if ! mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" \
    -e "INSERT INTO backup_runs (kind, scope, status, started_at, finished_at, size_bytes, location_label, message) VALUES ('backup', 'mysql+mail', '$1', '$STARTED_SQL', NOW(3), $2, '$BACKUP_DIR', '$3')"; then
    echo "WARNING: could not record this run in backup_runs; the admin dashboard will report the last backup as stale." >&2
  fi
}

# `--set-gtid-purged` is a MySQL-only option; MariaDB's dump rejects it ("unknown variable").
# Detect the server flavour instead of assuming one product.
DUMP_ARGS=(--single-transaction --quick --routines --events --skip-dump-date)
SERVER_VERSION="$(mysql --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -N -B -e 'SELECT VERSION()')"
if [[ "$SERVER_VERSION" != *MariaDB* ]]; then
  DUMP_ARGS+=(--set-gtid-purged=OFF)
fi

echo "Backing up database $DB_NAME ($SERVER_VERSION) …"
if ! mysqldump --protocol=TCP -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "${DUMP_ARGS[@]}" "$DB_NAME" 2>"$BACKUP_DIR/.dump-$STAMP.err" \
  | gzip -9 > "$DUMP"; then
  echo "Database dump failed; removing the incomplete archive." >&2
  tail -5 "$BACKUP_DIR/.dump-$STAMP.err" >&2 || true
  rm -f "$DUMP" "$BACKUP_DIR/.dump-$STAMP.err"
  record failed 0 'database dump failed'
  exit 1
fi
rm -f "$BACKUP_DIR/.dump-$STAMP.err"

if [[ -d "$STALWART_DATA_DIR" ]]; then
  echo "Archiving mail store $STALWART_DATA_DIR …"
  tar -C "$(dirname "$STALWART_DATA_DIR")" -czf "$MAIL" "$(basename "$STALWART_DATA_DIR")"
else
  echo "WARNING: $STALWART_DATA_DIR not found; database-only backup." >&2
  MAIL=""
fi

# Integrity: verify the gzip streams before declaring success.
gzip -t "$DUMP"
[[ -z "$MAIL" ]] || gzip -t "$MAIL"

SIZE=0
FILES=("$DUMP")
[[ -z "$MAIL" ]] || FILES+=("$MAIL")
for f in "${FILES[@]}"; do SIZE=$((SIZE + $(stat -c %s "$f"))); done

FINAL=("${FILES[@]}")
if [[ -n "${BACKUP_ENCRYPT_CMD:-}" ]]; then
  echo "Encrypting archives …"
  FINAL=()
  for f in "${FILES[@]}"; do
    # shellcheck disable=SC2086
    if ! eval "$BACKUP_ENCRYPT_CMD" < "$f" > "$f.enc"; then
      echo "Encryption failed for $f; keeping the unencrypted archives." >&2
      rm -f "$f.enc"
      exit 1
    fi
    rm -f "$f"
    FINAL+=("$f.enc")
  done
fi

# Write checksums only over the files that exist in their final form.
sha256sum "${FINAL[@]}" > "$BACKUP_DIR/SHA256SUMS-$STAMP"

record succeeded "$SIZE" "db+mail backup $STAMP"
echo "Backup complete: $STAMP ($SIZE bytes). Verify with a restore test."

# Retention: only files matching our prefix, only inside BACKUP_DIR.
find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'arthvex-db-*' -o -name 'arthvex-mail-*' -o -name 'SHA256SUMS-*' \) \
  -mtime +"$RETENTION_DAYS" -print -delete
