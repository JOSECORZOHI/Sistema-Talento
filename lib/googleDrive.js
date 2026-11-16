'use strict';

// ============================================================
//  lib/googleDrive.js — Adaptador de almacenamiento en Google Drive
//  para el Portal del Funcionario (Alcaldía).
//  Utiliza el scope 'https://www.googleapis.com/auth/drive.file'
//  para que la aplicación SOLO tenga acceso a los archivos que ella
//  misma cree en la cuenta institucional del funcionario.
// ============================================================

const { google } = require('googleapis');
const { Readable } = require('stream');
const { col } = require('../db');
const { decryptText, encryptBuffer, decryptBuffer } = require('./crypto');

const FOLDER_NAME = 'Expediente Talento Humano';
const FUNCIONARIO_DRIVE_CALLBACK = '/api/funcionario/google/callback';

/**
 * Obtiene la URI de redirección para Google OAuth del funcionario.
 * Prioriza GOOGLE_DRIVE_REDIRECT_URI y luego deriva de GMAIL_REDIRECT_URI o APP_BASE_URL.
 */
function getDriveRedirectUri() {
  if (process.env.GOOGLE_DRIVE_REDIRECT_URI) {
    return process.env.GOOGLE_DRIVE_REDIRECT_URI;
  }
  const baseUrl = process.env.GMAIL_REDIRECT_URI
    ? new URL(process.env.GMAIL_REDIRECT_URI).origin
    : (process.env.APP_BASE_URL || 'http://localhost:3000');
  return new URL(baseUrl).origin + FUNCIONARIO_DRIVE_CALLBACK;
}

/**
 * Crea un cliente OAuth2 para la autorización de Google Drive del funcionario.
 */
function createFuncionarioDriveAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const error = new Error('Faltan variables de configuración de Google OAuth (GOOGLE_CLIENT_ID / GMAIL_CLIENT_ID).');
    error.code = 'GOOGLE_OAUTH_NOT_CONFIGURED';
    throw error;
  }
  const redirectUri = getDriveRedirectUri();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Resuelve y crea un cliente autenticado de Google Drive v3 para un funcionario.
 *
 * @param {string} employeeId - ID del funcionario (cédula).
 * @returns {Promise<object|null>} Cliente de google.drive({ version: 'v3' }) o null si no está vinculado.
 */
async function getDriveClient(employeeId) {
  if (!employeeId) return null;
  let emp = null;
  try {
    emp = await col('employees').findOne({ id: employeeId });
  } catch {
    return null;
  }
  if (!emp) return null;

  // Busca el token específico de Drive, o el de Gmail si fue otorgado con acceso offline
  const encryptedToken = emp.googleDriveRefreshToken;
  if (!encryptedToken) return null;

  let refreshToken = null;
  try {
    refreshToken = decryptText(encryptedToken);
  } catch (err) {
    console.error(`[GOOGLE-DRIVE] Error descifrando token de empleado ${employeeId}:`, err.message);
    return null;
  }
  if (!refreshToken) return null;

  const auth = createFuncionarioDriveAuthClient();
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: 'v3', auth, timeout: 60000 });
}

/**
 * Asegura la existencia de la carpeta 'Expediente Talento Humano' en la raíz de Drive del funcionario.
 *
 * @param {object} drive - Instancia de google.drive('v3').
 * @returns {Promise<string>} ID de la carpeta en Google Drive.
 */
async function ensureAppFolder(drive) {
  const query = `name = '${FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false`;
  const res = await drive.files.list({
    q: query,
    spaces: 'drive',
    fields: 'files(id, name)'
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  // Crear la carpeta si no existe
  const folderMetadata = {
    name: FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder',
    parents: ['root']
  };
  const createRes = await drive.files.create({
    requestBody: folderMetadata,
    fields: 'id'
  });
  return createRes.data.id;
}

/**
 * Sube un archivo a Google Drive del funcionario dentro de la carpeta designada.
 *
 * @param {object} params
 * @param {string} params.employeeId - ID del funcionario.
 * @param {string} params.filename - Nombre original o asignado del archivo.
 * @param {Buffer} params.buffer - Contenido en bytes del archivo.
 * @param {string} [params.mimeType='application/pdf'] - Tipo MIME.
 * @param {boolean} [params.encrypt=true] - Si se debe cifrar en reposo con AES-256-GCM.
 * @returns {Promise<{ fileId: string, webViewLink: string, encrypted: boolean, size: number }>}
 */
async function uploadToDrive({ employeeId, filename, buffer, mimeType = 'application/pdf', encrypt = true }) {
  const drive = await getDriveClient(employeeId);
  if (!drive) {
    const error = new Error('El funcionario no tiene vinculada su cuenta de Google Workspace.');
    error.code = 'DRIVE_NOT_LINKED';
    throw error;
  }

  const folderId = await ensureAppFolder(drive);

  let toStore = buffer;
  let isEncrypted = false;
  if (encrypt) {
    toStore = encryptBuffer(buffer);
    isEncrypted = true;
  }

  const fileMetadata = {
    name: filename,
    parents: [folderId],
    description: `Documento de expediente institucional - Alcaldía. Cifrado: ${isEncrypted ? 'AES-256-GCM' : 'No'}.`
  };

  const media = {
    mimeType: isEncrypted ? 'application/octet-stream' : mimeType,
    body: Readable.from(toStore)
  };

  const driveRes = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink, size'
  });

  return {
    fileId: driveRes.data.id,
    webViewLink: driveRes.data.webViewLink || null,
    encrypted: isEncrypted,
    size: toStore.length
  };
}

/**
 * Descarga el contenido de un archivo desde Google Drive y devuelve un Readable stream en claro.
 *
 * @param {object} params
 * @param {string} params.employeeId - ID del funcionario.
 * @param {string} params.fileId - ID del archivo en Google Drive.
 * @param {boolean} [params.encrypted=false] - Si el archivo está cifrado con AES-256-GCM.
 * @returns {Promise<Readable>} Stream de lectura con los bytes del archivo en claro.
 */
async function downloadFromDriveStream({ employeeId, fileId, encrypted = false }) {
  const drive = await getDriveClient(employeeId);
  if (!drive) {
    const error = new Error('No se puede descargar de Google Drive: la cuenta no está vinculada.');
    error.code = 'DRIVE_NOT_LINKED';
    throw error;
  }

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  if (!encrypted) {
    return res.data;
  }

  // Si está cifrado, consolidar los chunks, descifrar con AES-256-GCM y retornar Readable
  const chunks = [];
  for await (const chunk of res.data) {
    chunks.push(chunk);
  }
  const combined = Buffer.concat(chunks);
  const decrypted = decryptBuffer(combined);
  return Readable.from(decrypted);
}

/**
 * Elimina un archivo de Google Drive.
 *
 * @param {object} params
 * @param {string} params.employeeId - ID del funcionario.
 * @param {string} params.fileId - ID del archivo en Google Drive.
 * @returns {Promise<boolean>}
 */
async function deleteFromDrive({ employeeId, fileId }) {
  try {
    const drive = await getDriveClient(employeeId);
    if (!drive) return false;
    await drive.files.delete({ fileId });
    return true;
  } catch (err) {
    console.warn(`[GOOGLE-DRIVE] Error al eliminar archivo ${fileId}:`, err.message);
    return false;
  }
}

module.exports = {
  FOLDER_NAME,
  FUNCIONARIO_DRIVE_CALLBACK,
  getDriveRedirectUri,
  createFuncionarioDriveAuthClient,
  getDriveClient,
  ensureAppFolder,
  uploadToDrive,
  downloadFromDriveStream,
  deleteFromDrive
};
