#!/usr/bin/env bash
# Manage the project-local MariaDB/MySQL instance used for development.
#
# The database lives in var/mysql-dev/data and listens on 127.0.0.1:3307 so it
# never collides with a system MySQL on 3306. Credentials are read from .env and
# var/mysql-dev/.credentials.
#
# Usage: scripts/dev-db.sh {start|stop|restart|status}
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
DATADIR="$ROOT_DIR/var/mysql-dev/data"
SOCKET="$ROOT_DIR/var/mysql-dev/mysql.sock"
PIDFILE="$ROOT_DIR/var/mysql-dev/mysql.pid"
ERRLOG="$ROOT_DIR/var/mysql-dev/mysql.err"

env_value() {
  # Reads KEY=value from .env without sourcing it (values may contain spaces/commas).
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | head -n1 | sed 's/[[:space:]]*#.*$//'
}

DB_HOST="$(env_value DB_HOST)"; DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="$(env_value DB_PORT)"; DB_PORT="${DB_PORT:-3306}"

if { [ "$DB_HOST" != "127.0.0.1" ] && [ "$DB_HOST" != "localhost" ]; } || [ "$DB_PORT" != "3307" ]; then
  echo "dev-db: .env points at $DB_HOST:$DB_PORT, not the local dev instance (127.0.0.1:3307). Nothing to do."
  exit 0
fi

if [ ! -d "$DATADIR" ]; then
  echo "dev-db: $DATADIR does not exist; cannot manage the local instance." >&2
  echo "dev-db: initialise it with: mariadb-install-db --datadir=$DATADIR --auth-root-authentication-method=normal" >&2
  exit 1
fi

is_up() {
  # Plain TCP probe: does not need credentials (the root password in
  # .credentials is not guaranteed to be current).
  (exec 3<>/dev/tcp/127.0.0.1/3307) 2>/dev/null
}

start() {
  if is_up; then
    echo "dev-db: already running on 127.0.0.1:3307"
    return 0
  fi
  mkdir -p "$ROOT_DIR/var/mysql-dev"
  echo "dev-db: starting MariaDB on 127.0.0.1:3307 ..."
  nohup mariadbd \
    --datadir="$DATADIR" \
    --port=3307 \
    --bind-address=127.0.0.1 \
    --socket="$SOCKET" \
    --pid-file="$PIDFILE" \
    --log-error="$ERRLOG" \
    --skip-name-resolve \
    >/dev/null 2>&1 &
  for _ in $(seq 1 60); do
    if is_up; then
      echo "dev-db: ready (socket: $SOCKET)"
      return 0
    fi
    sleep 0.5
  done
  echo "dev-db: failed to start; see $ERRLOG" >&2
  exit 1
}

stop() {
  if ! is_up; then
    echo "dev-db: not running"
    return 0
  fi
  if [ ! -f "$PIDFILE" ]; then
    echo "dev-db: running but $PIDFILE is missing; stop it manually." >&2
    exit 1
  fi
  # SIGTERM is the documented clean-shutdown signal for mariadbd and does not
  # require the (possibly stale) root password.
  kill -TERM "$(cat "$PIDFILE")"
  for _ in $(seq 1 40); do
    is_up || { echo "dev-db: stopped"; return 0; }
    sleep 0.5
  done
  echo "dev-db: did not stop cleanly; see $ERRLOG" >&2
  exit 1
}

status() {
  if is_up; then
    echo "dev-db: running on 127.0.0.1:3307"
  else
    echo "dev-db: stopped"
    exit 1
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
