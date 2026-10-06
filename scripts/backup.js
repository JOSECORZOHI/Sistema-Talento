'use strict';

// Backup completo de MongoDB (colecciones + GridFS) vía mongodump.
// GridFS (documentos.files/documentos.chunks) queda incluido en el dump de la BD.
//
// Uso:
//   npm run backup                        -> usa DATABASE_URL del .env y carpeta backups/
//   node scripts/backup.js --out /ruta/bak --db-url "mongodb://..." --verify
//
// Opciones:
//   --out <dir>      carpeta destino (por defecto <repo>/backups)
//   --db-url <url>   cadena de conexión (por defecto DATABASE_URL del .env)
//   --verify         ejecuta la prueba de restauración (verify-backup.js)
//   --no-verify      omite la prueba de restauración
//
// Requiere: mongodb-database-tools (mongodump) en el PATH.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function loadDatabaseUrl() {
  const fromArg = arg('--db-url');
  if (fromArg) return fromArg;
  const envFile = path.join(REPO, '.env');
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('DATABASE_URL='));
    if (line) return line.replace(/^DATABASE_URL=/, '').trim().replace(/^["']|["']$/g, '');
  }
  return process.env.DATABASE_URL || '';
}

function dbNameFromUri(uri) {
  const m = uri.match(/\/([^/?]+)(\?|$)/);
  return (m && m[1]) || 'talento_humano';
}

function findMongodump() {
  try {
    execFileSync('mongodump', ['--version'], { stdio: 'ignore' });
    return 'mongodump';
  } catch {}
  const candidates = [
    '/usr/bin/mongodump',
    '/usr/local/bin/mongodump',
    '/opt/mongodb-tools/bin/mongodump',
    '/opt/mongo-tools/bin/mongodump'
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const outDir = arg('--out') || path.join(REPO, 'backups');
  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error('[BACKUP] No se encontró DATABASE_URL en .env. Pase --db-url o defina la variable.');
    process.exit(1);
  }
  const dbName = dbNameFromUri(databaseUrl);
  fs.mkdirSync(outDir, { recursive: true });

  const target = path.join(outDir, stamp());
  fs.mkdirSync(target, { recursive: true });
  console.log(`[BACKUP] BD: ${dbName}`);
  console.log(`[BACKUP] Destino: ${target}`);

  // Manifiesto de conteos ANTES del volcado: verify-backup.js lo usa para
  // comprobar que la restauración no perdió documentos.
  const countsFile = path.join(target, 'counts.json');
  const counts = spawnSync(process.execPath, [path.join(__dirname, 'db-counts.js'), '--out', countsFile], { stdio: 'inherit' });
  if (counts.status !== 0) console.warn('[BACKUP] No se pudo generar counts.json.');

  const mongodump = findMongodump();
  if (!mongodump) {
    console.error('[BACKUP] No se encontró mongodump. Instálelo (ej. `sudo apt install mongo-tools` o descargue MongoDB Database Tools) y agréguelo al PATH.');
    process.exit(1);
  }
  console.log(`[BACKUP] mongodump: ${mongodump}`);

  const dump = spawnSync(mongodump, ['--uri', databaseUrl, '--db', dbName, '--out', target], { stdio: 'inherit' });
  if (dump.status !== 0) {
    console.error(`[BACKUP] mongodump falló (código ${dump.status}).`);
    process.exit(1);
  }

  // Comprimir en un único .tar.gz para facilitar la descarga.
  const archive = `${target}.tar.gz`;
  const tar = spawnSync('tar', ['-czf', archive, '-C', outDir, path.basename(target)], { stdio: 'inherit' });
  if (tar.status === 0) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[BACKUP] OK -> ${archive}`);
  } else {
    console.log(`[BACKUP] Compresión omitida; el dump quedó en ${target}`);
  }

  // Rotación: conservar solo los 10 backups más recientes.
  const archives = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.tar.gz') || f.endsWith('.gz'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(outDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(10);
  for (const { f } of archives) fs.rmSync(path.join(outDir, f), { force: true });

  // Prueba de restauración opcional: restaura en una BD temporal y compara conteos.
  // Se activa con --verify (backup:schedule la incluye por defecto).
  if (process.argv.includes('--verify')) {
    const withArchive = fs.existsSync(archive);
    if (withArchive) {
      console.log('[BACKUP] Ejecutando prueba de restauración...');
      const v = spawnSync(process.execPath, [path.join(__dirname, 'verify-backup.js'), '--backup', archive], { stdio: 'inherit' });
      if (v.status !== 0) console.warn('[BACKUP] La verificación de restauración FALLÓ (revise los avisos).');
      else console.log('[BACKUP] Verificación de restauración OK.');
    } else {
      console.warn('[BACKUP] No se pudo verificar (falta el .tar.gz).');
    }
  }
  console.log('[BACKUP] Listo.');
}

main();
