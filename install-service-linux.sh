#!/usr/bin/env bash
set -e

echo "================================================================"
echo "  INSTALACION DEL AGENTE PUENTE DE ESCANER COMO SERVICIO"
echo "  Sistema de Gestion Documental - Alcaldia de Valledupar"
echo "================================================================"
echo ""

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
    echo "[ERROR] Node.js no esta instalado o no se encuentra en el PATH."
    exit 1
fi

PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
BRIDGE_SCRIPT="$PROJECT_DIR/scanner-bridge/bridge.js"

if [ ! -f "$BRIDGE_SCRIPT" ]; then
    echo "[ERROR] No se encontro $BRIDGE_SCRIPT"
    exit 1
fi

SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"

SERVICE_FILE="$SYSTEMD_USER_DIR/talento-scanner-bridge.service"

RUN_SCRIPT="$PROJECT_DIR/scanner-bridge/run-bridge.sh"
chmod +x "$RUN_SCRIPT"

cat <<EOF > "$SERVICE_FILE"
[Unit]
Description=Agente Puente de Escaner - Talento Humano
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash "$RUN_SCRIPT"
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF

echo "[1/3] Archivo de servicio systemd creado en:"
echo "      $SERVICE_FILE"

# Recargar y habilitar servicio
systemctl --user daemon-reload
systemctl --user enable talento-scanner-bridge.service
systemctl --user restart talento-scanner-bridge.service

echo "[2/3] Servicio habilitado e iniciado."

# También configurar autostart de escritorio como respaldo para entornos gráficos
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat <<EOF > "$AUTOSTART_DIR/talento-scanner-bridge.desktop"
[Desktop Entry]
Type=Application
Name=Agente Puente de Escaner
Exec=/bin/bash "$RUN_SCRIPT"
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

echo "[3/3] Entrada de inicio automatico de sesion configurada."
echo ""
echo "================================================================"
echo "  LISTO: El Agente Puente se ha instalado correctamente."
echo "  Iniciara solo cada vez que encienda su computador."
echo ""
echo "  Estado actual del servicio:"
systemctl --user status talento-scanner-bridge.service --no-pager || true
echo "================================================================"
