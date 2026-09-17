'use strict';

// Pruebas de integración de rutas con la BD sustituida por un doble en
// require.cache: se validan los controles transversales de seguridad
// (autenticación, CSRF, RBAC, 404 JSON) y que el estado de Gmail lea el token
// de la colección config en vez del navegador.

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'routes-test-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';
process.env.GMAIL_CLIENT_ID = 'test-client-id';
process.env.GMAIL_CLIENT_SECRET = 'test-client-secret';
process.env.GMAIL_REDIRECT_URI = 'http://localhost/callback';
process.env.GMAIL_REFRESH_TOKEN = '';

const ADMIN_EMAIL = 'admin@test.local';
const FUNC_EMAIL = 'funcionario@test.local';

const adminDoc = {
  _id: 'admin-1', id: 'admin-1', email: ADMIN_EMAIL, name: 'Admin',
  role: 'admin', status: 'activa', active: true, jwtVersion: 0, mustChangePassword: false
};
const funcionarioDoc = {
  _id: 'emp-1', id: 'emp-1', email: FUNC_EMAIL, name: 'Funcionario',
  role: 'funcionario', status: 'activa', active: true, jwtVersion: 0, mustChangePassword: false
};

const configState = { token: 'token-desde-bd' };

function fakeCollection(name) {
  return {
    findOne: async (filter = {}) => {
      if (name === 'config') {
        return configState.token ? { key: 'gmailAdmin', refreshToken: configState.token } : null;
      }
      const email = filter.email && filter.email.toLowerCase();
      if (name === 'users' && email === ADMIN_EMAIL) return adminDoc;
      if (name === 'employees' && email === FUNC_EMAIL) return funcionarioDoc;
      return null;
    },
    find: () => ({
      sort: () => ({ toArray: async () => [], limit: () => ({ toArray: async () => [] }) }),
      toArray: async () => [],
      limit: () => ({ toArray: async () => [] })
    }),
    countDocuments: async () => 0,
    updateOne: async () => ({ modifiedCount: 0, matchedCount: 0 }),
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
    insertOne: async () => ({ insertedId: 'fake' }),
    aggregate: () => ({ toArray: async () => [] }),
    distinct: async () => [],
    indexes: async () => [],
    createIndex: async () => 'fake-index'
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

function cookieFor(email, role, extra = {}) {
  const token = jwt.sign(
    { email, name: email, role, v: 0, ...extra },
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
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => {
      srv.close(resolve);
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
    });
  }
}

test('rutas protegidas responden 401 sin cookie', async () => {
  await withServer(async (baseUrl) => {
    for (const path of ['/api/auth/me', '/api/employees', '/api/documents/unregistered']) {
      const res = await fetch(baseUrl + path);
      assert.equal(res.status, 401, `${path} debe ser 401`);
    }
  });
});

test('CSRF: POST mutante sin X-Requested-With responde 403', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl + '/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieFor(ADMIN_EMAIL, 'admin') },
      body: JSON.stringify({})
    });
    assert.equal(res.status, 403);
  });
});

test('RBAC: un funcionario no accede a rutas de administrador (403)', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl + '/api/employees', {
      headers: { Cookie: cookieFor(FUNC_EMAIL, 'funcionario', { employeeId: 'emp-1' }) }
    });
    assert.equal(res.status, 403);
  });
});

test('una ruta API inexistente responde 404 JSON', async () => {
  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl + '/api/ruta-inexistente', {
      headers: { Cookie: cookieFor(ADMIN_EMAIL, 'admin') }
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error);
  });
});

test('gmail/status marca authenticated según el token guardado en BD', async () => {
  await withServer(async (baseUrl) => {
    const cookie = cookieFor(ADMIN_EMAIL, 'admin');
    configState.token = 'token-desde-bd';
    const on = await fetch(baseUrl + '/api/gmail/status', { headers: { Cookie: cookie } });
    assert.equal(on.status, 200);
    const onBody = await on.json();
    assert.equal(onBody.configured, true);
    assert.equal(onBody.authenticated, true);

    configState.token = null;
    const off = await fetch(baseUrl + '/api/gmail/status', { headers: { Cookie: cookie } });
    assert.equal((await off.json()).authenticated, false);
  });
});
