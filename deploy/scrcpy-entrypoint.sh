#!/bin/sh
set -eu

mkdir -p /data/dependencies/scrcpy-server
if [ ! -s /data/dependencies/scrcpy-server/scrcpy-server ]; then
  cp /app/seed/scrcpy-server/scrcpy-server \
    /data/dependencies/scrcpy-server/scrcpy-server
fi

chown -R 1000:1000 /data/dependencies

exec /usr/local/bin/entrypoint.sh /app/start.sh
