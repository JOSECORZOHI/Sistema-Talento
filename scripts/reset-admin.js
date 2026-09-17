'use strict';

// Recuperación de la cuenta administrador (break-glass).
//
// Resuelve el riesgo de "un solo administrador": si se pierde la contraseña o
// el dispositivo del 2FA, el sistema quedaría sin acceso. Este script se ejecuta
// desde la consola del servidor (donde está DATABASE_URL) y deja la cuenta admin
// lista para entrar de nuevo:
//   - Asigna una contraseña temporal (o la indicada con --password).
//   - Fuerza el cambio de contraseña en el próximo inicio (mustChangePassword).
//   - Desactiva el 2FA para poder entrar; el admin deberá configurarlo de nuevo.
//   - Reactiva la cuenta y limpia bloqueos por intentos fallidos.
//   - Incrementa jwtVersion para invalidar cualquier sesión abierta.
//
// Uso:
//   node scripts/reset-admin.js --confirm
//   node scripts/reset-admin.js --confirm --email admin@dominio.gov.co
//   node scripts/reset-admin.js --confirm --password 'NuevaClave123!'
//   node scripts/reset-admin.js --dry-run          (no escribe nada)
//
// Requiere --confirm para modificar datos. El script SOLO actúa sobre cuentas
// con role=admin.

require('dotenv').config();

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const dbmod = require('../db');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

const USAGE = [
  'Uso: node scripts/reset-admin.js --confirm [--email correo] [--password clave] [--dry-run]',
  '  --confirm    requerido para aplicar los cambios',
  '  --email      correo del admin (por defecto, el único administrador)',
  '  --password   contraseña nueva (por defecto se genera una temporal)',
  '  --dry-run    muestra lo que haría sin escribir en la base'
].join('\n');

(async () => {
  const dryRun = hasFlag('--dry-run');
  if (!dryRun && !hasFlag('--confirm')) {
    console.error(USAGE);
    process.exit(2);
  }

  const requestedEmail = (arg('--email') || '').trim().toLowerCase();
  const providedPassword = arg('--password');

  let db;
  try {
    db = await dbmod.connect();
  } catch (e) {
    console.error('[RECOVERY] No se pudo conectar a la base de datos:', e.message);
    process.exit(1);
  }

  try {
    const users = dbmod.col('users');
    const admin = requestedEmail
      ? await users.findOne({ role: 'admin', email: requestedEmail })
      : await users.findOne({ role: 'admin' });

    if (!admin) {
      console.error(requestedEmail
        ? `[RECOVERY] No existe una cuenta admin con el correo ${requestedEmail}.`
        : '[RECOVERY] No se encontró ninguna cuenta con role=admin.');
      process.exit(1);
    }

    const tempPassword = providedPassword || dbmod.generateTempPassword();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const changes = {
      password: passwordHash,
      mustChangePassword: true,
      status: 'activa',
      active: true,
      failedAttempts: 0,
      lockedUntil: null,
      totpEnabled: false,
      totpSecret: null
    };

    console.log(`[RECOVERY] Cuenta objetivo: ${admin.email}`);
    console.log(`[RECOVERY] Contraseña temporal: ${tempPassword}`);
    console.log('[RECOVERY] 2FA: se desactivará (deberá configurarlo otra vez).');
    console.log('[RECOVERY] Se forzará cambio de contraseña en el próximo inicio.');

    if (dryRun) {
      console.log('[RECOVERY] --dry-run: no se escribió nada en la base.');
      return;
    }

    const result = await users.updateOne(
      { _id: admin._id },
      { $set: changes, $inc: { jwtVersion: 1 } }
    );

    try {
      await dbmod.col('securityLogs').insertOne({
        id: 'sec_recovery_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
        timestamp: new Date().toISOString(),
        event: 'ADMIN_RECOVERY',
        details: `Se restableció la contraseña del administrador ${admin.email}, se desactivó su 2FA y se invalidaron sus sesiones mediante el script local reset-admin.js.`,
        ip: 'local',
        email: admin.email,
        severity: 'high'
      });
    } catch (e) {
      console.warn('[RECOVERY] No se pudo registrar el evento en securityLogs:', e.message);
    }

    if (result.modifiedCount !== 1) {
      console.error('[RECOVERY] No se modificó la cuenta (¿ya estaba en ese estado?).');
      process.exit(1);
    }

    console.log('[RECOVERY] Listo. Ingrese con la contraseña temporal y configure el 2FA.');
  } finally {
    await dbmod.closeDb();
  }
})().catch(async (e) => {
  console.error('[RECOVERY] Error inesperado:', e.message);
  process.exit(1);
});
