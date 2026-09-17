'use strict';

// Prueba de integración del flujo de sesión con cookie httpOnly:
//   POST /api/auth/login  -> 200 + Set-Cookie th_token (httpOnly)
//   GET  /api/auth/me     -> 200 usando SOLO la cookie
// La capa de base de datos se sustituye por un doble en require.cache para no
// tocar Atlas ni requerir red.

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-login-test-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const TEST_EMAIL = 'admin@test.local';
const TEST_PASSWORD = 'ClaveSegura123!';

const adminDoc = {
  _id: 'admin-1',
  id: 'admin-1',
  email: TEST_EMAIL,
  name: 'Admin de Prueba',
  department: 'Sistemas',
  password: bcrypt.hashSync(TEST_PASSWORD, 4),
  role: 'admin',
  status: 'activa',
  active: true,
  totpEnabled: false,
  totpSecret: null,
  jwtVersion: 0,
  failedAttempts: 0,
  lockedUntil: null,
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
    updateOne: async () => ({ modifiedCount: 0 }),
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

test('login emite cookie httpOnly y /api/auth/me autentica con la cookie', async () => {
  const srv = app.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    // Sin cookie, la ruta protegida responde 401.
    const meAnon = await fetch(baseUrl + '/api/auth/me');
    assert.equal(meAnon.status, 401);

    const login = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: TEST_EMAIL, password: TEST_PASSWORD })
    });
    assert.equal(login.status, 200);
    const body = await login.json();
    assert.ok(body.user && body.user.email === TEST_EMAIL);
    // El JWT ya NO se expone en el cuerpo (no es legible por JavaScript).
    assert.equal(body.token, undefined);

    const setCookie = login.headers.get('set-cookie') || '';
    assert.match(setCookie, /th_token=/);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);

    const cookiePair = setCookie.split(';')[0];

    // La cookie sola autentica la ruta protegida.
    const me = await fetch(baseUrl + '/api/auth/me', { headers: { Cookie: cookiePair } });
    assert.equal(me.status, 200);
    const meBody = await me.json();
    assert.equal(meBody.user.email, TEST_EMAIL);
    assert.equal(meBody.user.role, 'admin');
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
  }
});
