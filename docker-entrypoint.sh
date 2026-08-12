#!/bin/sh
# Fix ownership of the (possibly bind-mounted) data dir as root, then drop to the non-root
# `node` user so the app never runs with root privileges.
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /app/data
  # Best-effort: some volume types (e.g. NFS with root_squash) reject chown. Don't let that
  # block startup -- if the permissions are genuinely wrong the app surfaces a clear SQLite
  # error rather than us aborting the boot here. Data is never modified.
  chown -R node:node /app/data 2>/dev/null || \
    echo "docker-entrypoint: could not chown /app/data (continuing as node)"
  exec gosu node "$@"
fi

exec "$@"
