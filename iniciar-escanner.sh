#!/usr/bin/env bash
# Inicia el servidor local del escáner en el PC de la alcaldía (Linux).
# Uso: ./iniciar-escanner.sh   (o: bash iniciar-escanner.sh)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "No se encontró Node.js. Instale Node 20+ (ej. desde https://nodejs.org o con su gestor de paquetes) y reintente."
  exit 1
fi

if [ ! -f ./.env ]; then
  echo "Falta el archivo .env en esta carpeta. Copie .env.example a .env y complete DATABASE_URL, JWT_SECRET y DOC_ENC_KEY."
  exit 1
fi

if [ ! -d ./node_modules ]; then
  echo "Instalando dependencias por primera vez..."
  npm install
fi

if ! command -v scanimage >/dev/null 2>&1; then
  echo "Aviso: scanimage no está instalado. Para detectar y usar el escáner: sudo apt install sane-utils"
  echo "La bandeja (bandeja_escaner/) y el resto del sistema funcionan igual sin escáner."
fi

echo "Levantando servidor local del escáner en http://localhost:3000"
echo "Para detenerlo: Ctrl+C"
npm start
