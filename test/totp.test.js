'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const totp = require('../lib/totp');

test('totp: RFC 6238 SHA1 test vector (secret ASCII "12345678901234567890")', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii').toString('base64');
  // El vector oficial usa la clave raw; reconstruimos el Base32 de esa clave.
  const base32 = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  assert.equal(base32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

  // Timestamps del Apéndice B (TOTP RFC 6238): 59s, 1111111109s, 1234567890s, 2000000000s
  const cases = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037']
  ];
  for (const [timeSeconds, expected] of cases) {
    const timeMs = timeSeconds * 1000;
    assert.equal(totp.generateTOTP(base32, { time: timeMs }), expected);
    assert.equal(totp.verifyTOTP(base32, expected, { time: timeMs }), true);
  }
});

test('totp: verifyTOTP rechaza códigos inválidos', () => {
  const secret = totp.generateSecret();
  const code = totp.generateTOTP(secret);
  assert.equal(totp.verifyTOTP(secret, code), true);
  assert.equal(totp.verifyTOTP(secret, '999999'), false);
  assert.equal(totp.verifyTOTP(secret, '12345'), false);
  assert.equal(totp.verifyTOTP(secret, 'abcdef'), false);
  assert.equal(totp.verifyTOTP(secret, ''), false);
  assert.equal(totp.verifyTOTP('', '123456'), false);
});

test('totp: tolera ±1 paso de ventana (drift de reloj)', () => {
  const secret = totp.generateSecret();
  const time = Date.now();
  const code = totp.generateTOTP(secret, { time });
  // Código del paso anterior debe seguir siendo válido
  assert.equal(totp.verifyTOTP(secret, code, { time: time - 35 * 1000 }), true);
  // Más de una ventana hacia atrás ya no
  assert.equal(totp.verifyTOTP(secret, code, { time: time - 70 * 1000 }), false);
});

test('totp: base32 encode/decode roundtrip', () => {
  const buf = Buffer.from([0, 1, 2, 3, 200, 255, 64, 33]);
  const enc = totp.base32Encode(buf);
  const dec = totp.base32Decode(enc);
  assert.ok(enc.match(/^[A-Z2-7]+$/));
  assert.deepEqual(dec, buf);
});

test('totp: buildOtpauthURL incluye secret e issuer codificados', () => {
  const url = totp.buildOtpauthURL({ issuer: 'Sistema Talento Humano', account: 'admin@example.com', secret: 'ABCDEFGHIJKLMNOP' });
  assert.ok(url.startsWith('otpauth://totp/'));
  assert.ok(url.includes('secret=ABCDEFGHIJKLMNOP'));
  assert.ok(url.includes('issuer='));
  assert.ok(url.includes('period=30'));
  assert.ok(url.includes('digits=6'));
});