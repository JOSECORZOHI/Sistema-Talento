'use strict';

// Prueba de la guarda de reconfiguración de 2FA:
//   si la cuenta YA tiene 2FA activo, POST /api/auth/2fa/enable exige un código
//   vigente del secreto actual antes de reemplazarlo. Así una sesión robada no
//   puede registrar un autenticador nuevo.
// La capa de base de datos se sustituye por un doble en require.cache y la
// sesión se firma directamente (el login con 2FA activo exigiría el código).

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-2fa-test-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const { generateSecret, generateTOTP } = require('../lib/totp');

const TEST_EMAIL = 'admin@test.local';
const OLD_SECRET = generateSecret();
const NEW_SECRET = generateSecret();

const adminDoc = {
  _id: 'admin-1',
  id: 'admin-1',
  email: TEST_EMAIL,
  name: 'Admin de Prueba',
  department: 'Sistemas',
  password: null,
  role: 'admin',
  status: 'activa',
  active: true,
  totpEnabled: false,
  totpSecret: null,
  jwtVersion: 0,
  mustChangePassword: false
};

function fakeCollection(name) {
  return {
    findOne: async (filter = {}) => {
      if (filter.email && filter.email.toLowerCase() === TEST_EMAIL) return adminDoc;
      return null;
    },
    findOneAndDelete: async () => null,
    findOneAndUpdate: async () => null,
    updateOne: async () => ({ modifiedCount: 1 }),
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    deleteOne: async () => ({ deletedCount: 0 }),
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

function authCookie() {
  const token = jwt.sign(
    { email: TEST_EMAIL, name: 'Admin de Prueba', role: 'admin', v: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '1h', algorithm: 'HS256' }
  );
  return 'th_token=' + token;
}

async function withServer(fn) {
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    await fn(baseUrl, authCookie());
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
  }
}

function enable(baseUrl, cookie, payload) {
  return fetch(baseUrl + '/api/auth/2fa/enable', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie },
    body: JSON.stringify(payload)
  });
}

test('2fa/enable rechaza reconfigurar 2FA activo sin código actual (400)', async () => {
  adminDoc.totpEnabled = true;
  adminDoc.totpSecret = OLD_SECRET;
  await withServer(async (baseUrl, cookie) => {
    const res = await enable(baseUrl, cookie, { secret: NEW_SECRET, code: generateTOTP(NEW_SECRET) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /2FA activo/i);
  });
});

test('2fa/enable rechaza reconfigurar con código actual incorrecto (401)', async () => {
  adminDoc.totpEnabled = true;
  adminDoc.totpSecret = OLD_SECRET;
  await withServer(async (baseUrl, cookie) => {
    const res = await enable(baseUrl, cookie, { secret: NEW_SECRET, code: generateTOTP(NEW_SECRET), currentCode: '000000' });
    assert.equal(res.status, 401);
  });
});

test('2fa/enable permite reconfigurar con un código vigente del secreto actual', async () => {
  adminDoc.totpEnabled = true;
  adminDoc.totpSecret = OLD_SECRET;
  await withServer(async (baseUrl, cookie) => {
    const res = await enable(baseUrl, cookie, {
      secret: NEW_SECRET,
      code: generateTOTP(NEW_SECRET),
      currentCode: generateTOTP(OLD_SECRET)
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).enabled, true);
  });
});

test('2fa/enable activa sin código actual cuando 2FA está desactivado', async () => {
  adminDoc.totpEnabled = false;
  adminDoc.totpSecret = null;
  await withServer(async (baseUrl, cookie) => {
    const res = await enable(baseUrl, cookie, { secret: NEW_SECRET, code: generateTOTP(NEW_SECRET) });
    assert.equal(res.status, 200);
  });
});
