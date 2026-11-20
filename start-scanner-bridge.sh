#!/usr/bin/env bash
echo "==================================================="
echo "  Iniciando Agente Puente de Escaner..."
echo "==================================================="
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"
node scanner-bridge/bridge.js
