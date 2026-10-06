'use strict';

// Registra (o elimina) una entrada cron para el backup automático diario,
// con prueba de restauración integrada.
//
// Uso:
//   node scripts/install-backup-cron.js                 -> backup diario a las 02:00 con verificación
//   node scripts/install-backup-cron.js --time 23:30    -> a otra hora
//   node scripts/install-backup-cron.js --no-verify     -> sin prueba de restauración
//   node scripts/install-backup-cron.js --remove         -> elimina la entrada
//
// Notas:
//   - Requiere cron instalado y en ejecución (ej. `sudo apt install cron`).
//   - El equipo debe estar encendido y con internet a la hora programada.

const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const MARK_BEGIN = '# TalentoHumano-Backup BEGIN';
const MARK_END = '# TalentoHumano-Backup END';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function readCrontab() {
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (r.status !== 0) return '';
  return r.stdout || '';
}

function writeCrontab(content) {
  const r = spawnSync('crontab', ['-'], { input: content, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0) {
    console.error('[TAREA] No se pudo escribir el crontab (¿cron instalado?).');
    process.exit(1);
  }
}

function stripBlock(text) {
  const lines = text.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (line.trim() === MARK_BEGIN) { skipping = true; continue; }
    if (line.trim() === MARK_END) { skipping = false; continue; }
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function main() {
  if (process.argv.includes('--remove')) {
    const cleaned = stripBlock(readCrontab());
    writeCrontab(cleaned);
    console.log('[TAREA] Entrada eliminada: TalentoHumano-Backup');
    return;
  }

  const time = arg('--time') || '02:00';
  const m = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    console.error('[TAREA] Hora inválida. Use formato HH:MM (ej. --time 23:30).');
    process.exit(1);
  }
  const hh = String(Math.min(23, parseInt(m[1], 10)));
  const mm = String(Math.min(59, parseInt(m[2], 10)));

  const nodeBin = process.execPath;
  const verify = process.argv.includes('--no-verify') ? ' --no-verify' : ' --verify';
  const cmd = `${mm} ${hh} * * * cd ${REPO} && ${nodeBin} scripts/backup.js${verify} >> backups/cron.log 2>&1`;

  const cleaned = stripBlock(readCrontab());
  const next = (cleaned.trim() ? cleaned.trim() + '\n' : '') +
    `${MARK_BEGIN}\n${cmd}\n${MARK_END}\n`;
  writeCrontab(next);

  console.log('[TAREA] Entrada cron registrada: TalentoHumano-Backup');
  console.log(`[TAREA] Hora diaria: ${hh.padStart(2, '0')}:${mm}`);
  console.log(`[TAREA] Comando: ${cmd}`);
  console.log('[TAREA] Compruébela con: crontab -l');
}

main();
