#!/usr/bin/env bash
set -e

echo "================================================================"
echo "  INSTALANDO CONECTOR DE ESCANER (Linux)"
echo "================================================================"

DEST_DIR="$HOME/.local/share/talento-scanner-bridge"
mkdir -p "$DEST_DIR"

NODE_BIN=$(command -v node || echo "/usr/bin/node")

# Descarga o copia del script bridge
cat <<'EOF' > "$DEST_DIR/bridge.js"
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = 5070;

function runBin(program, args = []) {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: 25000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => { resolve((stdout || '').trim()); });
  });
}

async function detectLinuxScanners() {
  const raw = await runBin('scanimage', ['-L']);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^device\s+`([^']+)'\s+is\s+a\s+(.+)$/);
    if (!m) continue;
    out.push({ name: m[2].trim(), type: /net/i.test(m[1]) ? 'Red' : 'USB', status: 'Conectado', device: m[1].trim() });
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/health')) {
    const scanners = await detectLinuxScanners();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, bridge: true, platform: 'linux', scanners, count: scanners.length, connected: scanners.length > 0 }));
  }

  if (req.method === 'POST' && url.pathname === '/scan') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const fnBase = parsed.filename || `Escaneo_${Date.now()}`;
        const tempPng = path.join(os.tmpdir(), `_sane_${Date.now()}.png`);

        const devList = await runBin('scanimage', ['-L']);
        const devMatch = devList.match(/^device\s+`([^']+)'/m);
        const device = devMatch ? devMatch[1].trim() : null;
        const scanArgs = ['--format=png', '--resolution=200', '-o', tempPng];
        if (device) scanArgs.unshift('-d', device);

        const scanned = await new Promise((resolve) => {
          execFile('scanimage', scanArgs, { timeout: 120000 }, (err) => { resolve(fs.existsSync(tempPng)); });
        });

        if (!scanned) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'No se pudo escanear con scanimage.' }));
        }

        const pngBuf = fs.readFileSync(tempPng);
        try { fs.unlinkSync(tempPng); } catch {}

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, filename: `${fnBase}.png`, imageBase64: pngBuf.toString('base64'), sizeBytes: pngBuf.length }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, '127.0.0.1');
EOF

# Configurar autostart
AUTOSTART_DIR="$HOME/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cat <<EOF > "$AUTOSTART_DIR/talento-scanner-bridge.desktop"
[Desktop Entry]
Type=Application
Name=Conector de Escaner
Exec=$NODE_BIN "$DEST_DIR/bridge.js"
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF

nohup "$NODE_BIN" "$DEST_DIR/bridge.js" >/dev/null 2>&1 &

echo ""
echo "[OK] Conector de escaner instalado y en ejecucion."
echo "Ya puede regresar a la pagina web en su navegador."
