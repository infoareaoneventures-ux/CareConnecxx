#!/bin/sh
set -eu

freshclam --stdout
clamd --foreground &

attempt=0
until clamdscan --ping 1 >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "ClamAV daemon did not become ready" >&2
    exit 1
  fi
  sleep 1
done

exec su -s /bin/sh node -c 'exec node /app/dist/scan.js'
