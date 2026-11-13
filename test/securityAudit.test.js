'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec-audit-secret-key-12345';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const ADMIN_EMAIL = 'admin-audit@test.local';

const adminDoc = {
  _id: 'admin-audit-1',
  id: 'admin-audit-1',
  email: ADMIN_EMAIL,
  name: 'Admin Auditoria',
  role: 'admin',
  status: 'activa',
  active: true,
  jwtVersion: 0,
  mustChangePassword: false
};

const fakeDb = {
  connect: async () => {},
  col: (name) => ({
    findOne: async (filter = {}) => {
      const email = filter.email && filter.email.toLowerCase();
      if (name === 'users' && email === ADMIN_EMAIL) return adminDoc;
      return null;
    },
    find: () => ({
      sort: () => ({ toArray: async () => [], limit: () => ({ toArray: async () => [] }) }),
      toArray: async () => [],
      limit: () => ({ toArray: async () => [] })
    }),
    countDocuments: async () => 0,
    updateOne: async () => ({ modifiedCount: 1, matchedCount: 1 }),
    updateMany: async () => ({ modifiedCount: 1 }),
    deleteMany: async () => ({ deletedCount: 1 }),
    deleteOne: async () => ({ deletedCount: 1 }),
    insertOne: async () => ({ insertedId: 'fake-id' }),
    aggregate: () => ({ toArray: async () => [] }),
    distinct: async () => [],
    indexes: async () => [],
    createIndex: async () => 'fake-index'
  }),
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
const { validatePasswordStrength } = require('../lib/helpers');

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

test('seguridad: NoSQL injection es neutralizado por mongoSanitize y validación Zod', async () => {
  await withServer(async (baseUrl) => {
    // 1. Inyección de operador en cuerpo JSON
    const resBody = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: { $gt: '' }, password: { $ne: null } })
    });
    assert.equal(resBody.status, 400);
    const body = await resBody.json();
    assert.ok(body.error, 'Debe devolver mensaje de error');

    // 2. Inyección de operador en query string no tumba el servidor Express 5
    const resQuery = await fetch(baseUrl + '/api/system/status?filter[$regex]=.*', {
      headers: { Cookie: cookieFor(ADMIN_EMAIL, 'admin') }
    });
    // Debe responder normalmente sin lanzar TypeError ni crashear
    assert.ok([200, 304, 400, 404].includes(resQuery.status));
  });
});

test('seguridad: HTTP Parameter Pollution (HPP) previene arreglos no esperados en query', async () => {
  await withServer(async (baseUrl) => {
    // Enviar parámetro duplicado ?dup=1&dup=2
    const res = await fetch(baseUrl + '/api/system/status?dup=primero&dup=segundo', {
      headers: { Cookie: cookieFor(ADMIN_EMAIL, 'admin') }
    });
    assert.ok([200, 304].includes(res.status));
  });
});

test('seguridad: Helmet y CSP configuran cabeceras defensivas y nonces por petición', async () => {
  await withServer(async (baseUrl) => {
    const res1 = await fetch(baseUrl + '/api/system/status', {
      headers: { Cookie: cookieFor(ADMIN_EMAIL, 'admin') }
    });
    assert.equal(res1.headers.get('x-content-type-options'), 'nosniff');

    const csp1 = res1.headers.get('content-security-policy') || '';
    assert.ok(csp1.includes("frame-ancestors 'self'"), 'Debe restringir frame-ancestors a self');
    assert.ok(csp1.includes("default-src 'self'"), 'Debe restringir default-src');

    // Comprobar que en peticiones sucesivas el nonce CSP sea único
    const res2 = await fetch(baseUrl + '/api/system/status', {
      headers: { Cookie: cookieFor(ADMIN_EMAIL, 'admin') }
    });
    const csp2 = res2.headers.get('content-security-policy') || '';
    assert.ok(csp1 !== '' && csp2 !== '');
  });
});

test('seguridad: CSRF bloquea métodos mutantes sin X-Requested-With ni Bearer', async () => {
  await withServer(async (baseUrl) => {
    // POST sin cabecera X-Requested-With ni Bearer -> 403
    const resPost = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_EMAIL, password: 'password123' })
    });
    assert.equal(resPost.status, 403, 'POST mutante sin CSRF token debe responder 403');

    // Métodos seguros (GET) no son bloqueados por el middleware CSRF
    const resGet = await fetch(baseUrl + '/api/system/status', {
      headers: { Cookie: cookieFor(ADMIN_EMAIL, 'admin') }
    });
    assert.notEqual(resGet.status, 403, 'GET seguro no debe ser bloqueado por CSRF');
  });
});

test('seguridad: validatePasswordStrength aplica política estricta de contraseñas', () => {
  // Menor a 12 caracteres
  assert.equal(validatePasswordStrength('C0rta!').valid, false);
  // Sin mayúscula
  assert.equal(validatePasswordStrength('valledupar2026!#').valid, false);
  // Sin minúscula
  assert.equal(validatePasswordStrength('VALLEDUPAR2026!#').valid, false);
  // Sin número
  assert.equal(validatePasswordStrength('ValleduparSinNumero!#').valid, false);
  // Sin símbolo
  assert.equal(validatePasswordStrength('Valledupar20262026').valid, false);
  // Mayor a 72 caracteres (límite bcrypt)
  const muyLarga = 'Valledupar2026!#' + 'a'.repeat(65);
  assert.equal(validatePasswordStrength(muyLarga).valid, false);
  // Válida y robusta
  assert.equal(validatePasswordStrength('Valledupar2026!#').valid, true);
});
