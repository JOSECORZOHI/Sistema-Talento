// ============================================================
//  crypto.js — Cifrado a nivel de aplicación (AES-256-GCM)
//  para documentos que contienen datos sensibles (Ley 1581/2012, art. 5-7).
//  Los datos sensibles (salud, seguridad social) se cifran en reposo (at-rest)
//  de modo que no queden en claro en GridFS.
// ============================================================

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
// Formato en disco: [16B auth tag][12B IV][ciphertext]
const OVERHEAD = TAG_LEN + IV_LEN;

let warned = false;

// Clave de cifrado de 32 bytes, leída de DOC_ENC_KEY (base64 de 32 bytes).
// En PRODUCCIÓN (NODE_ENV=production) es OBLIGATORIA: si no está configurada
// correctamente, getKey() lanza para impedir cifrar con un fallback inseguro
// (fail-fast de seguridad). Fuera de producción se permite un fallback derivado
// de JWT_SECRET (nunca una clave hardcodeada).
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function getKey() {
  const fromEnv = process.env.DOC_ENC_KEY;
  if (fromEnv && fromEnv.trim()) {
    const b = Buffer.from(fromEnv.trim(), 'base64');
    if (b.length === 32) return b;
    if (IS_PRODUCTION) {
      throw new Error('DOC_ENC_KEY debe ser una cadena base64 de exactamente 32 bytes (node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").');
    }
    console.warn('[CRYPTO] DOC_ENC_KEY no tiene 32 bytes válidos; se usa el fallback derivado de JWT_SECRET (solo fuera de producción).');
  } else if (IS_PRODUCTION) {
    throw new Error('DOC_ENC_KEY no está configurada. Es OBLIGATORIA en producción para el cifrado de documentos sensibles (Ley 1581/2012). Genérela con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  if (!warned) {
    warned = true;
    console.warn('[CRYPTO] DOC_ENC_KEY no configurada. Se cifra usando una clave derivada de JWT_SECRET (fallback SOLO fuera de producción).');
  }
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'dev-only-insecure-fallback-key').digest();
}

// Validación al arranque: en producción, lanza si DOC_ENC_KEY no está bien definida.
function assertEncryptionKey() {
  getKey();
}

function encryptBuffer(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([tag, iv, enc]);
}

function decryptBuffer(data) {
  if (!data || data.length < OVERHEAD) {
    throw new Error('Datos cifrados inválidos o incompletos.');
  }
  const key = getKey();
  const tag = data.subarray(0, TAG_LEN);
  const iv = data.subarray(TAG_LEN, TAG_LEN + IV_LEN);
  const enc = data.subarray(TAG_LEN + IV_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function genKey() {
  return crypto.randomBytes(32).toString('base64');
}

module.exports = { encryptBuffer, decryptBuffer, genKey, getKey, assertEncryptionKey };
