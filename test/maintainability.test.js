'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'maintainability-test-secret-12345';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const fakeDb = {
  connect: async () => {},
  col: () => ({
    findOne: async () => null,
    find: () => ({
      sort: () => ({ toArray: async () => [], limit: () => ({ toArray: async () => [] }) }),
      toArray: async () => [],
      limit: () => ({ toArray: async () => [] })
    }),
    countDocuments: async () => 0,
    updateOne: async () => ({ modifiedCount: 0 }),
    updateMany: async () => ({ modifiedCount: 0 }),
    deleteMany: async () => ({ deletedCount: 0 }),
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
const { z, validateBody } = require('../lib/validate');
const { scrubText } = require('../lib/logScrub');
const { escapeHtml, normalizeEmail } = require('../lib/helpers');

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

function withProductionEnv(key, fn) {
  const prevEnv = process.env.NODE_ENV;
  const prevKey = process.env.DOC_ENC_KEY;
  try {
    process.env.NODE_ENV = 'production';
    if (key === undefined) delete process.env.DOC_ENC_KEY;
    else process.env.DOC_ENC_KEY = key;
    delete require.cache[require.resolve('../lib/crypto')];
    const mod = require('../lib/crypto');
    fn(mod);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevKey === undefined) delete process.env.DOC_ENC_KEY;
    else process.env.DOC_ENC_KEY = prevKey;
    delete require.cache[require.resolve('../lib/crypto')];
  }
}

test('mantenibilidad: validateBody aplica contratos Zod y aísla campos válidos', (t, done) => {
  const testSchema = z.object({
    nombre: z.string({ required_error: 'Nombre requerido' }).min(2, 'Muy corto'),
    edad: z.number().int().positive()
  });

  const middleware = validateBody(testSchema);

  // 1. Rechazo de campos faltantes
  const fakeReqFail = { body: { nombre: 'A' } };
  const fakeResFail = {
    status(code) {
      assert.equal(code, 400);
      return {
        json(payload) {
          assert.equal(payload.error, 'Muy corto');
        }
      };
    }
  };
  middleware(fakeReqFail, fakeResFail, () => assert.fail('No debe llamar next()'));

  // 2. Éxito y purga de propiedades no declaradas
  const fakeReqOk = { body: { nombre: 'Carlos', edad: 30, campoExtraInesperado: 'hack' } };
  const fakeResOk = {
    status() { return this; },
    json() {}
  };
  middleware(fakeReqOk, fakeResOk, () => {
    assert.equal(fakeReqOk.body.nombre, 'Carlos');
    assert.equal(fakeReqOk.body.edad, 30);
    assert.equal(fakeReqOk.body.campoExtraInesperado, undefined, 'Debe depurar campos no declarados');
    done();
  });
});

test('mantenibilidad: respuestas de error uniformes en formato JSON sin fuga de trazas', async () => {
  await withServer(async (baseUrl) => {
    // 404 en ruta inexistente
    const res404 = await fetch(baseUrl + '/api/ruta-inexistente-12345');
    assert.equal(res404.status, 404);
    assert.equal(res404.headers.get('content-type')?.includes('application/json'), true);
    const body404 = await res404.json();
    assert.ok(typeof body404.error === 'string', 'Debe tener propiedad error tipo string');
    assert.equal(body404.stack, undefined, 'No debe filtrar stack trace');

    // 400 en payload malformado
    const res400 = await fetch(baseUrl + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({})
    });
    assert.equal(res400.status, 400);
    const body400 = await res400.json();
    assert.ok(typeof body400.error === 'string');
    assert.equal(body400.stack, undefined);
  });
});

test('mantenibilidad: fail-fast de configuración con assertEncryptionKey en producción', () => {
  // Sin DOC_ENC_KEY en producción debe lanzar de inmediato
  withProductionEnv(undefined, (mod) => {
    assert.throws(
      () => mod.assertEncryptionKey(),
      /DOC_ENC_KEY no está configurada/
    );
  });

  // Con clave de longitud incorrecta debe lanzar
  const claveCorta = Buffer.from('clave-corta-16-b').toString('base64');
  withProductionEnv(claveCorta, (mod) => {
    assert.throws(
      () => mod.assertEncryptionKey(),
      /DOC_ENC_KEY debe ser una cadena base64 de exactamente 32 bytes/
    );
  });

  // Con clave válida de 32 bytes debe inicializar correctamente
  const claveValida = crypto.randomBytes(32).toString('base64');
  withProductionEnv(claveValida, (mod) => {
    assert.doesNotThrow(() => mod.assertEncryptionKey());
  });
});

test('mantenibilidad: resiliencia de scrubText ante formatos nulos, diacríticos y cédulas', () => {
  // Manejo de valores falsy y tipos heterogéneos
  assert.equal(scrubText(null, ['1003379378']), '');
  assert.equal(scrubText(undefined, ['1003379378']), '');
  assert.equal(scrubText('Texto normal', []), 'Texto normal');
  assert.equal(scrubText('Texto normal', [null, undefined, '']), 'Texto normal');

  // Supresión de cédulas e identificadores
  const textoCedula = 'Documento de funcionario con cédula 1003379378 asignado';
  const saneado = scrubText(textoCedula, ['1003379378']);
  assert.ok(!saneado.includes('1003379378'));
  assert.ok(saneado.includes('[ELIMINADO]'));

  // Tolerancia insensible a mayúsculas y acentos
  const textoPersonal = 'Funcionario José Gustavo Corzo registrado';
  const anonimizado = scrubText(textoPersonal, ['JOSE GUSTAVO CORZO']);
  assert.ok(!anonimizado.includes('José Gustavo Corzo'));
  assert.ok(anonimizado.includes('[ELIMINADO]'));
});

test('mantenibilidad: escapeHtml y normalizeEmail aseguran integridad de datos y anti-XSS', () => {
  // escapeHtml neutraliza los 5 caracteres clave
  const xssPayload = `<script>alert("XSS & 'pwned'")</script>`;
  const seguro = escapeHtml(xssPayload);
  assert.equal(seguro, '&lt;script&gt;alert(&quot;XSS &amp; &#39;pwned&#39;&quot;)&lt;/script&gt;');

  // escapeHtml trata valores nulos/indefinidos
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(12345), '12345');

  // normalizeEmail normaliza espacios y mayúsculas
  assert.equal(normalizeEmail('  ADMIN@Valledupar.Gov.CO  '), 'admin@valledupar.gov.co');
  assert.equal(normalizeEmail(''), '');
  assert.equal(normalizeEmail(null), '');
});
