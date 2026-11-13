'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'sec-remediations-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const ADMIN_EMAIL = 'admin-sec@test.local';

const adminDoc = {
  _id: 'admin-sec-1',
  id: 'admin-sec-1',
  email: ADMIN_EMAIL,
  name: 'Admin Seguridad',
  role: 'admin',
  status: 'activa',
  active: true,
  jwtVersion: 0,
  mustChangePassword: false,
  totpEnabled: false
};

const docRecord = {
  _id: 'doc-1',
  id: 'doc-1',
  filename: 'acta_posesion_123.pdf',
  employeeName: 'Juan Perez',
  employeeId: '1065000111',
  status: 'Activo'
};

const empRecord = {
  _id: 'emp-sec-1',
  id: '1065000999',
  name: 'Carlos Ruiz',
  email: 'carlos.ruiz@test.local',
  status: 'activa',
  active: true
};

const auditLogEntries = [];
const securityLogEntries = [];

const fakeDb = {
  connect: async () => {},
  col: (name) => ({
    findOne: async (filter = {}) => {
      const email = filter.email && filter.email.toLowerCase();
      if (name === 'users' && email === ADMIN_EMAIL) return adminDoc;
      if (name === 'employees' && (filter.id === empRecord.id || email === empRecord.email)) return empRecord;
      if (name === 'documents' && filter.id === 'doc-1') return docRecord;
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
    insertOne: async (doc) => {
      if (name === 'auditLogs') auditLogEntries.push(doc);
      if (name === 'securityLogs') securityLogEntries.push(doc);
      return { insertedId: 'fake-id' };
    },
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
const { encryptBuffer, decryptBuffer } = require('../lib/crypto');

function cookieFor(email, role) {
  const token = jwt.sign(
    { email, name: email, role, v: 0 },
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

test('SEC-01: DELETE /api/employees/:id no re-expone la cédula (PII) en logs de auditoría ni seguridad', async () => {
  adminDoc.totpEnabled = true;
  auditLogEntries.length = 0;
  securityLogEntries.length = 0;

  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl + `/api/employees/${empRecord.id}`, {
      method: 'DELETE',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(res.status, 200);

    const auditDeleted = auditLogEntries.find(e => e.action === 'Eliminar Empleado');
    assert.ok(auditDeleted, 'Debe existir registro en auditLogs');
    assert.equal(auditDeleted.details.includes(empRecord.id), false, 'Audit log no debe contener la cédula');
    assert.match(auditDeleted.details, /\[SUPRIMIDO\]/);

    const secDeleted = securityLogEntries.find(e => e.event === 'Empleado Eliminado');
    assert.ok(secDeleted, 'Debe existir registro en securityLogs');
    assert.equal(secDeleted.details.includes(empRecord.id), false, 'Security log no debe contener la cédula');
    assert.match(secDeleted.details, /\[SUPRIMIDO\]/);
  });
});

test('SEC-02: DELETE /api/documents/:id?deletePhysical=true rechaza eliminación física directa (403 doble control)', async () => {
  adminDoc.totpEnabled = true;
  await withServer(async (baseUrl) => {
    const res = await fetch(baseUrl + '/api/documents/doc-1?deletePhysical=true', {
      method: 'DELETE',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(res.status, 403);
    const data = await res.json();
    assert.match(data.error, /doble control/i);
  });
});

test('SEC-03: Cifrado y descifrado de respaldo en reposo con AES-256-GCM', () => {
  const dummyBackup = Buffer.from('MONGODB DUMP TAR GZ MOCK CONTENT WITH SENSITIVE PII');
  const encrypted = encryptBuffer(dummyBackup);
  assert.notDeepEqual(encrypted, dummyBackup);
  // Overhead de autenticación (16B tag + 12B IV = 28B)
  assert.equal(encrypted.length, dummyBackup.length + 28);
  const decrypted = decryptBuffer(encrypted);
  assert.deepEqual(decrypted, dummyBackup);
});

test('SEC-04: Exigencia de 2FA para admin cuando REQUIRE_ADMIN_2FA=true', async () => {
  process.env.REQUIRE_ADMIN_2FA = 'true';
  adminDoc.totpEnabled = false;

  await withServer(async (baseUrl) => {
    // 1. Acceso a ruta administrativa restringida debe retornar 403 mustSetup2FA
    const resAdminRoute = await fetch(baseUrl + '/api/employees', {
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resAdminRoute.status, 403);
    const dataAdminRoute = await resAdminRoute.json();
    assert.equal(dataAdminRoute.mustSetup2FA, true);

    // 2. /api/auth/me debe permitirse y reportar mustSetup2FA: true
    const resMe = await fetch(baseUrl + '/api/auth/me', {
      headers: {
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resMe.status, 200);
    const dataMe = await resMe.json();
    assert.equal(dataMe.user.mustSetup2FA, true);

    // 3. /api/auth/2fa/status y /api/auth/2fa/setup deben permitirse
    const res2faStatus = await fetch(baseUrl + '/api/auth/2fa/status', {
      headers: {
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(res2faStatus.status, 200);

    // 4. Intentar desactivar 2FA siendo admin con 2FA activo debe responder 403
    adminDoc.totpEnabled = true;
    const resDisable = await fetch(baseUrl + '/api/auth/2fa/disable', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      },
      body: JSON.stringify({ code: '123456' })
    });
    assert.equal(resDisable.status, 403);
    const dataDisable = await resDisable.json();
    assert.match(dataDisable.error, /obligatoria para administradores/i);

    // 5. Con 2FA habilitado, la ruta administrativa debe permitir acceso (200)
    const resAdminEnabled = await fetch(baseUrl + '/api/employees', {
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resAdminEnabled.status, 200);
  });

  delete process.env.REQUIRE_ADMIN_2FA;
});

test('SEC-05: REQUIRE_ADMIN_2FA=false en producción permite bypass administrativo y setup devuelve qrSvg', async () => {
  const origNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.REQUIRE_ADMIN_2FA = 'false';
  adminDoc.totpEnabled = false;

  await withServer(async (baseUrl) => {
    // 1. Acceso a ruta administrativa debe permitirse (200) debido al bypass
    const resAdminRoute = await fetch(baseUrl + '/api/employees', {
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resAdminRoute.status, 200);

    // 2. /api/auth/2fa/setup devuelve secret, otpauth y qrSvg
    const resSetup = await fetch(baseUrl + '/api/auth/2fa/setup', {
      method: 'POST',
      headers: {
        'x-requested-with': 'XMLHttpRequest',
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resSetup.status, 200);
    const dataSetup = await resSetup.json();
    assert.ok(dataSetup.secret);
    assert.ok(dataSetup.otpauth);
    assert.ok(dataSetup.qrSvg && dataSetup.qrSvg.includes('<svg'));
    // 3. /api/auth/me no debe exigir mustSetup2FA bajo el bypass
    const resMe = await fetch(baseUrl + '/api/auth/me', {
      headers: {
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resMe.status, 200);
    const dataMe = await resMe.json();
    assert.equal(dataMe.user.mustSetup2FA, undefined);

    // 4. /api/auth/2fa/status debe indicar required: false
    const resStatus = await fetch(baseUrl + '/api/auth/2fa/status', {
      headers: {
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resStatus.status, 200);
    const dataStatus = await resStatus.json();
    assert.equal(dataStatus.required, false);
  });

  process.env.NODE_ENV = origNodeEnv;
  delete process.env.REQUIRE_ADMIN_2FA;
});

test('SEC-06: En desarrollo sin REQUIRE_ADMIN_2FA, 2FA no es obligatorio para admin', async () => {
  const origNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  delete process.env.REQUIRE_ADMIN_2FA;
  adminDoc.totpEnabled = false;

  await withServer(async (baseUrl) => {
    const resMe = await fetch(baseUrl + '/api/auth/me', {
      headers: {
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resMe.status, 200);
    const dataMe = await resMe.json();
    assert.equal(dataMe.user.mustSetup2FA, undefined);

    const resStatus = await fetch(baseUrl + '/api/auth/2fa/status', {
      headers: {
        Cookie: cookieFor(ADMIN_EMAIL, 'admin')
      }
    });
    assert.equal(resStatus.status, 200);
    const dataStatus = await resStatus.json();
    assert.equal(dataStatus.required, false);
  });

  process.env.NODE_ENV = origNodeEnv;
});

