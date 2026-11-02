#!/usr/bin/env bash
# Deploys the tuichess server and site: uploads the sources, builds the server with Perry on the host,
# runs the server tests against that binary, then installs it, the site and the nginx config.
# Safe to re-run; it also issues certificates once a domain's DNS points at the host.
set -euo pipefail
HOST="${TUICHESS_HOST:-root@84.32.98.163}"
cd "$(dirname "$0")/.."

echo "Uploading to $HOST..."
COPYFILE_DISABLE=1 tar --no-xattrs -czf - engine/src/chess.ts server/src tests/server.ts deploy site \
  | ssh "$HOST" 'rm -rf /opt/tuichess/build && mkdir -p /opt/tuichess/build && tar xzf - -C /opt/tuichess/build'
ssh "$HOST" 'bash /opt/tuichess/build/deploy/remote.sh'
