'use strict';

// Regresión del bug donde `validateBody(twoFactorEnableSchema)` purgaba el
// campo `challenge` (zod strip) y `POST /api/auth/2fa/verify` respondía 400
// siempre, rompiendo el login con 2FA. Cubre: intercambio challenge→sesión,
// código incorrecto, challenge ausente/desconocido/reutilizado y expirado.
// La capa de base de datos se sustituye por un doble en require.cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-2fa-verify-test-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const { generateSecret, generateTOTP } = require('../lib/totp');

const TEST_EMAIL = 'admin-2fa@test.local';
const TEST_SECRET = generateSecret();
const CHALLENGE = 'reto-de-prueba-2fa';
const challengeHash = (c) => crypto.createHash('sha256').update(c).digest('hex');

const adminDoc = {
  _id: 'admin-2fa-1',
  id: 'admin-2fa-1',
  email: TEST_EMAIL,
  name: 'Admin 2FA',
  department: 'Sistemas',
  role: 'admin',
  status: 'activa',
  active: true,
  totpEnabled: true,
  totpSecret: TEST_SECRET,
  jwtVersion: 0,
  mustChangePassword: false
};

// Retos de un solo uso en memoria (imita findOneAndDelete atómico).
let challenges;
function resetChallenges() {
  challenges = new Map();
  challenges.set(challengeHash(CHALLENGE), {
    tokenHash: challengeHash(CHALLENGE),
    email: TEST_EMAIL,
    role: 'admin',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000)
  });
}
resetChallenges();

function fakeCollection(name) {
  return {
    findOne: async (filter = {}) => {
      if (filter.email && String(filter.email).toLowerCase() === TEST_EMAIL) return adminDoc;
      if (filter.tokenHash && challenges.has(filter.tokenHash)) return challenges.get(filter.tokenHash);
      return null;
    },
    findOneAndDelete: async (filter = {}) => {
      const doc = challenges.get(filter.tokenHash) || null;
      if (doc) challenges.delete(filter.tokenHash);
      return doc;
    },
    findOneAndUpdate: async () => null,
    updateOne: async (filter = {}, update = {}) => {
      if (filter.tokenHash && challenges.has(filter.tokenHash) && update.$inc && update.$inc.attempts) {
        const c = challenges.get(filter.tokenHash);
        c.attempts = (c.attempts || 0) + update.$inc.attempts;
      }
      return { modifiedCount: 1 };
    },
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    deleteOne: async (filter = {}) => {
      if (filter.tokenHash && challenges.delete(filter.tokenHash)) return { deletedCount: 1 };
      return { deletedCount: 0 };
    },
    insertOne: async () => ({ insertedId: 'fake-id' }),
    countDocuments: async () => (name === 'users' ? 1 : 0),
    indexes: async () => [],
    createIndex: async () => 'fake-index',
    distinct: async () => [],
    aggregate: () => ({ toArray: async () => [] }),
    find: () => ({ sort: () => ({ toArray: async () => [], limit: () => ({ toArray: async () => [] }) }), toArray: async () => [], limit: () => ({ toArray: async () => [] }) })
  };
}

const fakeDb = {
  connect: async () => {},
  col: fakeCollection,
  isHealthy: () => true,
  reconnect: async () => true,
  closeDb: async () => {},
  storeFileBuffer: async () => ({}),
  readFileStream: () => null,
  readFileBuffer: async () => Buffer.alloc(0),
  deleteFileByName: async () => {},
  listFilesBySource: async () => [],
  markFileRegistered: async () => {},
  generateTempPassword: () => 'Temporal123!'
};

const dbPath = require.resolve('../db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb, children: [], paths: [] };

const { app } = require('../server');

async function withServer(fn) {
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
  }
}

function verify(baseUrl, payload) {
  return fetch(baseUrl + '/api/auth/2fa/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(payload)
  });
}

test('2fa/verify intercambia challenge vigente + código válido por sesión (200)', async () => {
  resetChallenges();
  await withServer(async (baseUrl) => {
    const res = await verify(baseUrl, { challenge: CHALLENGE, code: generateTOTP(TEST_SECRET) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.email, TEST_EMAIL);
    assert.equal(body.user.role, 'admin');
    assert.match(res.headers.get('set-cookie') || '', /th_token=/);
  });
});

test('2fa/verify rechaza challenge ausente (400 de esquema)', async () => {
  resetChallenges();
  await withServer(async (baseUrl) => {
    const res = await verify(baseUrl, { code: generateTOTP(TEST_SECRET) });
    assert.equal(res.status, 400);
  });
});

test('2fa/verify rechaza código incorrecto (401)', async () => {
  resetChallenges();
  await withServer(async (baseUrl) => {
    const res = await verify(baseUrl, { challenge: CHALLENGE, code: '000000' });
    assert.equal(res.status, 401);
  });
});

test('2fa/verify rechaza challenge desconocido o reutilizado (400)', async () => {
  resetChallenges();
  await withServer(async (baseUrl) => {
    const bad = await verify(baseUrl, { challenge: 'inexistente', code: generateTOTP(TEST_SECRET) });
    assert.equal(bad.status, 400);
    const first = await verify(baseUrl, { challenge: CHALLENGE, code: generateTOTP(TEST_SECRET) });
    assert.equal(first.status, 200);
    await first.json().catch(() => null);
    const second = await verify(baseUrl, { challenge: CHALLENGE, code: generateTOTP(TEST_SECRET) });
    assert.equal(second.status, 400);
  });
});

test('2fa/verify rechaza challenge expirado (400)', async () => {
  resetChallenges();
  challenges.get(challengeHash(CHALLENGE)).expiresAt = new Date(Date.now() - 1000);
  await withServer(async (baseUrl) => {
    const res = await verify(baseUrl, { challenge: CHALLENGE, code: generateTOTP(TEST_SECRET) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /expir/i);
  });
});

test('2fa/verify no quema el challenge con un código incorrecto (401 y luego 200)', async () => {
  resetChallenges();
  await withServer(async (baseUrl) => {
    const wrong = await verify(baseUrl, { challenge: CHALLENGE, code: '000000' });
    assert.equal(wrong.status, 401);
    const ok = await verify(baseUrl, { challenge: CHALLENGE, code: generateTOTP(TEST_SECRET) });
    assert.equal(ok.status, 200);
  });
});

test('2fa/verify invalida el challenge tras 5 intentos fallidos', async () => {
  resetChallenges();
  challenges.get(challengeHash(CHALLENGE)).attempts = 4;
  await withServer(async (baseUrl) => {
    const last = await verify(baseUrl, { challenge: CHALLENGE, code: '000000' });
    assert.equal(last.status, 401);
    assert.match((await last.json()).error, /Demasiados intentos/i);
    const after = await verify(baseUrl, { challenge: CHALLENGE, code: generateTOTP(TEST_SECRET) });
    assert.equal(after.status, 400);
  });
});
