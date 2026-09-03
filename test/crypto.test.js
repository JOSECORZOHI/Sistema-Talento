'use strict';

// Tests de unidad del cifrado en reposo (lib/crypto.js).
// Verifica round-trip (cifrar->descifrar), fallo ante clave incorrecta y
// fail-fast de DOC_ENC_KEY en producción (Ley 1581/2012).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const cryptoLib = require('../lib/crypto');

// Ejecuta una función con un DOC_ENC_KEY temporal y restaura el entorno.
function withKey(key, fn) {
  const prev = process.env.DOC_ENC_KEY;
  try {
    process.env.DOC_ENC_KEY = key;
    return fn();
  } finally {
    if (prev === undefined) delete process.env.DOC_ENC_KEY;
    else process.env.DOC_ENC_KEY = prev;
  }
}

test('encrypt/decrypt round-trip preserva el contenido', () => {
  const key = cryptoLib.genKey();
  const plain = Buffer.from('Documento con datos personales de prueba', 'utf8');
  withKey(key, () => {
    const enc = cryptoLib.encryptBuffer(plain);
    const dec = cryptoLib.decryptBuffer(enc);
    assert.equal(dec.toString('utf8'), plain.toString('utf8'));
  });
});

test('cifrados del mismo contenido difieren (IV aleatorio / nonce)', () => {
  const key = cryptoLib.genKey();
  const plain = Buffer.from('mismo contenido', 'utf8');
  withKey(key, () => {
    const a = cryptoLib.encryptBuffer(plain);
    const b = cryptoLib.encryptBuffer(plain);
    assert.notEqual(a.toString('hex'), b.toString('hex'));
  });
});

test('descifrar con clave incorrecta lanza error', () => {
  const keyA = cryptoLib.genKey();
  const keyB = cryptoLib.genKey();
  assert.notEqual(keyA, keyB);
  const enc = withKey(keyA, () => cryptoLib.encryptBuffer(Buffer.from('secreto', 'utf8')));
  assert.throws(() => withKey(keyB, () => cryptoLib.decryptBuffer(enc)), /auth|decrypt|EVP/i);
});

// El módulo lee NODE_ENV al cargarlo (modo producción se fija en el arranque).
// Para simular un arranque en producción, se recarga el módulo con el env deseado.
function loadWithEnv(env) {
  const prevEnv = process.env.NODE_ENV;
  const prevKey = process.env.DOC_ENC_KEY;
  try {
    process.env.NODE_ENV = env;
    delete require.cache[require.resolve('../lib/crypto')];
    return require('../lib/crypto');
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevKey === undefined) delete process.env.DOC_ENC_KEY;
    else process.env.DOC_ENC_KEY = prevKey;
  }
}

test('assertEncryptionKey lanza en producción cuando DOC_ENC_KEY falta/incorrecta', () => {
  // Sin clave
  delete process.env.DOC_ENC_KEY;
  const noKey = loadWithEnv('production');
  assert.throws(() => noKey.assertEncryptionKey(), /DOC_ENC_KEY/i);
  // Clave que no es base64 de 32 bytes
  process.env.DOC_ENC_KEY = 'clave-invalida';
  const badKey = loadWithEnv('production');
  assert.throws(() => badKey.assertEncryptionKey(), /DOC_ENC_KEY/i);
  // Clave válida (32 bytes base64)
  process.env.DOC_ENC_KEY = crypto.randomBytes(32).toString('base64');
  const goodKey = loadWithEnv('production');
  assert.doesNotThrow(() => goodKey.assertEncryptionKey());
});

test('fuera de producción, sin DOC_ENC_KEY se usa fallback (no lanza)', () => {
  delete process.env.DOC_ENC_KEY;
  const dev = loadWithEnv('development');
  assert.doesNotThrow(() => dev.assertEncryptionKey());
});