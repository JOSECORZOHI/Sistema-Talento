'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FOLDER_NAME,
  FUNCIONARIO_DRIVE_CALLBACK,
  getDriveRedirectUri,
  createFuncionarioDriveAuthClient,
  getDriveClient,
  uploadToDrive,
  downloadFromDriveStream,
  deleteFromDrive
} = require('../lib/googleDrive');

test('googleDrive: constantes base', () => {
  assert.equal(FOLDER_NAME, 'Expediente Talento Humano');
  assert.equal(FUNCIONARIO_DRIVE_CALLBACK, '/api/funcionario/google/callback');
});

test('googleDrive: getDriveRedirectUri prioridad de variables', () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.GOOGLE_DRIVE_REDIRECT_URI;
    process.env.APP_BASE_URL = 'https://talento.valledupar.gov.co';
    delete process.env.GMAIL_REDIRECT_URI;
    assert.equal(getDriveRedirectUri(), 'https://talento.valledupar.gov.co/api/funcionario/google/callback');

    process.env.GOOGLE_DRIVE_REDIRECT_URI = 'https://custom.gov.co/oauth/drive';
    assert.equal(getDriveRedirectUri(), 'https://custom.gov.co/oauth/drive');
  } finally {
    process.env = origEnv;
  }
});

test('googleDrive: createFuncionarioDriveAuthClient valida configuración', () => {
  const origEnv = { ...process.env };
  try {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GMAIL_CLIENT_SECRET;

    assert.throws(() => {
      createFuncionarioDriveAuthClient();
    }, (err) => err.code === 'GOOGLE_OAUTH_NOT_CONFIGURED');

    process.env.GOOGLE_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'test-client-secret';
    process.env.APP_BASE_URL = 'http://localhost:3000';

    const client = createFuncionarioDriveAuthClient();
    assert.ok(client);
    assert.equal(typeof client.generateAuthUrl, 'function');
  } finally {
    process.env = origEnv;
  }
});

test('googleDrive: operaciones sin vincular lanzan o retornan de forma segura', async () => {
  const nonExistentEmpId = 'no_existe_99999';

  const client = await getDriveClient(nonExistentEmpId);
  assert.equal(client, null);

  await assert.rejects(async () => {
    await uploadToDrive({
      employeeId: nonExistentEmpId,
      filename: 'prueba.pdf',
      buffer: Buffer.from('%PDF-1.4 test')
    });
  }, (err) => err.code === 'DRIVE_NOT_LINKED');

  await assert.rejects(async () => {
    await downloadFromDriveStream({
      employeeId: nonExistentEmpId,
      fileId: 'drive_fake_id_123'
    });
  }, (err) => err.code === 'DRIVE_NOT_LINKED');

  const deleted = await deleteFromDrive({
    employeeId: nonExistentEmpId,
    fileId: 'drive_fake_id_123'
  });
  assert.equal(deleted, false);
});
