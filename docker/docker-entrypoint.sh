#!/usr/bin/env bash
set -euo pipefail

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
CONFIG_DIR="${M4_CONFIG_DIR:-/config}"

# If the container was started with Docker `--user UID:GID`, run directly without privilege changes.
if [ "$(id -u)" -ne 0 ]; then
    exec "$@"
fi

if ! [[ "$PUID" =~ ^[0-9]+$ ]] || ! [[ "$PGID" =~ ^[0-9]+$ ]]; then
    echo "ERROR: PUID and PGID must be numeric values (got PUID='${PUID}', PGID='${PGID}')." >&2
    exit 1
fi

if [ "$PUID" -eq 0 ] || [ "$PGID" -eq 0 ]; then
    echo "ERROR: Running M4 as root (PUID=0 or PGID=0) is not supported. Set non-zero PUID/PGID." >&2
    exit 1
fi

CURRENT_UID="$(id -u m4)"
CURRENT_GID="$(id -g m4)"

if [ "$CURRENT_GID" -ne "$PGID" ]; then
    # -o allows sharing a common host GID such as 100 (users) on Unraid/Synology.
    groupmod -o -g "$PGID" m4
fi

if [ "$CURRENT_UID" -ne "$PUID" ]; then
    usermod -o -u "$PUID" -g "$PGID" m4
fi

# Ensure /config exists and is writable by the mapped user; never chown /music recursively.
mkdir -p "$CONFIG_DIR"
chown -R "${PUID}:${PGID}" "$CONFIG_DIR"

export HOME="/home/m4"
export USER="m4"

echo "[M4] Starting as non-root user m4 (UID=${PUID}, GID=${PGID})"
exec gosu "${PUID}:${PGID}" "$@"
