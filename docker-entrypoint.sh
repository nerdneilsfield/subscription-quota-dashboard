#!/bin/sh
set -eu

db_dir="$(dirname "${DASHBOARD_DB:-/app/data/dashboard.db}")"
mkdir -p "$db_dir"
chown -R bun:bun "$db_dir"

exec su -s /bin/sh bun -c 'exec "$0" "$@"' "$@"
