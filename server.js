require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
require('express-async-errors');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const { connect, col, isHealthy, reconnect, closeDb, storeFileBuffer, readFileStream, deleteFileByName, listFilesBySource, markFileRegistered } = require('./db');

// Prevenir caídas por errores no controlados
process.on('unhandledRejection', (err) => {
  console.error('[PROCESS] Unhandled rejection:', err.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception:', err.message || err);
  process.exit(1);
});

function getGoogleApis() {
  return require('googleapis').google;
}

const app = express();
// Por defecto solo se confían cabeceras X-Forwarded-For procedentes de loopback;
// así un atacante remoto no puede falsificar req.ip (rate limiters/logs/auditoría).
// Si se despliega detrás de un proxy real, definir TRUST_PROXY=1 (o 'loopback'/n).
const trustProxySetting = process.env.TRUST_PROXY;
app.set('trust proxy', trustProxySetting
  ? (/^\d+$/.test(trustProxySetting) ? parseInt(trustProxySetting, 10) : trustProxySetting)
  : 'loopback');
const PORT = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET no está configurado en .env');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
const PASSWORD_HISTORY_SIZE = 5;
const VALID_DOC_STATUSES = ['Pendiente', 'Aprobado', 'Activo', 'Archivado', 'Rechazado'];
const MAX_GMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_REGISTER_BYTES = 50 * 1024 * 1024;
const DOCUMENTS_DIR = path.join(__dirname, 'storage', 'documentos');
const SCANNER_DIR = path.join(__dirname, 'bandeja_escaner');
const GMAIL_INBOX_DIR = path.join(__dirname, 'storage', 'gmail_adjuntos');
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || 'valledupar-cesar.gov.co').toLowerCase();
[DOCUMENTS_DIR, SCANNER_DIR, GMAIL_INBOX_DIR].forEach(directory => {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
});

// Correo saliente (nodemailer). Si SMTP_HOST no está configurado, el sistema no envía
// correos y las funciones de recuperación/activación entregan el enlace por pantalla.
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || '',
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: process.env.SMTP_SECURE !== 'false',
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || ''
};
const SMTP_FROM = process.env.SMTP_FROM || (SMTP_CONFIG.user ? `Sistema de Talento Humano <${SMTP_CONFIG.user}>` : '');
const SMTP_ENABLED = Boolean(SMTP_CONFIG.host && SMTP_CONFIG.user && SMTP_CONFIG.pass);

function getMailTransporter() {
  if (!SMTP_ENABLED) return null;
  return nodemailer.createTransport({
    host: SMTP_CONFIG.host,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.secure,
    auth: { user: SMTP_CONFIG.user, pass: SMTP_CONFIG.pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000
  });
}

// URL pública del sistema. En producción debe definirse APP_BASE_URL en .env
// para evitar que un atacante manipule el header Host y envenene los enlaces.
function getAppBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  if (process.env.NODE_ENV !== 'production') return `${req.protocol}://${req.get('host')}`;
  return null;
}

async function sendEmail({ to, subject, html }) {
  if (!SMTP_ENABLED) {
    console.warn('[MAIL] SMTP no configurado; no se envió correo a', to);
    return false;
  }
  const transporter = getMailTransporter();
  if (!transporter) return false;
  try {
    await transporter.sendMail({ from: SMTP_FROM, to, subject, html });
    return true;
  } catch (err) {
    console.error('[MAIL] Error enviando correo:', err.message || err);
    return false;
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : false,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400
}));
app.use(express.json({ limit: '500kb' }));
app.use(express.urlencoded({ extended: false, limit: '500kb' }));
app.use(mongoSanitize({ replaceWith: '_' }));
app.use(hpp());

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones desde esta IP. Intente de nuevo en 15 minutos.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de autenticación. Intente de nuevo en 15 minutos.' }
});

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Límite de creación alcanzado. Intente de nuevo en una hora.' }
});

app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/activate', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: '1h' }));

// Middleware: rechazar APIs si la BD no está conectada aún
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login') return next();
  try { col('users'); } catch (e) {
    return res.status(503).json({ error: 'Base de datos conectándose. Espere unos segundos e intente de nuevo.' });
  }
  next();
});

const ALLOWED_EXTENSIONS = new Set([
  '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
  '.jpg','.jpeg','.png','.gif','.bmp','.tiff','.tif',
  '.txt','.csv','.odt','.ods','.rtf'
]);

const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.tiff': 'image/tiff', '.tif': 'image/tiff',
  '.txt': 'text/plain', '.csv': 'text/csv',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.rtf': 'application/rtf'
};

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

const INLINE_MIMES = new Set(['application/pdf','image/jpeg','image/png','image/gif','image/bmp','image/tiff']);
function isInlineMime(mimeType) { return INLINE_MIMES.has(mimeType); }

function isAllowedFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS.has(ext);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!isAllowedFile(file.originalname)) {
      const error = new Error('Formato de archivo no permitido. Use: PDF, Word, Excel, imágenes o texto.');
      error.code = 'INVALID_FILE_TYPE';
      return cb(error);
    }
    cb(null, true);
  }
});

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isAllowedInstitutionalEmail(email) {
  return normalizeEmail(email).endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

// --- FUNCIONES DE SEGURIDAD ---

function validatePasswordStrength(password) {
  if (password.length < 12) return { valid: false, error: 'La contraseña debe tener al menos 12 caracteres.' };
  if (!/[A-Z]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos una letra mayúscula.' };
  if (!/[a-z]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos una letra minúscula.' };
  if (!/[0-9]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos un número.' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos un símbolo.' };
  return { valid: true };
}

function generateSecureToken(expiresInHours = 24) {
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash, expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000) };
}

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_TIME_MS = 30 * 60 * 1000;

// Mitigación de DoS por bloqueo: registrar cuántos bloqueos provoca cada IP
const ipLockEvents = new Map();
const MAX_LOCKOUTS_PER_IP = 10;
const IP_LOCK_WINDOW_MS = 60 * 60 * 1000;

function isIpLockoutBlocked(ip) {
  if (!ip || ip === 'unknown') return false;
  const now = Date.now();
  const events = (ipLockEvents.get(ip) || []).filter(t => now - t < IP_LOCK_WINDOW_MS);
  if (events.length === 0) ipLockEvents.delete(ip);
  else ipLockEvents.set(ip, events);
  return events.length >= MAX_LOCKOUTS_PER_IP;
}

function recordIpLockoutEvent(ip) {
  if (!ip || ip === 'unknown') return;
  const now = Date.now();
  const events = (ipLockEvents.get(ip) || []).filter(t => now - t < IP_LOCK_WINDOW_MS);
  events.push(now);
  ipLockEvents.set(ip, events);
}

async function recordLoginAttempt(identifier, success, ip) {
  const normalizedId = normalizeEmail(identifier);
  const entry = { identifier: normalizedId, success, ip, timestamp: new Date() };
  await col('loginAttempts').insertOne(entry);

  if (!success) {
    const alreadyLocked = await col('users').findOne({ email: normalizedId, lockedUntil: { $gt: new Date() } });
    if (alreadyLocked) return { locked: true, attempts: MAX_LOGIN_ATTEMPTS };
    const empLocked = await col('employees').findOne({ email: normalizedId, lockedUntil: { $gt: new Date() } });
    if (empLocked) return { locked: true, attempts: MAX_LOGIN_ATTEMPTS };

    const since = new Date(Date.now() - LOCK_TIME_MS);
    const recentFails = await col('loginAttempts').countDocuments({
      identifier: normalizedId, success: false, timestamp: { $gte: since }
    });
    if (recentFails >= MAX_LOGIN_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCK_TIME_MS);
      await col('users').updateOne(
        { email: normalizedId, lockedUntil: { $lt: new Date() } },
        { $set: { status: 'bloqueada', lockedUntil } }
      );
      await col('employees').updateOne(
        { email: normalizedId, lockedUntil: { $lt: new Date() } },
        { $set: { status: 'bloqueada', lockedUntil } }
      );
      recordIpLockoutEvent(ip);
      return { locked: true, attempts: recentFails };
    }
    return { locked: false, attempts: recentFails };
  }
  return { locked: false, attempts: 0 };
}

function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// --- LOGGING DE SEGURIDAD ---
async function addSecurityLog(event, details, ip, email) {
  const entry = {
    id: 'sec_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex'),
    timestamp: new Date().toISOString(),
    event,
    details,
    ip: ip || 'unknown',
    email: email || 'unknown',
    severity: 'warning'
  };
  try { await col('securityLogs').insertOne(entry); } catch (e) { console.warn('Error al insertar log de seguridad:', e.message); }
  console.log(`[SECURITY] ${event} | ${details} | IP: ${ip} | User: ${email}`);
}

// --- JWT VERSIONING ---
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h', algorithm: 'HS256' });
}

// --- AUTENTICACIÓN COMPARTIDA ---
async function authenticateUser(user, collectionName, role, username, password, ip, res) {
  if (user.status === 'bloqueada' && user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    const minsLeft = Math.ceil((new Date(user.lockedUntil) - new Date()) / 60000);
    return res.status(423).json({ error: `Cuenta bloqueada temporalmente. Intente de nuevo en ${minsLeft} minuto(s).` });
  }
  if (user.status === 'bloqueada' && (!user.lockedUntil || new Date(user.lockedUntil) <= new Date())) {
    await col(collectionName).updateOne({ _id: user._id }, { $set: { status: 'activa', lockedUntil: null, failedAttempts: 0 } });
    user.status = 'activa';
  }
  if (user.status === 'pendiente') {
    return res.status(403).json({ error: 'Su cuenta aún no ha sido activada. Revise su correo electrónico para el enlace de activación.' });
  }
  if (user.status === 'suspendida') {
    return res.status(403).json({ error: 'Su cuenta ha sido suspendida. Contacte al administrador.' });
  }
  if (user.status === 'inactiva') {
    return res.status(403).json({ error: 'Su cuenta ha sido desactivada. Contacte al administrador.' });
  }
  if (role === 'funcionario' && user.active === false) {
    return res.status(403).json({ error: 'Su cuenta ha sido desactivada. Contacte al administrador.' });
  }
  if (user.status === 'bloqueada') {
    return res.status(423).json({ error: 'Su cuenta ha sido bloqueada. Contacte al administrador.' });
  }
  if (user.password) {
    const valid = await bcrypt.compare(password, user.password);
    if (valid) {
      await col(collectionName).updateOne({ _id: user._id }, { $set: { failedAttempts: 0, lockedUntil: null } });
      await col('loginAttempts').deleteMany({ identifier: normalizeEmail(username) });
      const tokenPayload = { email: user.email, name: user.name, role, v: user.jwtVersion || 0 };
      if (role === 'funcionario') tokenPayload.employeeId = user.id;
      const token = signToken(tokenPayload);
      await addAuditLog('Inicio de Sesión', `El ${role === 'admin' ? 'usuario' : 'funcionario'} ${user.name} inició sesión en el sistema.`, user.name, ip);
      const responseUser = { email: user.email, name: user.name, role, department: user.department };
      if (role === 'funcionario') responseUser.employeeId = user.id;
      return res.json({ token, user: responseUser });
    }
    const result = await recordLoginAttempt(username, false, ip);
    if (result.locked) {
      await addAuditLog('Cuenta Bloqueada', `La cuenta del ${role === 'admin' ? 'usuario' : 'funcionario'} ${user.name} fue bloqueada por ${MAX_LOGIN_ATTEMPTS} intentos fallidos.`, user.name, ip);
      await addSecurityLog('Cuenta Bloqueada', `Cuenta ${user.email} bloqueada por ${MAX_LOGIN_ATTEMPTS} intentos fallidos.`, ip, user.email);
      return res.status(423).json({ error: 'Demasiados intentos fallidos. Intente de nuevo más tarde.' });
    }
    await addSecurityLog('Login Fallido', `Contraseña incorrecta para ${user.email}.`, ip, user.email);
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }
  return null;
}

// --- CAMBIO DE CONTRASEÑA COMPARTIDO ---
async function handleChangePasswordForRole(user, currentPassword, newPassword, role, ip, res) {
  const collectionName = role === 'admin' ? 'users' : 'employees';
  const lookupField = role === 'admin' ? { email: user.email } : { id: user.employeeId };
  const doc = await col(collectionName).findOne(lookupField);
  if (!doc || !doc.password) return res.status(404).json({ error: `${role === 'admin' ? 'Usuario' : 'Funcionario'} no encontrado.` });
  if (!(await bcrypt.compare(currentPassword, doc.password))) {
    await addSecurityLog('Cambio de Contraseña Fallido', `Intento con contraseña incorrecta para ${doc.name}.`, ip, doc.email);
    return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
  }
  const isReused = await checkPasswordHistory(doc.email, newPassword, role);
  if (isReused) {
    return res.status(400).json({ error: `No puede reutilizar las últimas ${PASSWORD_HISTORY_SIZE} contraseñas.` });
  }
  const newHash = await bcrypt.hash(newPassword, 12);
  const newVersion = (doc.jwtVersion || 0) + 1;
  await col(collectionName).updateOne({ _id: doc._id }, { $set: { password: newHash, jwtVersion: newVersion } });
  await addToPasswordHistory(doc.email, newHash, role);
  await addAuditLog('Cambio de Contraseña', `El ${role === 'admin' ? 'administrador' : 'funcionario'} ${doc.name} cambió su contraseña.`, doc.name, ip);
  return res.json({ message: 'Contraseña actualizada. Debe iniciar sesión nuevamente.', forceReauth: true });
}

// --- ARCHIVOS SIN REGISTRAR ---
async function getUnregisteredFiles(allDocs = null) {
  try {
    const registeredFilenames = allDocs
      ? allDocs.map(d => d.filename)
      : await col('documents').distinct('filename');
    const regSet = new Set(registeredFilenames);
    const result = [];

    try {
      const gridFiles = await listFilesBySource('local', false);
      for (const f of gridFiles) {
        if (!regSet.has(f.filename)) {
          result.push({ filename: f.filename, fileSize: f.length || f.fileSize || 0, createdAt: f.uploadDate || new Date(0) });
        }
      }
    } catch (e) { console.warn('Error listando archivos GridFS no registrados:', e.message); }

    try {
      if (fs.existsSync(DOCUMENTS_DIR)) {
        const diskFiles = fs.readdirSync(DOCUMENTS_DIR).filter(f => isAllowedFile(f));
        for (const fn of diskFiles) {
          if (regSet.has(fn) || result.some(r => r.filename === fn)) continue;
          let size = 0, created = new Date(0);
          try {
            const st = fs.statSync(path.join(DOCUMENTS_DIR, fn));
            size = st.size;
            created = st.birthtime || new Date(0);
          } catch (e) { /* ignorar stat fallido */ }
          result.push({ filename: fn, fileSize: size, createdAt: created });
        }
      }
    } catch (e) { console.warn('Error listando archivos locales no registrados:', e.message); }

    return result;
  } catch (e) { console.warn('Error en getUnregisteredFiles:', e.message); return []; }
}

// --- HISTORIAL DE CONTRASEÑAS ---
async function checkPasswordHistory(email, newPassword, role) {
  const collection = role === 'admin' ? 'users' : 'employees';
  const user = await col(collection).findOne({ email });
  if (!user || !user.passwordHistory) return false;
  for (const oldHash of user.passwordHistory.slice(-PASSWORD_HISTORY_SIZE)) {
    if (await bcrypt.compare(newPassword, oldHash)) return true;
  }
  return false;
}

async function addToPasswordHistory(email, hashedPassword, role) {
  const collection = role === 'admin' ? 'users' : 'employees';
  await col(collection).updateOne(
    { email },
    { $push: { passwordHistory: { $each: [hashedPassword], $slice: -PASSWORD_HISTORY_SIZE } } }
  );
}

// --- ROLES Y PERMISOS ---
const ROLES = {
  admin: {
    permissions: [
      'employees.create', 'employees.read', 'employees.update', 'employees.delete', 'employees.suspend', 'employees.reactivate',
      'documents.create', 'documents.read', 'documents.update', 'documents.delete',
      'audit.read', 'config.manage',
      'scanner.manage', 'scanner.read', 'scanner.refresh', 'scanner.scan',
      'email.manage'
    ]
  },
  funcionario: {
    permissions: [
      'scanner.read', 'scanner.refresh', 'scanner.scan',
      'deletion.create'
    ]
  }
};

function hasPermission(role, permission) {
  return ROLES[role]?.permissions.includes(permission) || false;
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'No tiene permisos para realizar esta acción.' });
    }
    next();
  };
}

function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !permissions.some(p => hasPermission(req.user.role, p))) {
      return res.status(403).json({ error: 'No tiene permisos para realizar esta acción.' });
    }
    next();
  };
}

function parseEmailFromHeader(fromHeader) {
  if (!fromHeader) return { senderName: 'Remitente desconocido', senderEmail: '' };
  const match = fromHeader.match(/^(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?$/);
  if (!match) return { senderName: fromHeader, senderEmail: fromHeader };
  return { senderName: (match[1] || match[2] || fromHeader).trim(), senderEmail: normalizeEmail(match[2] || fromHeader) };
}

async function addAuditLog(action, details, userEmail, ip) {
  try {
    const newLog = {
      id: 'log_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      user: userEmail || 'Sistema',
      action,
      details,
      ip: ip || 'unknown'
    };
    await col('auditLogs').insertOne(newLog);
  } catch (e) {
    console.warn('Error guardando registro de auditoría:', e.message);
  }
}

function getSafeFilePath(directory, filename) {
  if (typeof filename !== 'string' || filename !== path.basename(filename) || !isAllowedFile(filename)) {
    return null;
  }
  return path.join(directory, filename);
}

async function validateDocumentReferences(documentTypeId, categoryId) {
  const documentType = await col('documentTypes').findOne({ id: documentTypeId });
  const category = await col('categories').findOne({ id: categoryId });
  if (!documentType || !category) return null;
  return { documentType, category };
}

function getUniqueFilename(originalFilename) {
  const ext = path.extname(originalFilename);
  const base = path.basename(originalFilename, ext);
  return `${base}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
}

// Mutex por archivo: evita que dos peticiones simultáneas registren el mismo archivo
// (bandeja del escáner o adjunto de correo) y generen documentos duplicados.
const registerLocks = new Set();
async function withRegisterLock(filename, fn) {
  while (registerLocks.has(filename)) {
    await new Promise(r => setTimeout(r, 50));
  }
  registerLocks.add(filename);
  try {
    return await fn();
  } finally {
    registerLocks.delete(filename);
  }
}

async function getScannerFiles() {
  try {
    const files = await listFilesBySource('scanner', false);
    const result = files.map(f => ({ filename: f.filename, fileSize: f.length || 0, createdAt: f.uploadDate || new Date() }));
    try {
      if (fs.existsSync(SCANNER_DIR)) {
        const diskFiles = fs.readdirSync(SCANNER_DIR).filter(f => isAllowedFile(f) && !result.some(r => r.filename === f));
        for (const fn of diskFiles) {
          const st = fs.statSync(path.join(SCANNER_DIR, fn));
          if (!result.some(r => r.filename === fn)) result.push({ filename: fn, fileSize: st.size, createdAt: st.mtime });
        }
      }
    } catch (e) { console.warn('Error obteniendo archivos GridFS del escáner:', e.message); }
    return result;
  } catch (e) { console.warn('Error en getScannerFiles:', e.message);
    try {
      if (fs.existsSync(SCANNER_DIR)) {
        return fs.readdirSync(SCANNER_DIR).filter(f => isAllowedFile(f)).map(fn => {
          const st = fs.statSync(path.join(SCANNER_DIR, fn));
          return { filename: fn, fileSize: st.size, createdAt: st.mtime };
        });
      }
    } catch (e2) { console.warn('Error leyendo directorio del escáner:', e2.message); }
    return [];
  }
}

function createDoc({ filename, originalName, employeeId, employeeName, documentTypeId, categoryId, description, issueDate, expiryDate, status, fileSize, uploadedBy, uploadedByEmployee, visibleToEmployee, sourceEmailId, sourceSenderEmail }) {
  if (status !== undefined && !VALID_DOC_STATUSES.includes(status)) {
    throw new Error(`Estado no válido para el documento: ${status}`);
  }
  return {
    id: 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    filename, originalName: originalName || filename,
    employeeId, employeeName, documentTypeId, categoryId,
    description: description || '', issueDate, expiryDate: expiryDate || '',
    status: status || 'Pendiente',
    registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    fileSize, uploadedBy: uploadedBy || 'Sistema',
    uploadedByEmployee: !!uploadedByEmployee, visibleToEmployee: visibleToEmployee !== false,
    ...(sourceEmailId ? { sourceEmailId, sourceSenderEmail: sourceSenderEmail || '' } : {})
  };
}

// Helper compartido para registro de documentos (local, escáner, correo)
async function registerDocumentCore({ req, filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status, sourceDir, mover, auditAction, auditMessageTemplate, extraDocFields, fileBuffer, gridFSSource, actor }) {
  const employee = await col('employees').findOne({ id: employeeId });
  if (!employee) return { error: 'El funcionario seleccionado no existe.', status: 404 };
  const references = await validateDocumentReferences(documentTypeId, categoryId);
  if (!references) return { error: 'El tipo documental o la categoría seleccionada no existen.', status: 400 };

  let targetFilename = null;
  let fileSize = 0;
  let stored = false;
  let deferredOriginalDelete = null;

  try {
    if (fileBuffer) {
      targetFilename = getUniqueFilename(filename);
      await storeFileBuffer(targetFilename, fileBuffer, { source: gridFSSource || 'upload', registered: true });
      stored = true;
      fileSize = fileBuffer.length;
    } else if (mover) {
      const sourcePath = getSafeFilePath(sourceDir, filename);
      if (!sourcePath) return { error: `Ruta de origen no válida para '${filename}'.`, status: 400 };

      const gridFile = await readFileStream(filename).catch(() => null);
      if (gridFile) {
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of gridFile.stream) {
          totalBytes += chunk.length;
          if (totalBytes > MAX_REGISTER_BYTES) {
            return { error: `El archivo '${filename}' supera el tamaño máximo permitido (${Math.round(MAX_REGISTER_BYTES / 1024 / 1024)} MB).`, status: 400 };
          }
          chunks.push(chunk);
        }
        const buf = Buffer.concat(chunks);
        targetFilename = getUniqueFilename(filename);
        await storeFileBuffer(targetFilename, buf, { source: gridFSSource || sourceDir || 'upload', registered: true });
        stored = true;
        fileSize = buf.length;
        deferredOriginalDelete = { type: 'gridfs', name: filename };
      } else {
        const buf = fs.readFileSync(sourcePath);
        if (buf.length > MAX_REGISTER_BYTES) {
          return { error: `El archivo '${filename}' supera el tamaño máximo permitido (${Math.round(MAX_REGISTER_BYTES / 1024 / 1024)} MB).`, status: 400 };
        }
        targetFilename = getUniqueFilename(filename);
        await storeFileBuffer(targetFilename, buf, { source: gridFSSource || sourceDir || 'upload', registered: true });
        stored = true;
        fileSize = buf.length;
        deferredOriginalDelete = { type: 'disk', path: sourcePath };
      }
    } else {
      const gridFile = await readFileStream(filename).catch(() => null);
      if (gridFile) {
        targetFilename = filename;
        fileSize = gridFile.file.length || 0;
        try { await markFileRegistered(filename); } catch (e) { console.warn('Error marcando archivo como registrado:', e.message); }
      } else {
        const filePath = getSafeFilePath(sourceDir || DOCUMENTS_DIR, filename);
        if (filePath && fs.existsSync(filePath)) {
          targetFilename = filename;
          const buf = fs.readFileSync(filePath);
          await storeFileBuffer(targetFilename, buf, { source: 'local', registered: true });
          stored = true;
          fileSize = buf.length;
        }
      }
    }

    if (!targetFilename) return { error: 'No se pudo localizar el archivo para registrar.', status: 404 };

    const newDoc = createDoc({
      filename: targetFilename, originalName: filename,
      employeeId, employeeName: employee.name,
      documentTypeId, categoryId, description, issueDate, expiryDate,
      status, fileSize,
      ...(extraDocFields || {})
    });
    await col('documents').insertOne(newDoc);

    // Retirar el original de la bandeja SOLO después de confirmar el registro en BD.
    // Si el borrado falla, se conserva el original para evitar pérdida de datos;
    // quedará visible en la bandeja como archivo no registrado (duplicado evitable).
    if (deferredOriginalDelete) {
      try {
        if (deferredOriginalDelete.type === 'gridfs') await deleteFileByName(deferredOriginalDelete.name);
        else fs.unlinkSync(deferredOriginalDelete.path);
      } catch (e) {
        console.warn(`[REGISTER] No se pudo retirar el original '${deferredOriginalDelete.name || deferredOriginalDelete.path}' de la bandeja. Se conserva por seguridad.`);
      }
    }

    const auditMsg = auditMessageTemplate(employee.name, references.documentType.name, filename);
    try { await addAuditLog(auditAction, auditMsg, actor || 'Sistema', getClientIp(req)); }
    catch (e) { console.warn('Error registrando auditoría:', e.message); }
    return { doc: newDoc };
  } catch (err) {
    // Revertir el archivo recién almacenado si el registro a BD falló.
    // El original NO se borró todavía, así que no hay pérdida de datos.
    if (stored && targetFilename) {
      try { await deleteFileByName(targetFilename); } catch (e2) { console.warn('Error revirtiendo archivo:', e2.message); }
    }
    throw err;
  }
}

function createGmailAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REDIRECT_URI) {
    const error = new Error('Faltan variables de configuración de Gmail.');
    error.code = 'GMAIL_NOT_CONFIGURED';
    throw error;
  }
  return new getGoogleApis().auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI);
}

function getGmailClient(refreshToken) {
  const token = refreshToken || process.env.GMAIL_REFRESH_TOKEN;
  if (!token) {
    const error = new Error('Falta el token de actualización de Gmail.');
    error.code = 'GMAIL_NOT_CONFIGURED';
    throw error;
  }
  const auth = createGmailAuthClient();
  auth.setCredentials({ refresh_token: token });
  return getGoogleApis().gmail({ version: 'v1', auth });
}

function getHeader(headers, name) {
  const header = headers.find(item => item.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

function parseDateHeader(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function getAttachmentParts(part, attachmentParts = []) {
  if (part.filename && isAllowedFile(part.filename) && part.body && part.body.attachmentId) {
    attachmentParts.push(part);
  }
  (part.parts || []).forEach(child => getAttachmentParts(child, attachmentParts));
  return attachmentParts;
}

// --- MIDDLEWARE DE AUTENTICACIÓN ---
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado. Inicie sesión.' });
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.v === undefined) {
      return res.status(401).json({ error: 'Sesión no válida. Inicie sesión nuevamente.' });
    }
    const collection = decoded.role === 'admin' ? 'users' : 'employees';
    const dbUser = await col(collection).findOne(
      { email: decoded.email },
      { projection: { jwtVersion: 1, status: 1, active: 1, id: 1, name: 1 } }
    );
    if (!dbUser) {
      return res.status(401).json({ error: 'Usuario no encontrado. Inicie sesión nuevamente.' });
    }
    if (decoded.v !== (dbUser.jwtVersion || 0)) {
      return res.status(401).json({ error: 'Sesión expirada por cambio de contraseña. Inicie sesión nuevamente.' });
    }
    if (dbUser.status === 'suspendida' || dbUser.status === 'inactiva' || dbUser.status === 'bloqueada' || (decoded.role === 'funcionario' && dbUser.active === false)) {
      return res.status(401).json({ error: 'Su cuenta no está activa. Contacte al administrador.' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicie sesión nuevamente.' });
    }
    return res.status(401).json({ error: 'Token inválido. Inicie sesión nuevamente.' });
  }
}

// --- INICIO DE SESIÓN UNIFICADO ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const ip = getClientIp(req);
    if (!username || !password) {
      return res.status(400).json({ error: 'Ingrese usuario y contraseña.' });
    }

    const normalizedEmail = normalizeEmail(username);

    // Mitigación de DoS: IP que provoca muchos bloqueos de cuentas queda temporalmente bloqueada
    if (isIpLockoutBlocked(ip)) {
      return res.status(429).json({ error: 'Demasiados intentos desde esta IP. Intente de nuevo más tarde.' });
    }

    const adminUser = await col('users').findOne({ email: normalizedEmail });
    if (adminUser) {
      const result = await authenticateUser(adminUser, 'users', 'admin', username, password, ip, res);
      if (result !== null) return;
    }

    const employee = await col('employees').findOne({ email: normalizedEmail });
    if (employee) {
      const result = await authenticateUser(employee, 'employees', 'funcionario', username, password, ip, res);
      if (result !== null) return;
    }

    // Igualar tiempo de respuesta con una comparación ficticia para evitar oráculo de usuarios
    await bcrypt.compare(password, '$2b$12$rihPeZEdUv2hQ58SAXXvwOp/YSCqgMt7f1ek8bxIXpl5HzNvDgG9q');
    await recordLoginAttempt(username, false, ip);
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  } catch (error) {
    console.error('[LOGIN] Error:', error.message);
    return res.status(503).json({ error: 'La base de datos se está conectando. Intente de nuevo en unos segundos.' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// --- CAMBIO DE CONTRASEÑA ---
app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const ip = getClientIp(req);
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Ingrese la contraseña actual y la nueva contraseña.' });
  }
  const passwordCheck = validatePasswordStrength(newPassword);
  if (!passwordCheck.valid) {
    return res.status(400).json({ error: passwordCheck.error });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'La nueva contraseña debe ser diferente a la actual.' });
  }
  return handleChangePasswordForRole(req.user, currentPassword, newPassword, req.user.role, ip, res);
});

// --- RUTAS DEL PORTAL DEL FUNCIONARIO ---
// Registro público DESHABILITADO — solo admin puede crear cuentas
// --- ACTIVACIÓN DE CUENTA POR TOKEN ---
app.get('/api/auth/activate/:token', async (req, res) => {
  const { token } = req.params;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const activationToken = await col('activationTokens').findOne({ tokenHash });

  if (!activationToken) {
    return res.status(400).json({ error: 'Token de activación inválido o ya utilizado.' });
  }
  if (new Date(activationToken.expiresAt) < new Date()) {
    await col('activationTokens').deleteOne({ _id: activationToken._id });
    return res.status(400).json({ error: 'El token de activación ha expirado. Solicite uno nuevo al administrador.' });
  }

  res.json({
    valid: true,
    email: activationToken.email,
    role: activationToken.role,
    name: activationToken.name,
    message: 'Token válido. Por favor defina su contraseña.'
  });
});

app.post('/api/auth/activate/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  const ip = getClientIp(req);

  if (!password) return res.status(400).json({ error: 'La contraseña es obligatoria.' });
  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.valid) return res.status(400).json({ error: passwordCheck.error });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const activationToken = await col('activationTokens').findOne({ tokenHash });
  if (!activationToken) return res.status(400).json({ error: 'Token de activación inválido o ya utilizado.' });
  if (new Date(activationToken.expiresAt) < new Date()) {
    await col('activationTokens').deleteOne({ _id: activationToken._id });
    return res.status(400).json({ error: 'El token de activación ha expirado. Solicite uno nuevo al administrador.' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  // Seguridad: un token de activación solo puede activar cuentas pendientes/inactivas.
  // No re-activar cuentas suspendidas o bloqueadas.
  const targetCollection = activationToken.role === 'admin' ? 'users' : 'employees';
  const target = await col(targetCollection).findOne({ email: activationToken.email });
  if (!target) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  if (target.status === 'suspendida' || target.status === 'bloqueada' || target.status === 'activa') {
    await col('activationTokens').deleteOne({ _id: activationToken._id });
    return res.status(403).json({ error: 'Esta cuenta no está pendiente de activación.' });
  }

  if (activationToken.role === 'admin') {
    await col('users').updateOne(
      { email: activationToken.email },
      { $set: { status: 'activa', password: hashedPassword } }
    );
  } else {
    await col('employees').updateOne(
      { email: activationToken.email },
      { $set: { status: 'activa', active: true, password: hashedPassword } }
    );
  }

  await col('activationTokens').deleteOne({ _id: activationToken._id });
  await addAuditLog('Activación de Cuenta', `El usuario ${activationToken.name} (${activationToken.email}) activó su cuenta exitosamente.`, activationToken.email, ip);

  res.json({ message: 'Cuenta activada exitosamente. Ahora puede iniciar sesión.' });
});

// --- SOLICITUD DE RESTABLECIMIENTO DE CONTRASEÑA ---
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  const ip = getClientIp(req);
  if (!email) return res.status(400).json({ error: 'El correo electrónico es obligatorio.' });

  const genericMessage = 'Si el correo existe en el sistema, recibirá un enlace de restablecimiento.';
  const normalizedEmail = normalizeEmail(email);
  const adminUser = await col('users').findOne({ email: normalizedEmail });
  const employee = await col('employees').findOne({ email: normalizedEmail });
  const user = adminUser || employee;
  const role = adminUser ? 'admin' : 'funcionario';

  // Respuesta idéntica si el correo no existe, la cuenta no puede entrar
  // (suspendida/inactiva) o aún no tiene contraseña (pendiente de activación).
  if (!user) return res.json({ message: genericMessage });
  const currentStatus = user.status || 'activa';
  const notLoginable = currentStatus === 'suspendida' || currentStatus === 'inactiva' || (role === 'funcionario' && !user.password);
  if (notLoginable) return res.json({ message: genericMessage });

  const { raw, hash, expiresAt } = generateSecureToken(1);
  await col('passwordResetTokens').insertOne({
    tokenHash: hash,
    email: normalizedEmail,
    role,
    expiresAt,
    used: false
  });

  await addAuditLog('Solicitud de Restablecimiento', `El usuario ${user.name} solicitó restablecer su contraseña.`, user.name, ip);

  const baseUrl = getAppBaseUrl(req);
  const resetUrl = baseUrl ? `${baseUrl}/forgot-password.html?token=${encodeURIComponent(raw)}` : null;
  const sent = await sendEmail({
    to: normalizedEmail,
    subject: 'Restablecimiento de contraseña — Sistema de Talento Humano',
    html: resetUrl
      ? `<p>Hola <strong>${escapeHtml(user.name)}</strong>:</p>
        <p>Recibimos una solicitud para restablecer su contraseña.</p>
        <p>El enlace es válido por <strong>1 hora</strong>. Si no lo solicitó, ignore este correo.</p>
        <p><a href="${escapeHtml(resetUrl)}">Restablecer mi contraseña</a></p>`
      : `<p>Hola <strong>${escapeHtml(user.name)}</strong>:</p>
        <p>Recibimos una solicitud para restablecer su contraseña. Contacte al administrador del sistema para continuar.</p>`
  });

  if (!sent) {
    console.warn('[MAIL] No se pudo enviar correo de restablecimiento a', normalizedEmail, resetUrl ? '(el enlace solo se entrega por pantalla en desarrollo)' : '');
    // Solo en desarrollo se entrega el enlace por pantalla para no depender de SMTP.
    if (process.env.NODE_ENV === 'development' && resetUrl) {
      return res.json({ message: genericMessage, resetLink: resetUrl });
    }
  }

  res.json({ message: genericMessage });
});

app.get('/api/auth/reset-password/:token', async (req, res) => {
  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const resetToken = await col('passwordResetTokens').findOne({ tokenHash, used: false });
  if (!resetToken) return res.status(400).json({ error: 'Token inválido o ya utilizado.' });
  if (new Date(resetToken.expiresAt) < new Date()) {
    return res.status(400).json({ error: 'El token ha expirado. Solicite uno nuevo.' });
  }
  res.json({ valid: true, email: resetToken.email });
});

app.post('/api/auth/reset-password/:token', async (req, res) => {
  const { password } = req.body;
  const ip = getClientIp(req);
  if (!password) return res.status(400).json({ error: 'La contraseña es obligatoria.' });
  const passwordCheck = validatePasswordStrength(password);
  if (!passwordCheck.valid) return res.status(400).json({ error: passwordCheck.error });

  const tokenHash = crypto.createHash('sha256').update(req.params.token).digest('hex');
  const resetToken = await col('passwordResetTokens').findOne({ tokenHash, used: false });
  if (!resetToken) return res.status(400).json({ error: 'Token inválido o ya utilizado.' });
  if (new Date(resetToken.expiresAt) < new Date()) return res.status(400).json({ error: 'El token ha expirado.' });

  const hashedPassword = await bcrypt.hash(password, 12);
  const newVersion = { $inc: { jwtVersion: 1 } };

  // Seguridad: no forzar status:'activa'. Solo se limpia el bloqueo; cuentas
  // suspendidas/desactivadas siguen sin poder entrar hasta que el admin las reactive.
  const currentUser = await col(resetToken.role === 'admin' ? 'users' : 'employees').findOne({ email: resetToken.email });
  const currentStatus = currentUser?.status;
  if (currentStatus === 'suspendida' || currentStatus === 'inactiva' || (resetToken.role === 'funcionario' && !currentUser?.password)) {
    await col('passwordResetTokens').updateOne({ _id: resetToken._id }, { $set: { used: true } });
    return res.status(403).json({ error: 'Su cuenta no puede restablecer la contraseña. Contacte al administrador.' });
  }

  // Evitar reutilizar una contraseña reciente al restablecer.
  if (await checkPasswordHistory(resetToken.email, password, resetToken.role)) {
    await col('passwordResetTokens').updateOne({ _id: resetToken._id }, { $set: { used: true } });
    return res.status(400).json({ error: 'La nueva contraseña ya fue usada recientemente. Elija otra.' });
  }

  if (resetToken.role === 'admin') {
    await col('users').updateOne({ email: resetToken.email }, { $set: { password: hashedPassword, lockedUntil: null, failedAttempts: 0 }, ...newVersion });
    await addToPasswordHistory(resetToken.email, hashedPassword, 'admin');
  } else {
    await col('employees').updateOne({ email: resetToken.email }, { $set: { password: hashedPassword, lockedUntil: null, failedAttempts: 0 }, ...newVersion });
    await addToPasswordHistory(resetToken.email, hashedPassword, 'funcionario');
  }
  await col('passwordResetTokens').updateOne({ _id: resetToken._id }, { $set: { used: true } });
  await col('loginAttempts').deleteMany({ identifier: resetToken.email });
  await addAuditLog('Restablecimiento de Contraseña', `El usuario ${resetToken.email} restableció su contraseña exitosamente.`, resetToken.email, ip);
  await addSecurityLog('Contraseña Restablecida', `Contraseña restablecida para ${resetToken.email}. Todas las sesiones anteriores fueron invalidadas.`, ip, resetToken.email);

  res.json({ message: 'Contraseña restablecida exitosamente. Ahora puede iniciar sesión.' });
});

app.get('/api/funcionario/init', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  const empId = req.user.employeeId;

  try {
    // Consultas secuenciales para evitar limpieza del pool TLS bajo carga paralela
    const docs = await col('documents').find({
      employeeId: empId,
      status: { $ne: 'Archivado' },
      $or: [{ visibleToEmployee: true }, { uploadedByEmployee: true }]
    }).toArray();

    const dtResult = await col('documentTypes').find().toArray();
    const catResult = await col('categories').find().toArray();

    const scannerFiles = await getScannerFiles();

    let emails = [];
    try {
      // Seguridad: el funcionario solo ve correos sugeridos para él o sin asignar
      emails = await col('emailsInbox').find({
        $or: [{ suggestedEmployeeId: empId }, { suggestedEmployeeId: { $in: [null, ''] } }]
      }).sort({ date: -1 }).toArray();
    } catch (e) { console.warn('Error obteniendo inbox de correo:', e.message); }

    res.json({ docs, config: { documentTypes: dtResult, categories: catResult }, scannerFiles, emails });
  } catch (err) {
    console.error('[FUNC_INIT] Error:', err.message);
    res.status(503).json({ error: 'Error de conexión. Reintentando...' });
  }
});



app.post('/api/funcionario/subir-documento', authMiddleware, upload.single('file'), async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  if (!req.file) return res.status(400).json({ error: 'No se proporcionó ningún archivo o el formato no es válido.' });

  const empleadoId = req.user.employeeId;
  const { documentTypeId, categoryId, description, issueDate } = req.body;
  if (!documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  const employee = await col('employees').findOne({ id: empleadoId });
  if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

  const references = await validateDocumentReferences(documentTypeId, categoryId);
  if (!references) return res.status(400).json({ error: 'Tipo de documento o categoría no válidos.' });

  const uniqueName = getUniqueFilename(req.file.originalname);
  await storeFileBuffer(uniqueName, req.file.buffer, { source: 'upload', registered: true });

  const newDoc = createDoc({
    filename: uniqueName, originalName: req.file.originalname,
    employeeId: empleadoId, employeeName: employee.name,
    documentTypeId, categoryId, description, issueDate, fileSize: req.file.size,
    uploadedBy: employee.name, uploadedByEmployee: true
  });
  try {
    await col('documents').insertOne(newDoc);
  } catch (e) {
    try { await deleteFileByName(uniqueName); } catch (e2) { console.warn('Error revirtiendo archivo subido:', e2.message); }
    throw e;
  }

  await addAuditLog('Carga por Funcionario', `${employee.name} subió el archivo '${uniqueName}' (${references.documentType.name}).`, employee.name, getClientIp(req));
  res.status(201).json(newDoc);
});

app.post('/api/funcionario/register-scanner', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  const { filename, documentTypeId, categoryId, description, issueDate, expiryDate } = req.body;
  if (!filename || !documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  // El archivo debe estar en la bandeja del escáner (local) o ser un archivo de escáner sin registrar en GridFS
  const scanPath = getSafeFilePath(SCANNER_DIR, filename);
  const inLocalTray = scanPath && fs.existsSync(scanPath);
  const inScannerGrid = !inLocalTray && (await listFilesBySource('scanner', false).catch(() => []))
    .some(f => f.filename === filename);
  if (!inLocalTray && !inScannerGrid) {
    return res.status(403).json({ error: 'El archivo no se encuentra en la bandeja del escáner.' });
  }

  // Un funcionario solo puede dejar el documento en revisión; el estado lo fija el administrador.
  const result = await withRegisterLock(filename, () => registerDocumentCore({
    req, filename, employeeId: req.user.employeeId, documentTypeId, categoryId, description, issueDate, expiryDate,
    status: 'Pendiente',
    sourceDir: SCANNER_DIR, mover: true,
    auditAction: 'Escáner por Funcionario',
    auditMessageTemplate: (emp, type, fn) => `${emp} registró el archivo escaneado '${fn}' (${type}).`,
    extraDocFields: { uploadedBy: req.user.name || 'Funcionario', uploadedByEmployee: true },
    actor: req.user.name
  }));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.doc);
});

app.post('/api/funcionario/register-email-attachment', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  const { emailId, filename, documentTypeId, categoryId, description, issueDate, expiryDate } = req.body;
  if (!emailId || !filename || !documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  const email = await col('emailsInbox').findOne({ id: emailId });
  if (!email) return res.status(404).json({ error: 'Correo electrónico no encontrado.' });
  if (email.suggestedEmployeeId && email.suggestedEmployeeId !== req.user.employeeId) {
    return res.status(403).json({ error: 'No tiene permisos para registrar adjuntos de este correo.' });
  }
  const attachment = (email.attachments || []).find(a => a.filename === filename);
  if (!attachment) return res.status(404).json({ error: 'Archivo adjunto no encontrado.' });
  if (attachment.registered) return res.status(409).json({ error: 'Este adjunto ya fue registrado como documento.' });

  // Un funcionario solo puede dejar el documento en revisión; el estado lo fija el administrador.
  const result = await withRegisterLock(filename, () => registerDocumentCore({
    req, filename, employeeId: req.user.employeeId, documentTypeId, categoryId,
    description: description || `Ingresado desde correo de ${email.senderName} - Asunto: ${email.subject}.`,
    issueDate, expiryDate,
    status: 'Pendiente',
    sourceDir: GMAIL_INBOX_DIR, mover: true,
    auditAction: 'Correo por Funcionario',
    auditMessageTemplate: (emp, type, fn) => `${emp} registró el adjunto '${fn}' del correo de ${email.senderName} (${type}).`,
    extraDocFields: { sourceEmailId: emailId, sourceSenderEmail: email.senderEmail || email.sender, uploadedBy: req.user.name || 'Funcionario', uploadedByEmployee: true },
    actor: req.user.name
  }));
  if (result.error) return res.status(result.status).json({ error: result.error });

  await col('emailsInbox').updateOne(
    { id: emailId, 'attachments.filename': filename },
    { $set: { 'attachments.$.registered': true } }
  );

  res.status(201).json(result.doc);
});

// --- ADMIN: ALTERNAR VISIBILIDAD DEL DOCUMENTO ---
app.patch('/api/documents/:id/visibilidad', authMiddleware, requirePermission('documents.update'), async (req, res) => {
  const { id } = req.params;
  const doc = await col('documents').findOne({ id });
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });

  const newVisible = !doc.visibleToEmployee;
  await col('documents').updateOne({ id }, { $set: { visibleToEmployee: newVisible } });

  await addAuditLog(
    newVisible ? 'Visibilidad Activada' : 'Visibilidad Desactivada',
    `El documento '${doc.filename}' ${newVisible ? 'ahora es visible' : 'ya no es visible'} para el funcionario.`,
    req.user.name,
    getClientIp(req)
  );
  res.json({ id, visibleToEmployee: newVisible });
});

// --- EMPLEADOS ---
app.get('/api/employees', authMiddleware, requirePermission('employees.read'), async (req, res) => {
  res.json(await col('employees').find({}, { projection: { password: 0, passwordHistory: 0 } }).toArray());
});

app.post('/api/employees', authMiddleware, requirePermission('employees.create'), createLimiter, async (req, res) => {
  const ip = getClientIp(req);
  let { id, name, department, position, email } = req.body;
  if (!department || !email) {
    return res.status(400).json({ error: 'La dependencia y el correo electrónico son obligatorios.' });
  }
  if (!id) id = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  if (!name) name = id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();
  if (!position) position = 'Sin asignar';
  if (!isAllowedInstitutionalEmail(email)) {
    return res.status(400).json({ error: `El correo del funcionario debe ser institucional (@${ALLOWED_EMAIL_DOMAIN}).` });
  }
  if (await col('employees').findOne({ id })) {
    return res.status(400).json({ error: 'Ya existe un empleado con esta identificación (Cédula).' });
  }
  if (await col('employees').findOne({ email: normalizeEmail(email) })) {
    return res.status(400).json({ error: 'Ya existe un empleado con este correo electrónico.' });
  }

  const newEmployee = {
    id, name, department, position,
    email: normalizeEmail(email),
    status: 'pendiente',
    active: false,
    registeredAt: new Date().toISOString(),
    registeredBy: 'Administrador',
    failedAttempts: 0,
    lockedUntil: null
  };
  await col('employees').insertOne(newEmployee);

  const activation = generateSecureToken(24);
  await col('activationTokens').insertOne({
    tokenHash: activation.hash,
    email: normalizeEmail(email),
    name,
    role: 'funcionario',
    expiresAt: activation.expiresAt,
    createdAt: new Date()
  });

  await addAuditLog('Crear Empleado', `Se registró al funcionario ${name} con C.C. ${id}. Token de activación generado.`, 'Administrador', ip);

  const activationBase = getAppBaseUrl(req);
  const activationUrl = activationBase ? `${activationBase}/activate.html?token=${activation.raw}` : null;
  const activationSent = activationUrl ? await sendEmail({
    to: normalizeEmail(email),
    subject: 'Activación de cuenta — Sistema de Talento Humano',
    html: `<p>Hola <strong>${escapeHtml(name)}</strong>:</p>
      <p>Se creó su cuenta en el Sistema de Gestión Documental de la Alcaldía de Valledupar.</p>
      <p>El enlace de activación es válido por <strong>24 horas</strong>.</p>
      <p><a href="${activationUrl}">Activar mi cuenta</a></p>`
  }) : false;

  res.status(201).json({
    ...newEmployee,
    activationToken: activation.raw,
    activationSent,
    message: activationSent
      ? `Empleado creado. Se envió el enlace de activación al correo del funcionario.`
      : `Empleado creado. Comparta este enlace de activación con el funcionario: /activate.html?token=${activation.raw}`
  });
});

app.delete('/api/employees/:id', authMiddleware, requirePermission('employees.delete'), async (req, res) => {
  try {
    const ip = getClientIp(req);
    const { id } = req.params;
    const employee = await col('employees').findOne({ id });
    if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

    await col('employees').deleteOne({ id });
    await col('loginAttempts').deleteMany({ identifier: employee.email });
    await col('activationTokens').deleteMany({ email: employee.email });
    await col('passwordResetTokens').deleteMany({ email: employee.email });
    await addAuditLog('Eliminar Empleado', `Se eliminó permanentemente al funcionario ${employee.name} C.C. ${id}. Sus documentos históricos se conservan.`, req.user.name, ip);
    await addSecurityLog('Empleado Eliminado', `Funcionario ${employee.name} (${employee.email}) eliminado permanentemente por ${req.user.name}. Sus documentos se conservan.`, ip, employee.email);
    res.json({ message: `Funcionario "${employee.name}" eliminado permanentemente. Sus documentos históricos se conservan en el archivo.` });
  } catch (error) {
    console.error('[DELETE-EMPLOYEE] Error:', error);
    res.status(500).json({ error: 'Error al eliminar el funcionario.' });
  }
});

app.patch('/api/employees/:id/toggle-active', authMiddleware, requirePermission('employees.suspend'), async (req, res) => {
  try {
    const ip = getClientIp(req);
    const { id } = req.params;
    const employee = await col('employees').findOne({ id });
    if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

    const newActive = !employee.active;
    const wasPending = employee.status === 'pendiente' || (!employee.password && !newActive);
    const newStatus = wasPending ? 'pendiente' : (newActive ? 'activa' : 'inactiva');
    await col('employees').updateOne({ id }, { $set: { active: newActive, status: newStatus } });
    await col('employees').updateOne({ id }, { $inc: { jwtVersion: 1 } });

    const statusText = wasPending ? 'pendiente de activación' : (newActive ? 'activado' : 'desactivado');
    const statusEmoji = newActive ? '✓' : '✕';
    await addAuditLog(`${statusEmoji} ${newActive ? 'Reactivar' : 'Desactivar'} Empleado`, `El funcionario ${employee.name} (C.C. ${id}) fue ${statusText}.`, req.user.name, ip);
    res.json({ message: `Funcionario "${employee.name}" ${statusText} exitosamente.`, active: newActive, status: newStatus });
  } catch (error) {
    console.error('[TOGGLE-ACTIVE] Error:', error);
    res.status(500).json({ error: 'Error al cambiar estado del funcionario.' });
  }
});

// --- ADMIN: GESTIONAR ESTADO DE USUARIO ---
app.patch('/api/users/:email/status', authMiddleware, requirePermission('employees.suspend'), async (req, res) => {
  const ip = getClientIp(req);
  const { email } = req.params;
  const { status } = req.body;
  const validStatuses = ['pendiente', 'activa', 'suspendida', 'inactiva'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Estado no válido. Use: ${validStatuses.join(', ')}` });
  }

  const normalizedEmail = normalizeEmail(email);
  // No permitir suspender/desactivar al propio administrador ni dejar al sistema
  // sin administradores activos (evita quedar encerrado fuera del sistema).
  if (status !== 'activa') {
    const targetUser = await col('users').findOne({ email: normalizedEmail });
    const isSelf = targetUser && req.user.email && req.user.email === normalizedEmail;
    if (isSelf) return res.status(403).json({ error: 'No puede suspenderse a sí mismo.' });
    if (targetUser && targetUser.role === 'admin') {
      const activeAdmins = await col('users').countDocuments({ role: 'admin', status: { $ne: 'suspendida' }, active: true });
      if (activeAdmins <= 1) {
        return res.status(403).json({ error: 'No puede desactivar al último administrador activo.' });
      }
    }
  }

  // Invalidar sesiones existentes al cambiar estado (el usuario debe re-iniciar sesión)
  const bump = { $inc: { jwtVersion: 1 } };
  let updated = await col('users').updateOne({ email: normalizedEmail }, { $set: { status, active: status === 'activa' }, ...bump });
  if (updated.matchedCount === 0) {
    updated = await col('employees').updateOne({ email: normalizedEmail }, { $set: { status, active: status === 'activa' }, ...bump });
  }
  if (updated.matchedCount === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

  await addAuditLog('Cambiar Estado de Usuario', `El estado de ${normalizedEmail} fue cambiado a '${status}'.`, req.user.name, ip);
  res.json({ message: `Estado actualizado a '${status}'.`, status });
});

// --- CONFIGURACIÓN ---
app.get('/api/config', authMiddleware, requirePermission('config.manage'), async (req, res) => {
  const [documentTypes, categories] = await Promise.all([
    col('documentTypes').find().toArray(),
    col('categories').find().toArray()
  ]);
  res.json({ documentTypes, categories });
});

// --- DASHBOARD CONSOLIDADO (1 sola llamada) ---
app.get('/api/dashboard', authMiddleware, requirePermission('employees.read'), async (req, res) => {
  try {
    // Consultas secuenciales para evitar limpieza del pool TLS bajo carga paralela
    const documentTypes = await col('documentTypes').find().toArray();
    const categories = await col('categories').find().toArray();
    const employees = await col('employees').find({}, { projection: { password: 0, passwordHistory: 0 } }).toArray();
    const documents = await col('documents').find().toArray();
    const auditLogs = await col('auditLogs').find().sort({ timestamp: -1 }).toArray();
    const deletionRequests = await col('deletionRequests').find().sort({ createdAt: -1 }).toArray();
    const typeDistribution = await col('documents').aggregate([
      { $group: { _id: '$documentTypeId', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    const facet = await col('documents').aggregate([
      { $facet: {
        total: [{ $count: 'count' }],
        pending: [{ $match: { status: 'Pendiente' } }, { $count: 'count' }],
        approved: [{ $match: { $or: [{ status: 'Aprobado' }, { status: 'Activo' }] } }, { $count: 'count' }],
        archived: [{ $match: { status: 'Archivado' } }, { $count: 'count' }]
      }}
    ]).toArray();
    const totalEmployees = await col('employees').countDocuments();

    const c = facet[0] || {};
    let unregisteredFiles = [];
    try {
      unregisteredFiles = await getUnregisteredFiles(documents);
    } catch (e) { console.warn('Error obteniendo archivos no registrados:', e.message); }

    let scannerFiles = [];
    try {
      scannerFiles = await getScannerFiles();
    } catch (e) { console.warn('Error obteniendo archivos del escáner:', e.message); }

    let emails = [];
    try {
      emails = await col('emailsInbox').find().sort({ date: -1 }).toArray();
    } catch (e) { console.warn('Error obteniendo inbox:', e.message); }

    const typeNames = {};
    documentTypes.forEach(t => { typeNames[t.id] = t.name; });

    res.json({
      config: { documentTypes, categories },
      employees,
      documents,
      auditLogs,
      deletionRequests,
      unregisteredFiles,
      scannerFiles,
      emails,
      stats: {
        totalRegistered: c.total[0]?.count || 0,
        totalEmployees,
        unregisteredCount: unregisteredFiles.length,
        pendingCount: c.pending[0]?.count || 0,
        approvedCount: c.approved[0]?.count || 0,
        archivedCount: c.archived[0]?.count || 0,
        docTypesDistribution: typeDistribution.map(t => ({ id: t._id, name: typeNames[t._id] || t._id, count: t.count })),
        recentLogs: auditLogs.slice(0, 6)
      }
    });
  } catch (err) {
    console.error('[DASHBOARD] Error:', err.message);
    res.status(500).json({ error: 'Error al cargar datos del dashboard.' });
  }
});

// --- DOCUMENTOS ---
app.get('/api/documents', authMiddleware, requirePermission('documents.read'), async (req, res) => {
  res.json(await col('documents').find().toArray());
});

app.get('/api/documents/unregistered', authMiddleware, requirePermission('documents.read'), async (req, res) => {
  try {
    res.json(await getUnregisteredFiles());
  } catch (error) {
    res.status(500).json({ error: 'No se pudieron listar los archivos.' });
  }
});

app.post('/api/documents/register-local', authMiddleware, requirePermission('documents.create'), async (req, res) => {
  const { filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (!filename || !employeeId || !documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar el documento.' });
  }
  if (status !== undefined && !VALID_DOC_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Estado no válido. Valores permitidos: ${VALID_DOC_STATUSES.join(', ')}.` });
  }
  const result = await withRegisterLock(filename, () => registerDocumentCore({
    req, filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status,
    sourceDir: DOCUMENTS_DIR, mover: false,
    auditAction: 'Registro de Documento Local',
    auditMessageTemplate: (emp, type, fn) => `Se vinculó el archivo local '${fn}' a ${emp} como '${type}'.`,
    extraDocFields: { uploadedBy: req.user.name || 'Sistema' },
    actor: req.user.name
  }));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.doc);
});

app.post('/api/documents/upload', authMiddleware, requirePermission('documents.create'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se proporcionó ningún archivo o el formato no es válido.' });

  const { employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (!employeeId || !documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar el documento cargado.' });
  }
  if (status !== undefined && !VALID_DOC_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Estado no válido. Valores permitidos: ${VALID_DOC_STATUSES.join(', ')}.` });
  }

  const employee = await col('employees').findOne({ id: employeeId });
  if (!employee) return res.status(404).json({ error: 'El funcionario seleccionado no existe.' });
  const references = await validateDocumentReferences(documentTypeId, categoryId);
  if (!references) return res.status(400).json({ error: 'El tipo documental o la categoría seleccionada no existen.' });

  const uniqueName = getUniqueFilename(req.file.originalname);
  await storeFileBuffer(uniqueName, req.file.buffer, { source: 'upload', registered: true });

  const newDoc = createDoc({
    filename: uniqueName, originalName: req.file.originalname,
    employeeId, employeeName: employee.name,
    documentTypeId, categoryId, description, issueDate, expiryDate,
    status, fileSize: req.file.size, uploadedBy: 'Sistema'
  });
  try {
    await col('documents').insertOne(newDoc);
  } catch (e) {
    try { await deleteFileByName(uniqueName); } catch (e2) { console.warn('Error revirtiendo archivo subido:', e2.message); }
    throw e;
  }

  await addAuditLog('Carga de Documento', `Se subió y registró el archivo '${uniqueName}' para ${employee.name} (${references.documentType.name}).`, req.user.name, getClientIp(req));
  res.status(201).json(newDoc);
});

app.put('/api/documents/:id', authMiddleware, requirePermission('documents.update'), async (req, res) => {
  const { id } = req.params;
  const { employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;

  const doc = await col('documents').findOne({ id });
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });

  const oldStatus = doc.status;
  const updates = { updatedAt: new Date().toISOString() };

  if (employeeId && employeeId !== doc.employeeId) {
    const employee = await col('employees').findOne({ id: employeeId });
    if (!employee) return res.status(404).json({ error: 'El funcionario seleccionado no existe.' });
    updates.employeeId = employeeId;
    updates.employeeName = employee.name;
  }

  if (documentTypeId || categoryId) {
    const references = await validateDocumentReferences(documentTypeId || doc.documentTypeId, categoryId || doc.categoryId);
    if (!references) return res.status(400).json({ error: 'El tipo documental o la categoría seleccionada no existen.' });
  }
  if (documentTypeId) updates.documentTypeId = documentTypeId;
  if (categoryId) updates.categoryId = categoryId;
  if (description !== undefined) updates.description = description;
  if (issueDate) updates.issueDate = issueDate;
  if (expiryDate !== undefined) updates.expiryDate = expiryDate;
  if (status !== undefined) {
    if (!VALID_DOC_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Estado no válido. Valores permitidos: ${VALID_DOC_STATUSES.join(', ')}.` });
    }
    updates.status = status;
  }

  await col('documents').updateOne({ id }, { $set: updates });

  let changeDetails = `Se actualizaron los metadatos del documento '${doc.filename}'.`;
  if (status && status !== oldStatus) changeDetails += ` El estado cambió de '${oldStatus}' a '${status}'.`;
  await addAuditLog('Actualización de Documento', changeDetails, req.user.name, getClientIp(req));

  const updatedDoc = await col('documents').findOne({ id });
  res.json(updatedDoc);
});

app.delete('/api/documents/:id', authMiddleware, requirePermission('documents.delete'), async (req, res) => {
  const { id } = req.params;
  const { deletePhysical } = req.query;

  const doc = await col('documents').findOne({ id });
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });

  if (deletePhysical === 'true') {
    try {
      const sharingDocs = await col('documents').countDocuments({ filename: doc.filename, id: { $ne: id } });
      await col('documents').deleteOne({ id });
      // Si otros documentos comparten el mismo archivo físico, no se borra el archivo
      // para no dejar documentos huérfanos.
      if (sharingDocs === 0) {
        await deleteFileByName(doc.filename);
      } else {
        console.warn(`[DEL] El archivo '${doc.filename}' lo comparten ${sharingDocs} documento(s); no se elimina físicamente.`);
      }
      const filePath = getSafeFilePath(DOCUMENTS_DIR, doc.filename);
      if (sharingDocs === 0 && filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await addAuditLog('Eliminación Física', `Se eliminó físicamente el archivo '${doc.filename}' y su registro de la base de datos.`, req.user.name, getClientIp(req));
      await addSecurityLog('Documento Eliminado', `Documento '${doc.filename}' eliminado físicamente por ${req.user.name}.`, getClientIp(req), req.user.email);
      res.json({ message: 'Documento eliminado física y lógicamente.' });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Error al eliminar el archivo físico del servidor.' });
    }
  } else {
    await col('documents').updateOne({ id }, { $set: { status: 'Archivado', updatedAt: new Date().toISOString() } });
    await addAuditLog('Archivado de Documento', `Se archivó el documento '${doc.filename}' asociado a ${doc.employeeName}.`, req.user.name, getClientIp(req));
    res.json({ message: 'Documento archivado en el sistema.', doc: { ...doc, status: 'Archivado' } });
  }
});

// --- SOLICITUDES DE ELIMINACIÓN ---
app.get('/api/deletion-requests', authMiddleware, requirePermission('employees.read'), async (req, res) => {
  try {
    const requests = await col('deletionRequests').find().sort({ createdAt: -1 }).toArray();
    res.json(requests);
  } catch (e) {
    res.status(500).json({ error: 'Error al obtener solicitudes de eliminación.' });
  }
});

app.post('/api/deletion-requests', authMiddleware, requirePermission('deletion.create'), async (req, res) => {
  try {
    const { documentId, reason } = req.body;
    if (!documentId) return res.status(400).json({ error: 'Falta el ID del documento.' });

    const doc = await col('documents').findOne({ id: documentId });
    if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });

    const employee = await col('employees').findOne({ id: doc.employeeId });
    const employeeName = employee ? employee.name : doc.employeeName || 'Desconocido';

    // Solo el propietario o admin puede solicitar
    if (req.user.role === 'funcionario' && req.user.employeeId !== doc.employeeId) {
      return res.status(403).json({ error: 'No tiene permiso para solicitar la eliminación de este documento.' });
    }

    // Verificar si ya existe una solicitud pendiente para este documento
    const existing = await col('deletionRequests').findOne({ documentId, status: 'Pendiente' });
    if (existing) {
      return res.status(400).json({ error: 'Ya existe una solicitud pendiente para este documento.' });
    }

    const request = {
      id: 'delreq_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      documentId,
      documentFilename: doc.filename,
      employeeId: doc.employeeId,
      employeeName,
      documentType: doc.documentTypeId,
      categoryId: doc.categoryId,
      reason: reason || '',
      requestedBy: req.user.name || req.user.email,
      requestedByRole: req.user.role,
      status: 'Pendiente',
      createdAt: new Date().toISOString()
    };

    await col('deletionRequests').insertOne(request);
    await addAuditLog('Solicitud de Eliminación', `${request.requestedBy} solicitó eliminar el documento '${doc.filename}' de ${employeeName}. Motivo: ${request.reason || 'No especificado'}.`, req.user.name || req.user.email, getClientIp(req));
    res.status(201).json(request);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al crear solicitud.' });
  }
});

app.patch('/api/deletion-requests/:id/approve', authMiddleware, requirePermission('employees.read'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores pueden aprobar eliminaciones.' });

    const request = await col('deletionRequests').findOne({ id: req.params.id });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (request.status !== 'Pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });

    const doc = await col('documents').findOne({ id: request.documentId });
    if (doc) {
      await col('documents').deleteOne({ id: request.documentId });
      try { await deleteFileByName(doc.filename); } catch (e) { console.warn('Error eliminando archivo de GridFS:', e.message); }
      const filePath = getSafeFilePath(DOCUMENTS_DIR, doc.filename);
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.error('Error eliminando archivo:', e.message); }
      }
    }

    await col('deletionRequests').updateOne({ id: req.params.id }, { $set: { status: 'Aprobada', processedBy: req.user.name || req.user.email, processedAt: new Date().toISOString() } });
    await addAuditLog('Eliminación Aprobada', `El administrador ${req.user.name} aprobó la eliminación del documento '${request.documentFilename}' de ${request.employeeName}.`, req.user.name || req.user.email, getClientIp(req));
    res.json({ message: 'Solicitud aprobada. Documento eliminado.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al procesar solicitud.' });
  }
});

app.patch('/api/deletion-requests/:id/reject', authMiddleware, requirePermission('employees.read'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores pueden rechazar eliminaciones.' });

    const request = await col('deletionRequests').findOne({ id: req.params.id });
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    if (request.status !== 'Pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });

    await col('deletionRequests').updateOne({ id: req.params.id }, { $set: { status: 'Rechazada', processedBy: req.user.name || req.user.email, processedAt: new Date().toISOString() } });
    await addAuditLog('Eliminación Rechazada', `El administrador ${req.user.name} rechazó la eliminación del documento '${request.documentFilename}' de ${request.employeeName}.`, req.user.name || req.user.email, getClientIp(req));
    res.json({ message: 'Solicitud rechazada.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al procesar solicitud.' });
  }
});

// --- SERVIR ARCHIVOS ---
app.get('/api/document-file/:filename', authMiddleware, async (req, res) => {
  const filename = req.params.filename;
  const folder = req.query.folder;
  let targetDir = DOCUMENTS_DIR;
  if (folder === 'scanner') targetDir = SCANNER_DIR;
  if (folder === 'gmail' || folder === 'email') targetDir = GMAIL_INBOX_DIR;
  if (!getSafeFilePath(targetDir, filename)) {
    return res.status(400).json({ error: 'Nombre de archivo inválido.' });
  }

  // Autorización: solo admin (documents.read) accede a cualquier archivo.
  // Funcionarios solo a sus propios documentos, bandeja de escáner o adjuntos de su correo sugerido.
  const canReadAll = hasPermission(req.user.role, 'documents.read');
  if (!canReadAll) {
    const owned = await col('documents').findOne({
      filename,
      employeeId: req.user.employeeId,
      $or: [{ visibleToEmployee: true }, { uploadedByEmployee: true }]
    });
    if (owned) {
      // permitido: documento propio
    } else if (folder === 'scanner' && hasPermission(req.user.role, 'scanner.read')) {
      const trayPath = getSafeFilePath(SCANNER_DIR, filename);
      const inScannerTray = (trayPath && fs.existsSync(trayPath)) ||
        (await listFilesBySource('scanner', false)).some(f => f.filename === filename);
      if (!inScannerTray) {
        return res.status(403).json({ error: 'No tiene permisos para acceder a este archivo.' });
      }
    } else if ((folder === 'gmail' || folder === 'email') && hasPermission(req.user.role, 'scanner.read')) {
      const email = await col('emailsInbox').findOne({ 'attachments.filename': filename });
      const assignedToMe = email && (!email.suggestedEmployeeId || email.suggestedEmployeeId === req.user.employeeId);
      if (!assignedToMe) {
        return res.status(403).json({ error: 'No tiene permisos para acceder a este archivo.' });
      }
    } else {
      return res.status(403).json({ error: 'No tiene permisos para acceder a este archivo.' });
    }
  }

  try {
    const r = await readFileStream(filename);
    if (r) {
      const mimeType = getMimeType(filename);
      res.setHeader('Content-Type', mimeType);
      const safeFilename = (filename || '').replace(/["\r\n]/g, '');
      res.setHeader('Content-Disposition', (isInlineMime(mimeType) ? 'inline' : 'attachment') + '; filename="' + safeFilename + '"');
      r.stream.pipe(res);
      return;
    }
  } catch (e) { console.warn('Error al leer archivo de GridFS para descarga:', e.message); }

  const filePath = path.join(targetDir, filename);
  if (fs.existsSync(filePath)) {
    const mimeType = getMimeType(filename);
    res.setHeader('Content-Type', mimeType);
    const safeFilename = (filename || '').replace(/["\r\n]/g, '');
    res.setHeader('Content-Disposition', (isInlineMime(mimeType) ? 'inline' : 'attachment') + '; filename="' + safeFilename + '"');
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Archivo no encontrado en el servidor.' });
  }
});

// --- REGISTROS DE AUDITORÍA ---
app.get('/api/audit-logs', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  res.json(await col('auditLogs').find().sort({ timestamp: -1 }).toArray());
});

app.get('/api/security-logs', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json(await col('securityLogs').find().sort({ timestamp: -1 }).limit(limit).toArray());
});

// --- ESCÁNER ---
app.get('/api/scanner-files', authMiddleware, requirePermission('scanner.read'), async (req, res) => {
  res.json(await getScannerFiles());
});

// --- ESTADO DEL ESCÁNER (Detección USB + Red + Monitoreo de bandeja) ---
function runPs(cmd) {
  try {
    return execSync(`powershell -NoProfile -Command "${cmd}"`, { timeout: 10000, encoding: 'utf8', windowsHide: true }).trim();
  } catch (e) { console.warn('Error ejecutando PowerShell:', e.message); return ''; }
}

function detectUsbScanners() {
  const raw = runPs(`
    $scanners = @()

    # Método 1: WIA COM
    try {
      $devices = New-Object -ComObject WIA.Devices
      foreach ($dev in $devices) {
        $typeId = $dev.Type
        if ($typeId -eq 1) {
          $scanners += [PSCustomObject]@{ Name = $dev.Name; Status = 'Conectado'; Manufacturer = $dev.Manufacturer }
        }
      }
    } catch {}

    # Método 2: PnP Image devices (detecta escáneres con driver TWAIN/WIA)
    try {
      Get-PnpDevice -Status OK -Class Image | ForEach-Object {
        $exists = $false
        foreach ($s in $scanners) { if ($s.Name -eq $_.FriendlyName) { $exists = $true; break } }
        if (-not $exists) {
          $scanners += [PSCustomObject]@{ Name = $_.FriendlyName; Status = 'Conectado'; Manufacturer = '' }
        }
      }
    } catch {}

    # Método 3: PnP devices con error de driver (informar al usuario)
    try {
      Get-PnpDevice | Where-Object { $_.FriendlyName -match 'scanner|scan|perfection|flatbed|image' -and $_.Status -eq 'Error' } | ForEach-Object {
        $scanners += [PSCustomObject]@{ Name = $_.FriendlyName; Status = 'Error (driver)'; Manufacturer = '' }
      }
    } catch {}

    if ($scanners.Count -gt 0) {
      $scanners | Select-Object Name,Status,Manufacturer | ConvertTo-Json -Compress
    }
  `);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(d => ({
      name: d.Name || 'Escáner USB',
      type: 'USB',
      status: d.Status || 'Conectado',
      manufacturer: d.Manufacturer || '',
      icon: d.Status && d.Status.includes('Error') ? '⚠️' : '🔌'
    }));
  } catch (e) { console.warn('Error detectando escáneres USB:', e.message); return []; }
}

function getLocalSubnet() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const parts = iface.address.split('.');
        return parts.slice(0, 3).join('.');
      }
    }
  }
  return '192.168.1';
}

function detectNetworkScanners() {
  const subnet = getLocalSubnet();
  const raw = runPs(`
    $subnet = '${subnet}';
    $results = @();
    for ($i = 1; $i -le 20; $i++) {
      $ip = "$subnet.$i";
      try {
        $tcp = New-Object System.Net.Sockets.TcpClient;
        $async = $tcp.BeginConnect($ip, 9100, $null, $null);
        $wait = $async.AsyncWaitHandle.WaitOne(400, $false);
        if ($wait -and $tcp.Connected) { $results += "$ip:9100:OPEN" }
        $tcp.Close();
      } catch {}
    }
    $results -join [System.Environment]::NewLine
  `);

  const openHosts = [];
  if (raw) {
    raw.split('\n').forEach(line => {
      const match = line.trim().match(/^([\d.]+):(\d+):OPEN$/);
      if (match) openHosts.push({ ip: match[1], port: parseInt(match[2]) });
    });
  }

  const scanners = [];
  for (const host of openHosts) {
    const nameRaw = runPs(`try { $r = Invoke-WebRequest -Uri "http://${host.ip}:9100" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue; $r.Headers['Server'] } catch {}`);
    scanners.push({
      name: nameRaw || `Escáner de Red (${host.ip})`,
      type: 'Red',
      status: 'Detectado',
      ip: host.ip,
      port: host.port,
      icon: '🌐'
    });
  }
  return scanners;
}

function detectPrintersWithScanners() {
  const raw = runPs(`
    $scanners = @()
    try {
      $printers = Get-CimInstance Win32_Printer | Where-Object { $_.PrinterStatus -eq 3 }
      foreach ($p in $printers) {
        $name = $p.Name.ToLower()
        $driver = if ($p.DriverName) { $p.DriverName.ToLower() } else { '' }
        $port = if ($p.PortName) { $p.PortName.ToLower() } else { '' }
        $exclude = @('pdf','onenote','xps','virtual','fax','send to','print to','microsoft','snmp','wia','twain','tscc','remote','Citrix','session')
        $isExcluded = $false
        foreach ($e in $exclude) { if ($name -match $e -or $driver -match $e) { $isExcluded = $true; break } }
        if (-not $isExcluded) {
          $hasScan = $false
          if ($driver -match 'scan|twain|wia|fax|multi|all.in.one|mfp|print.scan') { $hasScan = $true }
          if ($port -match '^usb') { $hasScan = $true }
          if ($name -match 'scan|multi|all.in.one|mfp|fax') { $hasScan = $true }
          if ($hasScan) { $scanners += $p }
        }
      }
    } catch {}
    $scanners | Select-Object Name,PortName,DriverName,PrinterStatus | ConvertTo-Json -Compress
  `);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(d => ({
      name: d.Name || 'Impresora/Escáner',
      type: d.PortName && d.PortName.startsWith('\\\\') ? 'Red' : 'USB',
      status: 'Conectado',
      port: d.PortName || '',
      driver: d.DriverName || '',
      icon: '🖨️'
    }));
  } catch (e) { console.warn('Error detectando impresoras con escáner:', e.message); return []; }
}

function detectAllScanners() {
  const usb = detectUsbScanners();
  const net = detectNetworkScanners();
  const printers = detectPrintersWithScanners();

  const seen = new Set();
  const all = [];
  [...usb, ...printers, ...net].forEach(d => {
    const key = d.name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); all.push(d); }
  });
  return all;
}

let cachedScanners = [];
let lastScanCheck = 0;
const SCANNER_CACHE_MS = 20000;
let scannerRefreshRunning = false;

function refreshScannerCache() {
  if (scannerRefreshRunning) return;
  scannerRefreshRunning = true;
  try {
    cachedScanners = detectAllScanners();
    lastScanCheck = Date.now();
  } catch (e) {
    console.error('[SCANNER] Error detecting scanners:', e.message);
  } finally {
    scannerRefreshRunning = false;
  }
}

app.get('/api/scanner/status', authMiddleware, requirePermission('scanner.read'), async (req, res) => {
  const now = Date.now();
  if ((now - lastScanCheck) > SCANNER_CACHE_MS) {
    refreshScannerCache();
  }

  const trayFiles = await getScannerFiles();

  const connected = cachedScanners.length > 0;

  res.json({
    connected,
    scanners: cachedScanners,
    usbCount: cachedScanners.filter(s => s.type === 'USB').length,
    networkCount: cachedScanners.filter(s => s.type === 'Red').length,
    trayCount: trayFiles.length,
    trayFiles,
    subnet: getLocalSubnet(),
    lastChecked: new Date(lastScanCheck).toISOString()
  });
});

app.post('/api/scanner/refresh', authMiddleware, requireAnyPermission('scanner.manage', 'scanner.refresh'), (req, res) => {
  refreshScannerCache();
  res.json({ message: 'Escáneres actualizados.', scanners: cachedScanners, count: cachedScanners.length });
});

async function scanWithScanner(customName) {
  const escapedDir = SCANNER_DIR.replace(/\\/g, '\\\\');
  const timestamp = Date.now();
  const tempFile = `_temp_${timestamp}.png`;
  const baseName = (customName || `Escaner_Folio_${timestamp.toString().slice(-4)}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
  const pdfBase = `${baseName}.pdf`;
  const raw = runPs(`
    try {
      $deviceManager = New-Object -ComObject WIA.DeviceManager
      $deviceInfo = $deviceManager.DeviceInfos | Where-Object { $_.Type -eq 1 } | Select-Object -First 1
      if (-not $deviceInfo) { throw 'No scanner found' }
      $device = $deviceInfo.Connect()
      $item = $device.Items[1]
      if ($item.Properties.Item(6146)) { $item.Properties(6146).Value = 200 }
      if ($item.Properties.Item(6147)) { $item.Properties(6147).Value = 200 }
      $image = $item.Transfer('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}')
      $tempPath = '${escapedDir}\\${tempFile}'
      $image.SaveFile($tempPath)
      Write-Output 'OK'
    } catch {
      Write-Output 'ERROR:' + $_.Exception.Message
    }
  `);
  if (!raw || raw.startsWith('ERROR:')) return raw;
  const tempPath = path.join(SCANNER_DIR, tempFile);
  if (!fs.existsSync(tempPath)) return 'ERROR:No se encontró la imagen escaneada temporal';
  try {
    const pdfBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      const doc = new PDFDocument({ autoFirstPage: false });
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      const img = doc.openImage(tempPath);
      doc.addPage({ size: [img.width, img.height] });
      doc.image(img, 0, 0, { width: img.width, height: img.height });
      doc.end();
    });
    try { fs.unlinkSync(tempPath); } catch (e) { console.warn('Error limpiando tempPath:', e.message); }
    await storeFileBuffer(pdfBase, pdfBuffer, { source: 'scanner', registered: false });
    return pdfBase;
  } catch (e) {
    console.warn('Error en convertImageToPdf:', e.message);
    try { fs.unlinkSync(tempPath); } catch (ex) { console.warn('Error limpiando tempPath en catch:', ex.message); }
    return 'ERROR:' + e.message;
  }
}

app.post('/api/scanner/scan', authMiddleware, requireAnyPermission('scanner.manage', 'scanner.scan'), async (req, res) => {
  try {
    refreshScannerCache();
    await new Promise(r => setTimeout(r, 1500));
    if (cachedScanners.length === 0) {
      return res.status(400).json({ error: 'No hay escáner conectado.' });
    }
    const customName = req.body.filename ? req.body.filename.trim() : '';
    const result = await scanWithScanner(customName);
    if (!result || result.startsWith('ERROR:')) {
      return res.status(500).json({ error: result ? result.replace('ERROR:', '') : 'Error al escanear.' });
    }
    const filename = result.trim();
    await addAuditLog('Escáner Real', `Documento escaneado: '${filename}'`, req.user.name || 'Sistema', getClientIp(req));
    res.json({ success: true, filename });
  } catch (e) {
    console.error('[SCAN]', e);
    res.status(500).json({ error: 'Error al ejecutar el escáner.' });
  }
});

app.post('/api/documents/register-scanner', authMiddleware, requirePermission('documents.create'), async (req, res) => {
  const { filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (!filename || !employeeId || !documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar el documento escaneado.' });
  }

  const scanPath = getSafeFilePath(SCANNER_DIR, filename);
  const inLocalTray = scanPath && fs.existsSync(scanPath);
  const inScannerGrid = !inLocalTray && (await listFilesBySource('scanner', false).catch(() => []))
    .some(f => f.filename === filename);
  if (!inLocalTray && !inScannerGrid) {
    return res.status(403).json({ error: 'El archivo no se encuentra en la bandeja del escáner.' });
  }

  const result = await withRegisterLock(filename, () => registerDocumentCore({
    req, filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status,
    sourceDir: SCANNER_DIR, mover: true,
    auditAction: 'Ingesta de Escáner',
    auditMessageTemplate: (emp, type, fn) => `Se procesó e ingresó el documento escaneado '${fn}' para el funcionario ${emp} (${type}).`,
    actor: req.user.name
  }));
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.doc);
});

// --- BANDEJA DE CORREO ---
app.get('/api/gmail/status', authMiddleware, requirePermission('email.manage'), (req, res) => {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_REFRESH_TOKEN } = process.env;
  const configured = !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REDIRECT_URI);
  res.json({ configured, authenticated: configured && !!GMAIL_REFRESH_TOKEN });
});

// Estado OAuth en memoria (anti-CSRF): se genera al iniciar, se consume en el callback
const gmailOAuthStates = new Map();

// Devuelve la URL de autorización como JSON; el frontend la abre en pestaña nueva.
// La URL del callback (/api/gmail/oauth2callback) debe seguir pública: Google redirige allí.
app.get('/api/gmail/authorize', authMiddleware, requirePermission('email.manage'), (req, res) => {
  try {
    const auth = createGmailAuthClient();
    const state = crypto.randomBytes(24).toString('hex');
    gmailOAuthStates.set(state, Date.now());
    // Limpiar estados viejos (> 15 min)
    for (const [s, t] of gmailOAuthStates) {
      if (Date.now() - t > 15 * 60 * 1000) gmailOAuthStates.delete(s);
    }
    const url = auth.generateAuthUrl({
      access_type: 'offline', prompt: 'consent', state,
      scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
    });
    res.json({ url });
  } catch (error) {
    res.status(503).json({ error: 'Gmail no está configurado.' });
  }
});

app.get('/api/gmail/oauth2callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).json({ error: 'Google no devolvió un código de autorización.' });
    const state = req.query.state;
    const stateTime = state ? gmailOAuthStates.get(state) : undefined;
    if (!state || !stateTime || Date.now() - stateTime > 15 * 60 * 1000) {
      if (state) gmailOAuthStates.delete(state);
      return res.status(403).json({ error: 'Autorización inválida o expirada. Reinicie el proceso de autorización.' });
    }
    gmailOAuthStates.delete(state);

    const auth = createGmailAuthClient();
    const { tokens } = await auth.getToken(req.query.code);
    const ip = getClientIp(req);
    await addAuditLog('Autorización Gmail', 'Se completó la autorización OAuth con Google para la sincronización de correos.', 'Sistema', ip);
    // El refresh token solo se muestra en la consola del servidor, no en el navegador.
    if (tokens.refresh_token) {
      console.log('[GMAIL] Autorización completada. Agregue al .env:');
      console.log('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);
    }
    res.json({ success: true, message: 'Autorización completada. Revise la consola del servidor para copiar GMAIL_REFRESH_TOKEN al archivo .env' });
  } catch (error) {
    console.error('Error al autorizar Gmail:', error);
    res.status(502).json({ error: 'No se pudo completar la autorización con Google.' });
  }
});

app.get('/api/email-inbox', authMiddleware, requirePermission('email.manage'), async (req, res) => {
  res.json(await col('emailsInbox').find().sort({ date: -1 }).toArray());
});

// Mutex simple: evita dos sincronizaciones concurrentes que dupliquen archivos/correos
let gmailSyncInProgress = false;

app.post('/api/email-inbox/sync', authMiddleware, requirePermission('email.manage'), async (req, res) => {
  if (gmailSyncInProgress) {
    return res.status(409).json({ error: 'Ya hay una sincronización de correo en curso.' });
  }
  gmailSyncInProgress = true;
  try {
    const gmail = getGmailClient();
    const knownEmailIds = new Set((await col('emailsInbox').find().toArray()).map(e => e.id));

    // Paginar hasta agotar la bandeja (máx. 500 correos por sincronización) para no
    // dejar correos antiguos sin procesar cuando hay más de 25 pendientes.
    const messageRefs = [];
    let pageToken = null;
    for (let page = 0; page < 5; page++) {
      const list = await gmail.users.messages.list({
        userId: 'me', labelIds: ['INBOX'], q: 'has:attachment', maxResults: 100,
        ...(pageToken ? { pageToken } : {})
      });
      messageRefs.push(...(list.data.messages || []));
      pageToken = list.data.nextPageToken || null;
      if (!pageToken) break;
    }
    const newEmails = [];
    let attachmentsDownloaded = 0;

    // Todos los adjuntos persistidos a GridFS durante este lote, para revertir
    // cualquier huérfano si algo falla antes del insertMany.
    const storedAttachmentFilenames = new Set();

    try {
      for (const messageRef of messageRefs) {
        if (knownEmailIds.has(messageRef.id)) continue;
        const message = await gmail.users.messages.get({ userId: 'me', id: messageRef.id, format: 'full' });
        const payload = message.data.payload || {};
        const attachmentParts = getAttachmentParts(payload);
        if (!attachmentParts.length) continue;

        // 1) Descargar y conservar en memoria TODOS los adjuntos del correo antes de escribir nada.
        const buffered = [];
        let skipEmail = false;
        for (const part of attachmentParts) {
          if (!part.body || !part.body.attachmentId) { skipEmail = true; break; }
          let attachment;
          try {
            attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId: messageRef.id, id: part.body.attachmentId });
          } catch (e) { skipEmail = true; break; }
          if (!attachment.data || !attachment.data.data) { skipEmail = true; break; }
          const content = Buffer.from(attachment.data.data, 'base64url');
          if (content.length > MAX_GMAIL_ATTACHMENT_BYTES) {
            console.warn(`[GMAIL] Adjunto '${part.filename}' excede ${MAX_GMAIL_ATTACHMENT_BYTES} bytes; se omite.`);
            skipEmail = true;
            break;
          }
          buffered.push({ filename: path.basename(part.filename), content });
        }
        if (skipEmail || !buffered.length) continue;

        // 2) Re-verificar dedup antes de escribir (por si otro proceso insertó mientras tanto).
        if (await col('emailsInbox').findOne({ id: messageRef.id })) continue;

        // 3) Persistir adjuntos en GridFS y construir el registro.
        const attachments = [];
        for (const b of buffered) {
          const filename = getUniqueFilename(b.filename);
          await storeFileBuffer(filename, b.content, { source: 'gmail', registered: false });
          attachments.push({ filename, sizeBytes: b.content.length, registered: false, source: 'gmail' });
          storedAttachmentFilenames.add(filename);
          attachmentsDownloaded++;
        }

        const headers = payload.headers || [];
        const fromHeader = getHeader(headers, 'From');
        const { senderName, senderEmail } = parseEmailFromHeader(fromHeader);
        const matchedEmployee = await col('employees').findOne({ email: senderEmail });

        newEmails.push({
          id: messageRef.id, sender: senderEmail || fromHeader,
          senderName, senderEmail,
          subject: getHeader(headers, 'Subject') || '(Sin asunto)',
          body: message.data.snippet || '',
          date: parseDateHeader(getHeader(headers, 'Date')),
          read: false, syncedBy: 'Sistema',
          suggestedEmployeeId: matchedEmployee ? matchedEmployee.id : null,
          attachments
        });
      }
    } catch (e) {
      // Revertir TODOS los adjuntos guardados del lote para no dejar huérfanos.
      for (const fn of storedAttachmentFilenames) { try { await deleteFileByName(fn); } catch (e2) { /* ignorar */ } }
      throw e;
    }

    if (!newEmails.length) {
      return res.json({ message: 'Bandeja de entrada al día.', updated: false });
    }

    try {
      await col('emailsInbox').insertMany(newEmails);
    } catch (e) {
      // Si el insert falla, limpiar los adjuntos guardados para no dejarlos huérfanos.
      for (const fn of storedAttachmentFilenames) { try { await deleteFileByName(fn); } catch (e2) { /* ignorar */ } }
      throw e;
    }

    await addAuditLog('Sincronización de Correo', `Se descargaron ${attachmentsDownloaded} archivo(s) desde ${newEmails.length} correo(s) de Gmail.`, req.user.name || 'Sistema', getClientIp(req));
    res.json({ message: `Se recibieron ${attachmentsDownloaded} archivo(s) desde Gmail.`, updated: true, emails: newEmails });
  } catch (error) {
    console.error('Error al sincronizar Gmail:', error);
    const status = error.code === 'GMAIL_NOT_CONFIGURED' ? 503 : 502;
    res.status(status).json({
      error: error.code === 'GMAIL_NOT_CONFIGURED'
        ? 'Gmail no está configurado.'
        : 'No se pudo sincronizar la bandeja de Gmail.'
    });
  } finally {
    gmailSyncInProgress = false;
  }
});

app.post('/api/documents/register-email-attachment', authMiddleware, requirePermission('documents.create'), async (req, res) => {
  const { emailId, filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (!emailId || !filename || !employeeId || !documentTypeId || !categoryId || !issueDate) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  const email = await col('emailsInbox').findOne({ id: emailId });
  if (!email) return res.status(404).json({ error: 'Correo electrónico no encontrado.' });
  const attachment = (email.attachments || []).find(a => a.filename === filename);
  if (!attachment) return res.status(404).json({ error: 'Archivo adjunto no encontrado.' });
  if (attachment.registered) return res.status(409).json({ error: 'Este adjunto ya fue registrado como documento.' });

  const result = await withRegisterLock(filename, () => registerDocumentCore({
    req, filename, employeeId, documentTypeId, categoryId,
    description: description || `Ingresado desde correo de ${email.senderName} (${email.senderEmail}) - Asunto: ${email.subject}.`,
    issueDate, expiryDate,
    status: status || 'Pendiente',
    sourceDir: GMAIL_INBOX_DIR, mover: true,
    auditAction: 'Ingesta de Correo',
    auditMessageTemplate: (emp, type, fn) => `Se registró el archivo adjunto '${fn}' del correo de ${email.senderName} asignándolo a ${emp} (${type}).`,
    extraDocFields: { sourceEmailId: emailId, sourceSenderEmail: email.senderEmail || email.sender },
    actor: req.user.name
  }));
  if (result.error) return res.status(result.status).json({ error: result.error });

  await col('emailsInbox').updateOne(
    { id: emailId, 'attachments.filename': filename },
    { $set: { 'attachments.$.registered': true } }
  );

  res.status(201).json(result.doc);
});

// --- MANEJADOR DE ERRORES ---
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'El archivo supera el tamaño máximo permitido de 20 MB.' });
  }

  if (error.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({ error: error.message });
  }

  const isTransient = error.name === 'MongoNetworkError' || error.label === 'PoolClearedError' || error.label === 'PoolRequestRetry' || (error.message || '').includes('ERR_SSL_TLSV1') || (error.message || '').includes('PoolCleared');
  if (isTransient) {
    console.warn('[MONGO] Error TLS/transitorio:', error.message);
    return res.status(503).json({ error: 'Error temporal de base de datos. Intente de nuevo en unos segundos.' });
  }

  console.error('Error no controlado:', error.message || error);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// Respaldo SPA — solo para rutas que no sean API
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ruta no encontrada.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Verificador de salud de conexión: reconexión automática al morir el pool ---
let isReconnecting = false;
let lastReconnectAttempt = 0;
const RECONNECT_COOLDOWN_MS = 10000;

async function checkConnection() {
  if (isReconnecting) return;
  try {
    const healthy = await isHealthy();
    if (!healthy) {
      const now = Date.now();
      if (now - lastReconnectAttempt < RECONNECT_COOLDOWN_MS) return;
      lastReconnectAttempt = now;
      console.warn('[MONGO] Conexión perdida, reconectando...');
      isReconnecting = true;
      const ok = await reconnect();
      isReconnecting = false;
      if (ok) console.log('[MONGO] Reconexión exitosa.');
      else console.warn('[MONGO] Reconexión falló. Se reintentará en 60s.');
    }
  } catch (err) {
    console.warn('[MONGO] Health check falló:', err.message);
    isReconnecting = false;
  }
}

// --- Apagado graceful ---
let server;
let checkConnectionInterval = setInterval(checkConnection, 10000);
function shutdown() {
  console.log('[SERVER] Shutting down gracefully...');
  clearInterval(checkConnectionInterval);
  if (server) server.close(() => {
    closeDb().catch(() => {}).finally(() => process.exit(0));
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- INICIO ---
// Arrancar servidor inmediatamente sin esperar MongoDB
server = app.listen(PORT, () => {
  console.log(`Servidor de Talento Humano ejecutándose en: http://localhost:${PORT}`);
});

// Conectar MongoDB en segundo plano
connect()
  .then(() => {
    console.log('Base de datos remota conectada con colecciones separadas.');
  })
  .catch(error => {
    console.error('No se pudo conectar a la base de datos remota:', error.message);
  });
