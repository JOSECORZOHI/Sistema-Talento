#!/usr/bin/env bash
echo "================================================================"
echo "  DESINSTALACION DEL AGENTE PUENTE DE ESCANER"
echo "================================================================"

systemctl --user stop talento-scanner-bridge.service 2>/dev/null || true
systemctl --user disable talento-scanner-bridge.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/talento-scanner-bridge.service"
rm -f "$HOME/.config/autostart/talento-scanner-bridge.desktop"
systemctl --user daemon-reload 2>/dev/null || true

echo "[OK] Servicio de usuario deshabilitado y eliminado."
echo "================================================================"
