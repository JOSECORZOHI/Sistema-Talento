#!/usr/bin/env bash
set -e
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." >/dev/null 2>&1 && pwd )"
cd "$DIR"
NODE_BIN=$(command -v node || echo "/usr/bin/node")
exec "$NODE_BIN" scanner-bridge/bridge.js
