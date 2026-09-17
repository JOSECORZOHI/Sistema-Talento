'use strict';

// Prueba de restauración de un backup.
//
// Toma un backup generado por scripts/backup.ps1 (carpeta o .gz), lo restaura en
// una base de datos TEMPORAL ("<db>_restore_test_<timestamp>") con mongorestore y
// compara el número de documentos de cada colección contra el manifiesto
// counts.json que el backup dejó guardado. Al terminar elimina la base temporal.
//
// Uso:
//   node scripts/verify-backup.js                       -> usa el backup .gz más reciente
//   node scripts/verify-backup.js --backup backups/20260917_120000.gz
//   node scripts/verify-backup.js --backup backups/20260917_120000 --keep-scratch
//
// Códigos de salida: 0 = verificación OK, 1 = fallo, 2 = error de uso/entorno.
// Requiere: mongorestore (MongoDB Database Tools) en el PATH o en la ruta típica.

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { MongoClient } = require('mongodb');

// Colecciones volátiles (TTL / limpieza en login): se informan, no se comparan.
const TRANSIENT = new Set(['twoFactorChallenges', 'loginAttempts']);

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

function findInDir(dir, filename) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === filename.toLowerCase()) return full;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const found = findInDir(path.join(dir, e.name), filename);
    if (found) return found;
  }
  return null;
}

function findTool(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  const bases = [
    path.join(process.env.ProgramFiles || '', 'MongoDB', 'Tools'),
    path.join(process.env['ProgramFiles(x86)'] || '', 'MongoDB', 'Tools')
  ];
  for (const base of bases) {
    const found = findInDir(base, exe);
    if (found) return found;
  }
  return null;
}

function latestBackup(backupsDir) {
  if (!fs.existsSync(backupsDir)) return null;
  const files = fs.readdirSync(backupsDir)
    .filter(f => f.toLowerCase().endsWith('.gz'))
    .map(f => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(backupsDir, files[0].f) : null;
}

async function countCollections(db) {
  const collections = await db.listCollections().toArray();
  const counts = {};
  for (const c of collections) {
    if (c.name.startsWith('system.')) continue;
    counts[c.name] = await db.collection(c.name).countDocuments();
  }
  return counts;
}

function usage() {
  console.error('Uso: node scripts/verify-backup.js [--backup <carpeta|.gz>] [--keep-scratch]');
}

(async () => {
  const uri = process.env.DATABASE_URL;
  if (!uri) {
    console.error('[VERIFY] DATABASE_URL no está definida.');
    process.exit(2);
  }

  const mongorestore = findTool('mongorestore');
  if (!mongorestore) {
    console.error('[VERIFY] No se encontró mongorestore. Instale MongoDB Database Tools.');
    process.exit(2);
  }

  const backupPath = arg('--backup') || latestBackup(path.join(__dirname, '..', 'backups'));
  if (!backupPath) {
    usage();
    console.error('[VERIFY] No se indicó backup y no hay ninguno en ./backups.');
    process.exit(2);
  }
  if (!fs.existsSync(backupPath)) {
    console.error(`[VERIFY] No existe la ruta: ${backupPath}`);
    process.exit(2);
  }

  let tempDir = null;
  let dumpRoot = backupPath;

  if (fs.statSync(backupPath).isDirectory()) {
    dumpRoot = backupPath;
  } else {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-verify-'));
    console.log(`[VERIFY] Extrayendo ${backupPath} ...`);
    const xtract = spawnSync('tar', ['-zxf', backupPath, '-C', tempDir], { stdio: 'inherit' });
    if (xtract.status !== 0) {
      console.error('[VERIFY] No se pudo extraer el archivo .gz (¿tar disponible?).');
      process.exit(1);
    }
    const entries = fs.readdirSync(tempDir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length !== 1) {
      console.error('[VERIFY] El .gz no tiene la estructura esperada (una carpeta raíz).');
      process.exit(1);
    }
    dumpRoot = path.join(tempDir, entries[0].name);
  }

  const countsPath = findInDir(dumpRoot, 'counts.json');
  const client = new MongoClient(uri);
  // MongoDB limita los nombres de BD a 38 bytes: usamos un nombre corto y único.
  const scratchDbName = ('th_restore_' + Date.now().toString(36)).slice(0, 38);
  let createdScratch = false;

  try {
    let manifest = null;
    let sourceDbName = process.env.DATABASE_NAME || 'talento_humano';
    if (countsPath) {
      manifest = JSON.parse(fs.readFileSync(countsPath, 'utf8'));
      if (manifest.db) sourceDbName = manifest.db;
    }

    await client.connect();

    if (!manifest) {
      console.warn('[VERIFY] El backup no tiene counts.json; se comparará contra la base actual (menos fiable).');
      manifest = { db: sourceDbName, counts: await countCollections(client.db(sourceDbName)) };
    }

    // Con --nsFrom/--nsTo, mongorestore debe apuntar directamente a la carpeta de
    // la base de datos (la que contiene los .bson), no a la raíz del volcado.
    let dbDir = path.join(dumpRoot, sourceDbName);
    if (!fs.existsSync(dbDir) || !fs.statSync(dbDir).isDirectory()) dbDir = dumpRoot;

    console.log(`[VERIFY] Restaurando ${sourceDbName} -> ${scratchDbName} ...`);
    const restore = spawnSync(mongorestore, [
      '--uri', uri,
      '--drop',
      '--nsFrom', `${sourceDbName}.*`,
      '--nsTo', `${scratchDbName}.*`,
      dbDir
    ], { stdio: 'inherit' });

    if (restore.status !== 0) {
      console.error(`[VERIFY] mongorestore falló (código ${restore.status}).`);
      process.exit(1);
    }
    createdScratch = true;

    const restored = await countCollections(client.db(scratchDbName));

    const failures = [];
    const warnings = [];
    let checked = 0;
    const expectedNames = Object.keys(manifest.counts).sort();

    for (const name of expectedNames) {
      const expected = manifest.counts[name];
      const actual = restored[name];
      if (TRANSIENT.has(name)) {
        console.log(`[VERIFY]  ~ ${name}: ${actual ?? 0} (volátil, no se compara)`);
        continue;
      }
      if (actual === undefined) {
        failures.push(`${name}: no se restauró la colección (esperados ${expected}).`);
        continue;
      }
      checked++;
      if (actual < expected) {
        failures.push(`${name}: restaurados ${actual} < esperados ${expected} (faltan documentos).`);
      } else if (actual > expected) {
        warnings.push(`${name}: restaurados ${actual} > esperados ${expected} (documentos nuevos tras el backup).`);
      } else {
        console.log(`[VERIFY]  OK ${name}: ${actual}`);
      }
    }

    for (const name of Object.keys(restored)) {
      if (!(name in manifest.counts)) warnings.push(`${name}: colección extra no presente en el manifiesto.`);
    }

    for (const w of warnings) console.warn(`[VERIFY] AVISO ${w}`);

    if (failures.length) {
      console.error('\n[VERIFY] RESULTADO: FALLÓ');
      for (const f of failures) console.error(`[VERIFY]  - ${f}`);
      process.exit(1);
    }

    console.log(`\n[VERIFY] RESULTADO: OK (${checked} colecciones verificadas).`);
  } finally {
    if (createdScratch && !hasFlag('--keep-scratch')) {
      try {
        await client.db(scratchDbName).dropDatabase();
        console.log(`[VERIFY] Base temporal ${scratchDbName} eliminada.`);
      } catch (e) {
        console.warn(`[VERIFY] No se pudo eliminar ${scratchDbName}: ${e.message}`);
      }
    }
    await client.close().catch(() => {});
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('[VERIFY] Error inesperado:', e.message);
  process.exit(1);
});
