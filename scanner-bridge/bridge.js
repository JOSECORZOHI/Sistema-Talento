'use strict';

/**
 * Agente Puente de Escáner (Local Scanner Bridge)
 * Sistema de Gestión Documental - Oficina de Talento Humano
 *
 * Se ejecuta en el computador local con el escáner conectado (Windows o Linux).
 * Escucha en http://127.0.0.1:5070 y permite que la web de Render dispare
 * escaneos físicos y reciba el PDF resultante sin arrastrar archivos.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { exec, execFile } = require('child_process');

let PDFDocument = null;
try {
  PDFDocument = require('pdfkit');
} catch {
  // Opcional si se corre aislado sin node_modules
}

const PORT = parseInt(process.env.BRIDGE_PORT || '5070', 10);
const IS_WINDOWS = process.platform === 'win32';

// Ejecución segura de PowerShell en Windows
function runPs(cmd, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const full = `$ProgressPreference='SilentlyContinue';${cmd}`;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          console.warn('[BRIDGE-PS] Error:', error.message);
          return resolve('');
        }
        resolve((stdout || '').replace(/#< CLIXML[\s\S]*?<\/Objs>\s*/g, '').trim());
      });
  });
}

// Ejecución de binarios en Linux
function runBin(program, args = [], timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error && !stdout) {
          return resolve('');
        }
        resolve((stdout || '').trim());
      });
  });
}

// Detección de escáneres en Windows (WIA / PnP)
async function detectWindowsScanners() {
  const raw = await runPs(`
    $scanners = @()
    try {
      $deviceManager = New-Object -ComObject WIA.DeviceManager
      foreach ($di in $deviceManager.DeviceInfos) {
        if (($di.Type -band 1) -eq 1) {
          $desc = ''
          foreach ($p in $di.Properties) { if ($p.PropertyID -eq 4) { $desc = [string]$p.Value } }
          $scanners += [PSCustomObject]@{ Name = $desc; Status = 'Conectado'; Type = 'USB' }
        }
      }
    } catch {}
    try {
      Get-PnpDevice -Status OK -Class Image -ErrorAction SilentlyContinue | ForEach-Object {
        $exists = $false
        foreach ($s in $scanners) { if ($s.Name -eq $_.FriendlyName) { $exists = $true; break } }
        if (-not $exists) {
          $scanners += [PSCustomObject]@{ Name = $_.FriendlyName; Status = 'Conectado'; Type = 'USB' }
        }
      }
    } catch {}
    if ($scanners.Count -gt 0) {
      $scanners | ConvertTo-Json -Compress
    }
  `);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(d => ({
      name: d.Name || 'Escáner USB',
      type: d.Type || 'USB',
      status: d.Status || 'Conectado'
    }));
  } catch {
    return [];
  }
}

// Detección de escáneres en Linux (SANE)
async function detectLinuxScanners() {
  const raw = await runBin('scanimage', ['-L']);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^device\s+`([^']+)'\s+is\s+a\s+(.+)$/);
    if (!m) continue;
    out.push({
      name: m[2].trim(),
      type: /net/i.test(m[1]) ? 'Red' : 'USB',
      status: 'Conectado',
      device: m[1].trim()
    });
  }
  return out;
}

// Convertir buffer de imagen (PNG/JPEG) a PDF en memoria
async function imageToPdfBuffer(imageBuffer) {
  if (!PDFDocument) {
    throw new Error('Módulo pdfkit no disponible en el agente.');
  }
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      const doc = new PDFDocument({ autoFirstPage: false });
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const img = doc.openImage(imageBuffer);
      doc.addPage({ size: [img.width, img.height] });
      doc.image(img, 0, 0, { width: img.width, height: img.height });
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Escaneo en Windows vía WIA
async function scanWindowsWia(filenameBase) {
  const tempToken = crypto.randomBytes(4).toString('hex');
  const tempBmp = path.join(os.tmpdir(), `_wia_${tempToken}.bmp`);
  const tempPng = path.join(os.tmpdir(), `_wia_${tempToken}.png`);

  const psScript = `
    try {
      Add-Type -AssemblyName System.Drawing
      $deviceManager = New-Object -ComObject WIA.DeviceManager
      $deviceInfo = $null
      foreach ($di in $deviceManager.DeviceInfos) {
        if (($di.Type -band 1) -eq 1) { $deviceInfo = $di; break }
      }
      if (-not $deviceInfo) { Write-Output "ERROR:NO_DEVICE"; exit }
      $device = $deviceInfo.Connect()
      $item = $device.Items(1)
      $image = $item.Transfer()
      if (-not $image) { Write-Output "ERROR:TRANSFER_FAILED"; exit }
      $image.SaveFile("${tempBmp.replace(/\\/g, '\\\\')}")
      $bmp = [System.Drawing.Image]::FromFile("${tempBmp.replace(/\\/g, '\\\\')}")
      $bmp.Save("${tempPng.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      Write-Output "OK"
    } catch {
      Write-Output "ERROR:$($_.Exception.Message)"
    }
  `;

  const result = await runPs(psScript, 90000);
  try { if (fs.existsSync(tempBmp)) fs.unlinkSync(tempBmp); } catch {}

  if (!result || !result.includes('OK')) {
    try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng); } catch {}
    throw new Error(result.replace('ERROR:', '').trim() || 'Fallo durante el escaneo WIA.');
  }

  const pngBuf = fs.readFileSync(tempPng);
  try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng); } catch {}

  const pdfBuf = await imageToPdfBuffer(pngBuf);
  return { pdfBuffer: pdfBuf, filename: `${filenameBase}.pdf` };
}

// Escaneo en Linux vía SANE
async function scanLinuxSane(filenameBase) {
  const tempToken = crypto.randomBytes(4).toString('hex');
  const tempPng = path.join(os.tmpdir(), `_sane_${tempToken}.png`);

  const devList = await runBin('scanimage', ['-L']);
  const devMatch = devList.match(/^device\s+`([^']+)'/m);
  const device = devMatch ? devMatch[1].trim() : null;

  const scanArgs = ['--format=png', '--resolution=200', '-o', tempPng];
  if (device) scanArgs.unshift('-d', device);

  const scanned = await new Promise((resolve) => {
    execFile('scanimage', scanArgs, { timeout: 120000, maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) {
        console.warn('[BRIDGE-SANE] Error:', err.message);
        return resolve(false);
      }
      resolve(fs.existsSync(tempPng));
    });
  });

  if (!scanned) {
    try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng); } catch {}
    throw new Error('No se pudo completar el escaneo con scanimage.');
  }

  const pngBuf = fs.readFileSync(tempPng);
  try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng); } catch {}

  const pdfBuf = await imageToPdfBuffer(pngBuf);
  return { pdfBuffer: pdfBuf, filename: `${filenameBase}.pdf` };
}

// Servidor HTTP del puente
const server = http.createServer(async (req, res) => {
  // Configuración de CORS permisivo para peticiones del navegador
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Endpoint de salud y detección
  if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/health')) {
    try {
      const scanners = IS_WINDOWS ? await detectWindowsScanners() : await detectLinuxScanners();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        bridge: true,
        version: '1.0.0',
        platform: process.platform,
        scanners,
        count: scanners.length,
        connected: scanners.length > 0
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message, scanners: [] }));
    }
  }

  // Endpoint de ejecución de escaneo físico
  if (req.method === 'POST' && url.pathname === '/scan') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch {}
        const customName = (parsed.filename || `Escaneo_${Date.now()}`)
          .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _.-]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 100);

        console.log(`[BRIDGE] Iniciando escaneo físico: '${customName}'...`);
        const result = IS_WINDOWS
          ? await scanWindowsWia(customName)
          : await scanLinuxSane(customName);

        console.log(`[BRIDGE] Escaneo exitoso (${result.pdfBuffer.length} bytes). Enviando al navegador...`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true,
          filename: result.filename,
          sizeBytes: result.pdfBuffer.length,
          pdfBase64: result.pdfBuffer.toString('base64')
        }));
      } catch (e) {
        console.error('[BRIDGE] Error escaneando:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Vista básica informativa
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!DOCTYPE html>
<html>
<head><title>Agente Puente de Escáner</title><meta charset="utf-8">
<style>body{font-family:sans-serif;padding:30px;line-height:1.6;background:#f8fafc;color:#1e293b} .card{background:#fff;padding:24px;border-radius:10px;box-shadow:0 2px 8px rgba(0,0,0,0.06);max-width:500px;margin:auto;text-align:center} .status{color:#16a34a;font-weight:bold;font-size:18px}</style>
</head>
<body>
  <div class="card">
    <h2>Agente Puente de Escáner</h2>
    <p class="status">✓ En ejecución (Puerto ${PORT})</p>
    <p>Este servicio permite que el Sistema de Talento Humano en la nube se comunique con su escáner físico.</p>
    <p style="font-size:12px;color:#64748b">Mantenga esta ventana abierta mientras utilice el escáner.</p>
  </div>
</body>
</html>`);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('========================================================');
  console.log(`  Agente Puente de Escáner Activo`);
  console.log(`  Escuchando en: http://127.0.0.1:${PORT}`);
  console.log(`  Plataforma: ${process.platform} (${IS_WINDOWS ? 'Windows WIA' : 'Linux SANE'})`);
  console.log('  Mantenga esta consola abierta mientras escanea');
  console.log('========================================================');
});
