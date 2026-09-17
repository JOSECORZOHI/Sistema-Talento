'use strict';

// Pruebas unitarias de la autenticación por cookie httpOnly y la protección CSRF.
// No requieren Base de Datos ni red: importar server.js no conecta a Mongo
// (el arranque está bajo `require.main === module`).

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-cookie-test-secret';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.MONGODB_URI = '';

const { parseCookies, getAuthToken, csrfProtection, authMiddleware } = require('../server');

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    set(name, value) { this.headers[name] = value; return this; },
    get(name) { return this.headers[name]; }
  };
}

function mockReq({ method = 'GET', cookies, authorization, xRequestedWith } = {}) {
  const headers = {};
  if (cookies) headers.cookie = cookies;
  if (authorization) headers.authorization = authorization;
  if (xRequestedWith) headers['x-requested-with'] = xRequestedWith;
  return {
    method,
    headers,
    path: '/test',
    baseUrl: '/api',
    get(name) { return this.headers[String(name).toLowerCase()]; }
  };
}

test('parseCookies: parsea pares, decodifica valores y descarta entradas inválidas', () => {
  const parsed = parseCookies({ headers: { cookie: 'a=1; th_token=abc.def.ghi; vacio=' } });
  assert.equal(parsed.a, '1');
  assert.equal(parsed.th_token, 'abc.def.ghi');
  assert.equal(parsed.vacio, '');
  const encoded = parseCookies({ headers: { cookie: 'x=hola%20mundo' } });
  assert.equal(encoded.x, 'hola mundo');
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('getAuthToken: prioriza la cookie sobre Bearer y acepta Bearer como respaldo', () => {
  const conCookie = mockReq({ cookies: 'th_token=cookie-token', authorization: 'Bearer header-token' });
  assert.equal(getAuthToken(conCookie), 'cookie-token');

  const soloBearer = mockReq({ authorization: 'Bearer header-token' });
  assert.equal(getAuthToken(soloBearer), 'header-token');

  const sinNada = mockReq();
  assert.equal(getAuthToken(sinNada), null);

  const bearerMalformado = mockReq({ authorization: 'Basic abc' });
  assert.equal(getAuthToken(bearerMalformado), null);
});

test('csrfProtection: permite GET/HEAD/OPTIONS sin encabezado', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    let nextCalled = false;
    const res = mockRes();
    csrfProtection(mockReq({ method }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, `${method} debería continuar`);
    assert.equal(res.statusCode, 200);
  }
});

test('csrfProtection: bloquea métodos mutantes sin encabezado ni Bearer (403)', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    let nextCalled = false;
    const res = mockRes();
    csrfProtection(mockReq({ method }), res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, `${method} no debería continuar`);
    assert.equal(res.statusCode, 403);
    assert.ok(res.body && res.body.error);
  }
});

test('csrfProtection: permite mutantes con X-Requested-With o con Bearer', () => {
  let next1 = false;
  csrfProtection(mockReq({ method: 'POST', xRequestedWith: 'XMLHttpRequest' }), mockRes(), () => { next1 = true; });
  assert.equal(next1, true);

  let next2 = false;
  csrfProtection(mockReq({ method: 'POST', authorization: 'Bearer x' }), mockRes(), () => { next2 = true; });
  assert.equal(next2, true);
});

test('authMiddleware: sin token responde 401', async () => {
  const res = mockRes();
  await authMiddleware(mockReq({ method: 'GET' }), res, () => { throw new Error('no debería continuar'); });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /No autenticado/);
});

test('authMiddleware: un token inválido en la cookie responde 401 (prueba que se lee la cookie)', async () => {
  const res = mockRes();
  await authMiddleware(
    mockReq({ method: 'GET', cookies: 'th_token=no-es-un-jwt' }),
    res,
    () => { throw new Error('no debería continuar'); }
  );
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Token inválido/);
});
