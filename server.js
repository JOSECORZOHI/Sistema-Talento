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
const { exec, spawn } = require('child_process');
const os = require('os');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const { connect, col, isHealthy, reconnect, closeDb, storeFileBuffer, readFileStream, deleteFileByName, listFilesBySource, markFileRegistered } = require('./db');

// Generador de contraseñas temporales para nuevos funcionarios
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*_-+=?';
  const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  return pick(upper, 2) + pick(lower, 2) + pick(digits, 2) + pick(symbols, 2) + pick(upper + lower + digits + symbols, 8);
}

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
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
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
    port: 587,
    secure: false,
    auth: { user: SMTP_CONFIG.user, pass: SMTP_CONFIG.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    tls: { rejectUnauthorized: false }
  });
}

// URL pública del sistema. En producción/servicio debe definirse APP_BASE_URL en .env
// para que los enlaces de reset/activación sean correctos y no envenenables.
// El header Host solo se confía en modo development explícito.
function getAppBaseUrl(req) {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  if (proto && host) return `${proto}://${host}`;
  return null;
}

async function sendEmail({ to, subject, html, text }) {
  console.log('[MAIL] Intentando enviar a:', to, '| SMTP_ENABLED:', SMTP_ENABLED);
  if (!SMTP_ENABLED) {
    console.warn('[MAIL] SMTP no configurado; no se envió correo a', to);
    return false;
  }
  const transporter = getMailTransporter();
  if (!transporter) { console.warn('[MAIL] No se creó transporter'); return false; }
  try {
    const info = await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject,
      html,
      text: text || subject,
      headers: {
        'List-Unsubscribe': `<mailto:${SMTP_CONFIG.user}?subject=Cancelar%20suscripci%C3%B3n>`,
        'X-Mailer': 'SistemaTalentoHumano',
        'Precedence': 'bulk'
      }
    });
    console.log('[MAIL] Correo enviado a', to, '| messageId:', info.messageId);
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
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean) : false,
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

const scannerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de refresco de escáner. Intente de nuevo en 15 minutos.' }
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de subidas alcanzado. Intente de nuevo en una hora.' }
});

app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/activate', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  }
}));

// Estado de reconexión (compartido con health check más abajo)
let isReconnecting = false;

// Middleware: rechazar APIs si la BD no está conectada aún
// Si la BD se cayó, intenta reconectar automáticamente (espera hasta 12s).
app.use('/api', async (req, res, next) => {
  if (req.path === '/auth/login') return next();
  if (req.path === '/gmail/oauth2callback') return next();
  try {
    col('users');
    return next();
  } catch (e) {
    // BD caída: intentar reconexión automática (máx 1 intento a la vez)
    if (!isReconnecting) {
      isReconnecting = true;
      console.warn('[MONGO] Middleware detectó BD caída, intentando reconexión...');
      reconnect().then(ok => {
        isReconnecting = false;
        if (ok) console.log('[MONGO] Reconexión desde middleware exitosa.');
        else console.warn('[MONGO] Reconexión desde middleware falló.');
      }).catch(() => { isReconnecting = false; });
    }
    // Esperar hasta 12s a que la BD se recupere
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { col('users'); return next(); } catch (_) {}
    }
    return res.status(503).json({ error: 'Base de datos temporalmente no disponible. Intente de nuevo en unos segundos.' });
  }
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

// Content-Disposition conforme a RFC 5987: filename ASCII seguro + filename* UTF-8
// para caracteres especiales/acentuados.
function buildContentDisposition(mimeType, filename) {
  const mode = isInlineMime(mimeType) ? 'inline' : 'attachment';
  const asciiName = (filename || '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  const utf8Encoded = encodeURIComponent((filename || '').replace(/["\\]/g, '_'));
  return `${mode}; filename="${asciiName}"; filename*=UTF-8''${utf8Encoded}`;
}

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
  const e = normalizeEmail(email);
  if (!ALLOWED_EMAIL_DOMAIN) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  return e.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

// --- FUNCIONES DE SEGURIDAD ---

function validatePasswordStrength(password) {
  if (password.length < 12) return { valid: false, error: 'La contraseña debe tener al menos 12 caracteres.' };
  if (Buffer.byteLength(password, 'utf8') > 72) return { valid: false, error: 'La contraseña no debe superar los 72 caracteres.' };
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
      const lockFilter = {
        email: normalizedId,
        $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }]
      };
      await col('users').updateOne(
        lockFilter,
        { $set: { status: 'bloqueada', lockedUntil } }
      );
      await col('employees').updateOne(
        lockFilter,
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
  // Iguala el tiempo de respuesta en todos los caminos de fallo (anti timing side-channel):
  // siempre se ejecuta un bcrypt.compare (real o contra un hash ficticio).
  const equalizeTiming = async () => {
    const dummyHash = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7f5D5bJ9K6nXJ6kQxHjV7uWlPmQxI4y';
    if (user.password) { try { await bcrypt.compare(password, user.password); } catch (_) {} }
    else { try { await bcrypt.compare(password, dummyHash); } catch (_) {} }
  };

  if (user.status === 'bloqueada' && user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    // Respuesta unificada (anti-enumeración): idéntica a credenciales erróneas.
    await equalizeTiming();
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }
  if (user.status === 'bloqueada' && (!user.lockedUntil || new Date(user.lockedUntil) <= new Date())) {
    await col(collectionName).updateOne({ _id: user._id }, { $set: { status: 'activa', lockedUntil: null, failedAttempts: 0 } });
    user.status = 'activa';
  }
  // Mensajes unificados: no revelar el estado de la cuenta (anti-enumeración).
  // Un usuario pendiente/suspendido/inactivo ve la misma respuesta que una credencial errónea.
  if (user.status === 'pendiente' || user.status === 'suspendida' || user.status === 'inactiva'
    || (role === 'funcionario' && user.active === false) || user.status === 'bloqueada') {
    await equalizeTiming();
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
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
      if (user.mustChangePassword) responseUser.mustChangePassword = true;
      return res.json({ token, user: responseUser });
    }
    const result = await recordLoginAttempt(username, false, ip);
    if (result.locked) {
      await addAuditLog('Cuenta Bloqueada', `La cuenta del ${role === 'admin' ? 'usuario' : 'funcionario'} ${user.name} fue bloqueada por ${MAX_LOGIN_ATTEMPTS} intentos fallidos.`, user.name, ip);
      await addSecurityLog('Cuenta Bloqueada', `Cuenta ${user.email} bloqueada por ${MAX_LOGIN_ATTEMPTS} intentos fallidos.`, ip, user.email);
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }
    await addSecurityLog('Login Fallido', `Contraseña incorrecta para ${user.email}.`, ip, user.email);
    return res.status(401).json({ error: 'Credenciales incorrectas.' });
  }
  return null;
}

// --- CAMBIO DE CONTRASEÑA COMPARTIDO ---
async function handleChangePasswordForRole(user, currentPassword, newPassword, role, ip, res) {
  const collectionName = getCollectionForRole(role);
  const lookupField = getLookupForRole(role, user);
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
  await col(collectionName).updateOne({ _id: doc._id }, { $set: { password: newHash, jwtVersion: newVersion, mustChangePassword: false } });
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
  const collection = getCollectionForRole(role);
  const user = await col(collection).findOne({ email });
  if (!user || !user.passwordHistory) return false;
  for (const oldHash of user.passwordHistory.slice(-PASSWORD_HISTORY_SIZE)) {
    if (await bcrypt.compare(newPassword, oldHash)) return true;
  }
  return false;
}

async function addToPasswordHistory(email, hashedPassword, role) {
  const collection = getCollectionForRole(role);
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
      'email.manage',
      'deletion.create'
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
      id: generateId('log'),
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
  return `${base}_${Date.now()}_${crypto.randomBytes(5).toString('hex')}${ext}`;
}

// --- HELPERS COMPARTIDOS (anti-duplicación) ---
function getCollectionForRole(role) {
  return role === 'admin' ? 'users' : 'employees';
}

function getLookupForRole(role, user) {
  return role === 'admin' ? { email: user.email } : { id: user.employeeId };
}

function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') return f;
  }
  return null;
}

function validateDocStatus(status) {
  if (status !== undefined && !VALID_DOC_STATUSES.includes(status)) {
    return `Estado no válido. Valores permitidos: ${VALID_DOC_STATUSES.join(', ')}.`;
  }
  return null;
}

// Valida fechas de emisión/vencimiento en formato YYYY-MM-DD (o ISO) y que
// expiryDate no sea anterior a issueDate. Devuelve null si todo es correcto.
function validateDocDates(issueDate, expiryDate) {
  const parseDate = (value) => {
    if (value === undefined || value === null || String(value).trim() === '') return { ok: true, value: null };
    const date = new Date(value);
    if (isNaN(date.getTime())) return { ok: false };
    return { ok: true, value: date };
  };
  const issue = parseDate(issueDate);
  if (!issue.ok) return 'La fecha de emisión no es válida.';
  const expiry = parseDate(expiryDate);
  if (!expiry.ok) return 'La fecha de vencimiento no es válida.';
  if (issue.value && expiry.value && expiry.value < issue.value) {
    return 'La fecha de vencimiento no puede ser anterior a la fecha de emisión.';
  }
  return null;
}

function validateDescription(description) {
  if (description !== undefined && description !== null && String(description).length > 2000) {
    return 'La descripción no puede superar los 2000 caracteres.';
  }
  return null;
}

// El archivo debe estar en la bandeja del escáner (local) o ser un archivo de escáner sin registrar en GridFS
async function isFileInScannerTray(filename) {
  const scanPath = getSafeFilePath(SCANNER_DIR, filename);
  if (scanPath && fs.existsSync(scanPath)) return true;
  return (await listFilesBySource('scanner', false).catch(() => []))
    .some(f => f.filename === filename);
}

async function rollbackStoredAttachments(filenames) {
  for (const fn of filenames) { try { await deleteFileByName(fn); } catch (e) { /* ignorar */ } }
}

// Valida que el contenido coincida con la extensión (magic bytes).
// Evita que un .pdf sea en realidad HTML/script u otro binario.
function validateFileContent(filename, buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (!buffer || buffer.length < 4) return null;
  const head = buffer.subarray(0, 12);
  const startsWith = bytes => bytes.every((b, i) => head[i] === b);
  const zip = [0x50, 0x4b, 0x03, 0x04];        // PK\x03\x04 (docx/xlsx/pptx/odt/ods)
  const ole = [0xd0, 0xcf, 0x11, 0xe0];        // OLE2 (doc/xls/ppt)

  const expectations = [
    ['.pdf', [0x25, 0x50, 0x44, 0x46]],
    ['.png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
    ['.jpg', [0xff, 0xd8, 0xff]], ['.jpeg', [0xff, 0xd8, 0xff]],
    ['.gif', [0x47, 0x49, 0x46, 0x38]],
    ['.bmp', [0x42, 0x4d]],
    ['.tif', [0x49, 0x49, 0x2a, 0x00]], ['.tiff', [0x49, 0x49, 0x2a, 0x00]],
    ['.docx', zip], ['.xlsx', zip], ['.pptx', zip], ['.odt', zip], ['.ods', zip],
    ['.doc', ole], ['.xls', ole], ['.ppt', ole]
  ];
  const match = expectations.find(e => e[0] === ext);
  if (!match) return null; // .txt/.csv/.rtf: sin firma binaria, no se valida
  return startsWith(match[1])
    ? null
    : `El archivo '${filename}' no coincide con su extensión (${ext}). Verifique que sea un archivo válido.`;
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

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function createDoc({ filename, originalName, employeeId, employeeName, documentTypeId, categoryId, description, issueDate, expiryDate, status, fileSize, uploadedBy, uploadedByEmployee, visibleToEmployee, sourceEmailId, sourceSenderEmail }) {
  if (status !== undefined && !VALID_DOC_STATUSES.includes(status)) {
    throw new Error(`Estado no válido para el documento: ${status}`);
  }
  return {
    id: generateId('doc'),
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
  const datesError = validateDocDates(issueDate, expiryDate);
  if (datesError) return { error: datesError, status: 400 };
  const descError = validateDescription(description);
  if (descError) return { error: descError, status: 400 };
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
        let buf;
        try {
          const stat = fs.statSync(sourcePath);
          if (stat.size > MAX_REGISTER_BYTES) {
            return { error: `El archivo '${filename}' supera el tamaño máximo permitido (${Math.round(MAX_REGISTER_BYTES / 1024 / 1024)} MB).`, status: 400 };
          }
        } catch (e) { return { error: `El archivo '${filename}' ya no está disponible en la bandeja.`, status: 404 }; }
        try { buf = fs.readFileSync(sourcePath); }
        catch (e) { return { error: `El archivo '${filename}' ya no está disponible en la bandeja.`, status: 404 }; }
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
          let fileSizeCheck = 0;
          try { fileSizeCheck = fs.statSync(filePath).size; }
          catch (e) { return { error: `El archivo '${filename}' ya no está disponible.`, status: 404 }; }
          if (fileSizeCheck > MAX_REGISTER_BYTES) {
            return { error: `El archivo '${filename}' supera el tamaño máximo permitido (${Math.round(MAX_REGISTER_BYTES / 1024 / 1024)} MB).`, status: 400 };
          }
          targetFilename = filename;
          let buf;
          try { buf = fs.readFileSync(filePath); }
          catch (e) { return { error: `El archivo '${filename}' ya no está disponible.`, status: 404 }; }
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

// Registro compartido de adjunto de correo (admin y funcionario). `email` ya fue cargado
// por la ruta (para validar propiedad o armar metadatos). Encapsula: verificación del adjunto,
// registro con lock y marcado del adjunto como registrado. Devuelve { doc } o { error, status }.
async function registerEmailAttachmentCore({ req, email, emailId, filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status, auditAction, auditMessageTemplate, extraDocFields }) {
  const attachment = (email.attachments || []).find(a => a.filename === filename);
  if (!attachment) return { error: 'Archivo adjunto no encontrado.', status: 404 };
  if (attachment.registered) return { error: 'Este adjunto ya fue registrado como documento.', status: 409 };

  const result = await withRegisterLock(filename, () => registerDocumentCore({
    req, filename, employeeId, documentTypeId, categoryId,
    description: description || `Ingresado desde correo de ${email.senderName} (${email.senderEmail}) - Asunto: ${email.subject}.`,
    issueDate, expiryDate,
    status: status || 'Pendiente',
    sourceDir: GMAIL_INBOX_DIR, mover: true,
    auditAction,
    auditMessageTemplate,
    extraDocFields: { sourceEmailId: emailId, sourceSenderEmail: email.senderEmail || email.sender, ...(extraDocFields || {}) },
    actor: req.user.name
  }));
  if (result.error) return result;

  await col('emailsInbox').updateOne(
    { id: emailId, 'attachments.filename': filename },
    { $set: { 'attachments.$.registered': true } }
  );
  return result;
}

// Eliminación compartida de un documento y su archivo físico (GridFS y/o disco).
// El registro siempre se elimina; el archivo físico solo se borra si ningún otro
// documento lo comparte, para no dejar documentos huérfanos.
// Se serializa por filename (withRegisterLock) para evitar la race read-then-write
// entre el conteo de copias y el borrado físico.
async function deleteDocAndPhysicalFile(id, filename) {
  await withRegisterLock(filename, async () => {
    const sharingDocs = await col('documents').countDocuments({ filename, id: { $ne: id } });
    await col('documents').deleteOne({ id });
    if (sharingDocs === 0) {
      // Además de documentos, verificar que el archivo no lo referencie un adjunto de correo
      const emailRefs = await col('emailsInbox').countDocuments({ 'attachments.filename': filename });
      const fileRefs = await col('documents').countDocuments({ filename });
      if (emailRefs > 0 || fileRefs > 0) {
        console.warn(`[DEL] El archivo '${filename}' sigue referenciado (emails: ${emailRefs}, docs: ${fileRefs}); no se elimina físicamente.`);
        return;
      }
      await deleteFileByName(filename);
      const filePath = getSafeFilePath(DOCUMENTS_DIR, filename);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      console.warn(`[DEL] El archivo '${filename}' lo comparten ${sharingDocs} documento(s); no se elimina físicamente.`);
    }
  });
}

function createGmailAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REDIRECT_URI) {
    const error = new Error('Faltan variables de configuración de Gmail.');
    error.code = 'GMAIL_NOT_CONFIGURED';
    throw error;
  }
  const { google } = require('googleapis');
  return new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI);
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
  // timeout acota cada llamada a la API de Google (evita que una llamada colgada
  // deje la sincronización atascada para siempre).
  return require('googleapis').google.gmail({ version: 'v1', auth, timeout: 60000 });
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
    const collection = getCollectionForRole(decoded.role);
    const dbUser = await col(collection).findOne(
      { email: decoded.email },
      { projection: { jwtVersion: 1, status: 1, active: 1, id: 1, name: 1, mustChangePassword: 1 } }
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
    if (dbUser.mustChangePassword && !req.originalUrl.includes('/auth/change-password')) {
      return res.status(403).json({ error: 'Debe cambiar su contraseña antes de continuar.', mustChangePassword: true });
    }
    req.user = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicie sesión nuevamente.' });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Token inválido. Inicie sesión nuevamente.' });
    }
    // Error de BD/red (p. ej. TLS transitorio de Atlas): 503 en vez de 401,
    // para que el frontend no fuerce un logout ante un problema temporal.
    return res.status(503).json({ error: 'Error temporal de base de datos. Intente de nuevo en unos segundos.' });
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
  // Consumo atómico del token (findOneAndDelete): garantiza single-use aunque dos
  // peticiones concurrentes envíen el mismo token.
  const activationToken = await col('activationTokens').findOneAndDelete({ tokenHash });
  if (!activationToken) return res.status(400).json({ error: 'Token de activación inválido o ya utilizado.' });
  if (new Date(activationToken.expiresAt) < new Date()) {
    return res.status(400).json({ error: 'El token de activación ha expirado. Solicite uno nuevo al administrador.' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  // Seguridad: un token de activación solo puede activar cuentas pendientes/inactivas.
  // No re-activar cuentas suspendidas o bloqueadas.
  const targetCollection = getCollectionForRole(activationToken.role);
  const target = await col(targetCollection).findOne({ email: activationToken.email });
  if (!target) return res.status(404).json({ error: 'Cuenta no encontrada.' });
  if (target.status === 'suspendida' || target.status === 'bloqueada' || target.status === 'inactiva' || target.status === 'activa') {
    return res.status(403).json({ error: 'Esta cuenta no está pendiente de activación.' });
  }

  if (activationToken.role === 'admin') {
    await col('users').updateOne(
      { email: activationToken.email },
      { $set: { status: 'activa', password: hashedPassword, mustChangePassword: false } }
    );
  } else {
    await col('employees').updateOne(
      { email: activationToken.email },
      { $set: { status: 'activa', active: true, password: hashedPassword, mustChangePassword: false } }
    );
  }

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
  const logoUrl = baseUrl ? `${baseUrl}/Escudo_Valledupar.png` : 'Escudo_Valledupar.png';
  const sent = await sendEmail({
    to: normalizedEmail,
    subject: 'Restablecimiento de contraseña — Sistema de Talento Humano',
    html: resetUrl
      ? `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#1A5276 0%,#154360 50%,#0E2F44 100%);padding:32px 40px;text-align:center;">
            <img src="${logoUrl}" alt="Escudo de Valledupar" width="72" height="72" style="display:block;margin:0 auto 16px;border-radius:14px;background:rgba(255,255,255,0.12);padding:8px;">
            <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">Sistema de Talento Humano</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Alcaldía de Valledupar</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 16px;color:#333;font-size:15px;">Hola <strong>${escapeHtml(user.name)}</strong>,</p>
            <p style="margin:0 0 20px;color:#555;font-size:14px;line-height:1.6;">
              Recibimos una solicitud para restablecer su contraseña. Haga clic en el botón de abajo para crear una nueva contraseña.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px 0 24px;">
                  <a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#1A5276;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;">Restablecer mi contraseña</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#999;font-size:12px;line-height:1.5;">El enlace es válido por <strong>1 hora</strong>. Si no lo solicitó, ignore este correo.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8f9fa;border-top:1px solid #eee;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#aaa;font-size:11px;">Sistema de Gestión Documental — Talento Humano · Alcaldía de Valledupar</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
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
  // Consumo atómico del token (findOneAndDelete): single-use garantizado aunque haya
  // peticiones concurrentes con el mismo token.
  const resetToken = await col('passwordResetTokens').findOneAndDelete({ tokenHash, used: false });
  if (!resetToken) return res.status(400).json({ error: 'Token inválido o ya utilizado.' });
  if (new Date(resetToken.expiresAt) < new Date()) return res.status(400).json({ error: 'El token ha expirado.' });

  const hashedPassword = await bcrypt.hash(password, 12);
  const newVersion = { $inc: { jwtVersion: 1 } };

  // Seguridad: no forzar status:'activa'. Solo se limpia el bloqueo; cuentas
  // suspendidas/desactivadas siguen sin poder entrar hasta que el admin las reactive.
  const currentUser = await col(getCollectionForRole(resetToken.role)).findOne({ email: resetToken.email });
  const currentStatus = currentUser?.status;
  if (currentStatus === 'suspendida' || currentStatus === 'inactiva' || (resetToken.role === 'funcionario' && !currentUser?.password)) {
    return res.status(403).json({ error: 'Su cuenta no puede restablecer la contraseña. Contacte al administrador.' });
  }

  // Evitar reutilizar una contraseña reciente al restablecer.
  if (await checkPasswordHistory(resetToken.email, password, resetToken.role)) {
    return res.status(400).json({ error: 'La nueva contraseña ya fue usada recientemente. Elija otra.' });
  }

  if (resetToken.role === 'admin') {
    await col('users').updateOne({ email: resetToken.email }, { $set: { password: hashedPassword, mustChangePassword: false, lockedUntil: null, failedAttempts: 0 }, ...newVersion });
    await addToPasswordHistory(resetToken.email, hashedPassword, 'admin');
  } else {
    await col('employees').updateOne({ email: resetToken.email }, { $set: { password: hashedPassword, mustChangePassword: false, lockedUntil: null, failedAttempts: 0 }, ...newVersion });
    await addToPasswordHistory(resetToken.email, hashedPassword, 'funcionario');
  }
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



app.post('/api/funcionario/subir-documento', authMiddleware, uploadLimiter, upload.single('file'), async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  if (!req.file) return res.status(400).json({ error: 'No se proporcionó ningún archivo o el formato no es válido.' });

  const empleadoId = req.user.employeeId;
  const { documentTypeId, categoryId, description, issueDate } = req.body;
  if (requireFields(req.body, ['documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  const contentErr = validateFileContent(req.file.originalname, req.file.buffer);
  if (contentErr) return res.status(400).json({ error: contentErr });

  const employee = await col('employees').findOne({ id: empleadoId });
  if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

  const result = await registerDocumentCore({
    req, filename: req.file.originalname, employeeId: empleadoId, documentTypeId, categoryId, description, issueDate,
    fileBuffer: req.file.buffer, gridFSSource: 'upload',
    auditAction: 'Carga por Funcionario',
    auditMessageTemplate: (emp, type, fn) => `${emp} subió el archivo '${fn}' (${type}).`,
    extraDocFields: { uploadedBy: employee.name, uploadedByEmployee: true },
    actor: employee.name
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.doc);
});

app.post('/api/funcionario/register-scanner', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  const { filename, documentTypeId, categoryId, description, issueDate, expiryDate } = req.body;
  if (requireFields(req.body, ['filename', 'documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }

  if (!(await isFileInScannerTray(filename))) {
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
  if (requireFields(req.body, ['emailId', 'filename', 'documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  const email = await col('emailsInbox').findOne({ id: emailId });
  if (!email) return res.status(404).json({ error: 'Correo electrónico no encontrado.' });
  if (email.suggestedEmployeeId && email.suggestedEmployeeId !== req.user.employeeId) {
    return res.status(403).json({ error: 'No tiene permisos para registrar adjuntos de este correo.' });
  }

  // Un funcionario solo puede dejar el documento en revisión; el estado lo fija el administrador.
  const result = await registerEmailAttachmentCore({
    req, email, emailId, filename, employeeId: req.user.employeeId, documentTypeId, categoryId,
    description: description || `Ingresado desde correo de ${email.senderName} - Asunto: ${email.subject}.`,
    issueDate, expiryDate, status: 'Pendiente',
    auditAction: 'Correo por Funcionario',
    auditMessageTemplate: (emp, type, fn) => `${emp} registró el adjunto '${fn}' del correo de ${email.senderName} (${type}).`,
    extraDocFields: { uploadedBy: req.user.name || 'Funcionario', uploadedByEmployee: true }
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
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
  if (!id) id = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') + crypto.randomInt(0, 1000).toString().padStart(3, '0');
  if (!name) name = id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();
  if (!position) position = 'Funcionario';
  if (!isAllowedInstitutionalEmail(email)) {
    const hint = ALLOWED_EMAIL_DOMAIN ? ` (@${ALLOWED_EMAIL_DOMAIN})` : '';
    return res.status(400).json({ error: `El correo del funcionario no es válido${hint}.` });
  }
  if (await col('employees').findOne({ id })) {
    return res.status(400).json({ error: 'Ya existe un empleado con esta identificación (Cédula).' });
  }
  if (await col('employees').findOne({ email: normalizeEmail(email) })) {
    return res.status(400).json({ error: 'Ya existe un empleado con este correo electrónico.' });
  }
  if (await col('users').findOne({ email: normalizeEmail(email) })) {
    return res.status(400).json({ error: 'El correo electrónico ya pertenece a una cuenta de administrador.' });
  }

  const tempPassword = generateTempPassword();
  const tempHash = await bcrypt.hash(tempPassword, 12);

  const newEmployee = {
    id, name, department, position,
    email: normalizeEmail(email),
    status: 'activa',
    active: true,
    mustChangePassword: true,
    password: tempHash,
    registeredAt: new Date().toISOString(),
    registeredBy: 'Administrador',
    failedAttempts: 0,
    lockedUntil: null
  };
  try {
    await col('employees').insertOne(newEmployee);
  } catch (insertErr) {
    if (insertErr.code === 11000) {
      return res.status(400).json({ error: 'Ya existe un empleado con esta identificación o correo electrónico.' });
    }
    throw insertErr;
  }

  await addAuditLog('Crear Empleado', `Se registró al funcionario ${name} con C.C. ${id}. Contraseña temporal generada y enviada por correo.`, 'Administrador', ip);

  const baseUrl = getAppBaseUrl(req);
  const logoUrl = baseUrl ? `${baseUrl}/Escudo_Valledupar.png` : 'Escudo_Valledupar.png';
  const loginUrl = baseUrl || '#';
  const emailSent = await sendEmail({
    to: normalizeEmail(email),
    subject: 'Credenciales de acceso — Sistema de Talento Humano',
    html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head><body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 20px;"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);"><tr><td style="background:linear-gradient(135deg,#1A5276 0%,#154360 50%,#0E2F44 100%);padding:32px 40px;text-align:center;"><img src="${logoUrl}" alt="Escudo" width="72" height="72" style="display:block;margin:0 auto 16px;border-radius:14px;background:rgba(255,255,255,0.12);padding:8px;"><h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">Sistema de Talento Humano</h1><p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Alcald&iacute;a de Valledupar</p></td></tr><tr><td style="padding:36px 40px;"><p style="margin:0 0 16px;color:#333;font-size:15px;">Hola <strong>${escapeHtml(name)}</strong>,</p><p style="margin:0 0 20px;color:#555;font-size:14px;line-height:1.6;">Se cre&oacute; su cuenta en el Sistema de Gesti&oacute;n Documental de la Alcald&iacute;a de Valledupar. A continuaci&oacute;n sus credenciales de acceso iniciales:</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7fb;border:1px solid #d6e8f2;border-radius:8px;margin-bottom:24px;"><tr><td style="padding:20px 24px;"><p style="margin:0 0 4px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Correo electr&oacute;nico</p><p style="margin:0 0 16px;color:#1A5276;font-size:16px;font-weight:700;">${escapeHtml(normalizeEmail(email))}</p><p style="margin:0 0 4px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Contrase&ntilde;a temporal</p><p style="margin:0 0 4px;color:#c0392b;font-size:18px;font-weight:700;font-family:Consolas,Monaco,monospace;letter-spacing:1px;">${escapeHtml(tempPassword)}</p><p style="margin:8px 0 0;color:#e67e22;font-size:12px;font-weight:600;">Debe cambiar esta contrase&ntilde;a en su primer inicio de sesi&oacute;n.</p></td></tr></table><p style="margin:0 0 12px;color:#555;font-size:14px;line-height:1.6;">Ingrese al sistema con las credenciales anteriores. Ser&aacute; obligatorio crear una nueva contrase&ntilde;a.</p><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:8px 0 24px;"><a href="${loginUrl}" style="display:inline-block;background:#1A5276;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;">Ingresar al sistema</a></td></tr></table><p style="margin:0;color:#999;font-size:12px;line-height:1.5;">Por seguridad, cambie su contrase&ntilde;a lo antes posible. Si no solicit&oacute; esta cuenta, ignore este correo.</p></td></tr><tr><td style="background:#f8f9fa;border-top:1px solid #eee;padding:20px 40px;text-align:center;"><p style="margin:0;color:#aaa;font-size:11px;">Sistema de Gesti&oacute;n Documental &mdash; Talento Humano &middot; Alcald&iacute;a de Valledupar</p></td></tr></table></td></tr></table></body></html>`,
    text: `Hola ${name},\n\nSe creó su cuenta en el Sistema de Gestión Documental de la Alcaldía de Valledupar.\n\nCorreo: ${normalizeEmail(email)}\nContraseña temporal: ${tempPassword}\n\nDebe cambiar esta contraseña en su primer inicio de sesión.\nInicie sesión en: ${loginUrl}\n\nSi no solicitó esta cuenta, ignore este correo.`
  });

  res.status(201).json({
    ...newEmployee,
    password: undefined,
    ...(emailSent
      ? { emailSent: true, message: 'Empleado creado. Se enviaron las credenciales de acceso al correo del funcionario.' }
      : { emailSent: false, tempPassword, message: `Empleado creado. No se pudo enviar el correo. Contraseña temporal: ${tempPassword}` })
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
    // Al desactivar: si quedaba pendiente, se fuerza 'inactiva' y se invalidan sus tokens de
    // activación/reset para que no pueda reactivarse solo con el enlace que ya recibió.
    const newStatus = wasPending && !newActive ? 'inactiva' : (wasPending ? 'pendiente' : (newActive ? 'activa' : 'inactiva'));
    await col('employees').updateOne({ id }, { $set: { active: newActive, status: newStatus } });
    await col('employees').updateOne({ id }, { $inc: { jwtVersion: 1 } });
    if (!newActive) {
      await col('activationTokens').deleteMany({ email: employee.email });
      await col('passwordResetTokens').deleteMany({ email: employee.email });
    }

    const statusText = wasPending ? 'pendiente de activación' : (newActive ? 'activado' : 'desactivado');
    const statusEmoji = newActive ? '✓' : '✕';
    await addAuditLog(`${statusEmoji} ${newActive ? 'Reactivar' : 'Desactivar'} Empleado`, `El funcionario ${employee.name} (C.C. ${id}) fue ${statusText}.`, req.user.name, ip);
    res.json({ message: `Funcionario "${employee.name}" ${statusText} exitosamente.`, active: newActive, status: newStatus });
  } catch (error) {
    console.error('[TOGGLE-ACTIVE] Error:', error);
    res.status(500).json({ error: 'Error al cambiar estado del funcionario.' });
  }
});

// --- FUNCIONARIO: ACTUALIZAR PROPIO NOMBRE ---
app.put('/api/employees/profile', authMiddleware, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'El nombre es obligatorio.' });
    const trimmed = name.trim();
    if (trimmed.length < 3 || trimmed.length > 100) return res.status(400).json({ error: 'El nombre debe tener entre 3 y 100 caracteres.' });

    const employee = await col('employees').findOne({ email: req.user.email });
    if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

    await col('employees').updateOne({ _id: employee._id }, { $set: { name: trimmed } });
    await addAuditLog('Actualizar Nombre', `El funcionario ${employee.name} actualizó su nombre a "${trimmed}".`, employee.email, req.ip);
    res.json({ message: 'Nombre actualizado exitosamente.', name: trimmed });
  } catch (error) {
    console.error('[PROFILE] Error:', error);
    res.status(500).json({ error: 'Error al actualizar el nombre.' });
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
      // Solo cuentan administradores realmente activos (status 'activa')
      const activeAdmins = await col('users').countDocuments({ role: 'admin', status: 'activa', active: true });
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
    // Consultas secuenciales para evitar limpieza del pool TLS bajo carga paralela.
    // Con límites para no cargar colecciones completas en memoria (paginación liviana).
    const documentTypes = await col('documentTypes').find().toArray();
    const categories = await col('categories').find().toArray();
    const employees = await col('employees').find({}, { projection: { password: 0, passwordHistory: 0 } }).toArray();
    const documents = await col('documents').find().sort({ registeredAt: -1 }).limit(1000).toArray();
    const auditLogs = await col('auditLogs').find().sort({ timestamp: -1 }).limit(500).toArray();
    const deletionRequests = await col('deletionRequests').find().sort({ createdAt: -1 }).limit(200).toArray();
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
      // Se consulta la lista completa de filenames registrados (distinct) para que el
      // límite de `documents` no haga aparecer archivos antiguos como "no registrados".
      unregisteredFiles = await getUnregisteredFiles();
    } catch (e) { console.warn('Error obteniendo archivos no registrados:', e.message); }

    let scannerFiles = [];
    try {
      scannerFiles = await getScannerFiles();
    } catch (e) { console.warn('Error obteniendo archivos del escáner:', e.message); }

    let emails = [];
    try {
      emails = await col('emailsInbox').find().sort({ date: -1 }).limit(200).toArray();
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
  res.json(await col('documents').find().sort({ registeredAt: -1 }).limit(1000).toArray());
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
  if (requireFields(req.body, ['filename', 'employeeId', 'documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar el documento.' });
  }
  const statusErr = validateDocStatus(status);
  if (statusErr) return res.status(400).json({ error: statusErr });
  // Evitar registrar el mismo archivo dos veces (crearía documentos duplicados sobre el mismo PDF)
  const existing = await col('documents').findOne({ filename });
  if (existing) {
    return res.status(409).json({ error: `El archivo '${filename}' ya está registrado (documento ${existing.id}).` });
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

app.post('/api/documents/upload', authMiddleware, requirePermission('documents.create'), uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se proporcionó ningún archivo o el formato no es válido.' });

  const { employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (requireFields(req.body, ['employeeId', 'documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar el documento cargado.' });
  }
  const statusErr = validateDocStatus(status);
  if (statusErr) return res.status(400).json({ error: statusErr });
  const contentErr = validateFileContent(req.file.originalname, req.file.buffer);
  if (contentErr) return res.status(400).json({ error: contentErr });

  const result = await registerDocumentCore({
    req, filename: req.file.originalname, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status,
    fileBuffer: req.file.buffer, gridFSSource: 'upload',
    auditAction: 'Carga de Documento',
    auditMessageTemplate: (emp, type, fn) => `Se subió y registró el archivo '${fn}' para ${emp} (${type}).`,
    extraDocFields: { uploadedBy: 'Sistema' },
    actor: req.user.name
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.doc);
});

app.put('/api/documents/:id', authMiddleware, requirePermission('documents.update'), async (req, res) => {
  const { id } = req.params;
  const { employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;

  const doc = await col('documents').findOne({ id });
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });

  const datesError = validateDocDates(issueDate, expiryDate);
  if (datesError) return res.status(400).json({ error: datesError });
  const descError = validateDescription(description);
  if (descError) return res.status(400).json({ error: descError });

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
  if (issueDate !== undefined) updates.issueDate = issueDate;
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
      await deleteDocAndPhysicalFile(id, doc.filename);
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
      id: generateId('delreq'),
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

// El funcionario puede consultar el estado de SUS solicitudes de eliminación.
app.get('/api/funcionario/deletion-requests', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  try {
    const requests = await col('deletionRequests')
      .find({ employeeId: req.user.employeeId })
      .sort({ createdAt: -1 }).toArray();
    res.json(requests);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error al obtener solicitudes.' });
  }
});

app.patch('/api/deletion-requests/:id/approve', authMiddleware, requirePermission('employees.read'), async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo administradores pueden aprobar eliminaciones.' });

    // Consumo atómico de la solicitud: solo se procesa si sigue Pendiente (anti doble-aprobación)
    const request = await col('deletionRequests').findOneAndUpdate(
      { id: req.params.id, status: 'Pendiente' },
      { $set: { status: 'Aprobada', processedBy: req.user.name || req.user.email, processedAt: new Date().toISOString() } },
      { returnDocument: 'before' }
    );
    if (!request) {
      const exists = await col('deletionRequests').findOne({ id: req.params.id });
      if (!exists) return res.status(404).json({ error: 'Solicitud no encontrada.' });
      return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });
    }

    const doc = await col('documents').findOne({ id: request.documentId });
    if (doc) {
      await deleteDocAndPhysicalFile(doc.id, doc.filename);
    }

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

    const request = await col('deletionRequests').findOneAndUpdate(
      { id: req.params.id, status: 'Pendiente' },
      { $set: { status: 'Rechazada', processedBy: req.user.name || req.user.email, processedAt: new Date().toISOString() } },
      { returnDocument: 'before' }
    );
    if (!request) {
      const exists = await col('deletionRequests').findOne({ id: req.params.id });
      if (!exists) return res.status(404).json({ error: 'Solicitud no encontrada.' });
      return res.status(400).json({ error: 'Esta solicitud ya fue procesada.' });
    }

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
      res.setHeader('Content-Disposition', buildContentDisposition(mimeType, filename));
      r.stream.on('error', (err) => { console.warn('Error en stream de descarga:', err.message); res.destroy(); });
      // Si el cliente aborta la descarga, destruir el stream para liberar el cursor de GridFS.
      req.on('close', () => { if (!res.writableEnded) { try { r.stream.destroy(); } catch (e) {} } });
      r.stream.pipe(res);
      return;
    }
  } catch (e) { console.warn('Error al leer archivo de GridFS para descarga:', e.message); }

  const filePath = path.join(targetDir, filename);
  if (fs.existsSync(filePath)) {
    const mimeType = getMimeType(filename);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', buildContentDisposition(mimeType, filename));
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'Archivo no encontrado en el servidor.' });
  }
});

// --- REGISTROS DE AUDITORÍA ---
app.get('/api/audit-logs', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 500, 1000));
  res.json(await col('auditLogs').find().sort({ timestamp: -1 }).limit(limit).toArray());
});

app.get('/api/security-logs', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
  res.json(await col('securityLogs').find().sort({ timestamp: -1 }).limit(limit).toArray());
});

// --- ESCÁNER ---
app.get('/api/scanner-files', authMiddleware, requirePermission('scanner.read'), async (req, res) => {
  res.json(await getScannerFiles());
});

// --- ESTADO DEL ESCÁNER (Detección USB + Red + Monitoreo de bandeja) ---
function runPs(cmd) {
  return new Promise((resolve) => {
    const full = `$ProgressPreference='SilentlyContinue';${cmd}`;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: 20000, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const raw = (stdout || '').replace(/#< CLIXML[\s\S]*?<\/Objs>\s*/g, '').trim();
        if (error && !raw) { console.warn('Error ejecutando PowerShell:', error.message); return resolve(''); }
        resolve(raw);
      });
  });
}

// Versión asíncrona: no bloquea el event loop y admite timeouts largos (escaneo WIA).
function runPsAsync(cmd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const full = `$ProgressPreference='SilentlyContinue';${cmd}`;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const raw = (stdout || '').replace(/#< CLIXML[\s\S]*?<\/Objs>\s*/g, '').trim();
        if (error && !raw) { console.warn('Error ejecutando PowerShell (async):', error.message); return resolve(''); }
        resolve(raw);
      });
  });
}

async function detectUsbScanners() {
  const raw = await runPs(`
    $scanners = @()

    # Método 1: WIA COM (WIA.DeviceManager; WIA.Devices ya no se registra en Windows moderno)
    try {
      $deviceManager = New-Object -ComObject WIA.DeviceManager
      foreach ($di in $deviceManager.DeviceInfos) {
        if (($di.Type -band 1) -eq 1) {
          $desc = ''
          $mfr = ''
          foreach ($p in $di.Properties) {
            if ($p.PropertyID -eq 4) { $desc = [string]$p.Value }
            if ($p.PropertyID -eq 3) { $mfr = [string]$p.Value }
          }
          $scanners += [PSCustomObject]@{ Name = $desc; Status = 'Conectado'; Manufacturer = $mfr }
        }
      }
    } catch {}

    # Método 2: PnP Image devices (detecta escáneres con driver TWAIN/WIA)
    try {
      Get-PnpDevice -Status OK -Class Image -ErrorAction SilentlyContinue | ForEach-Object {
        $exists = $false
        foreach ($s in $scanners) { if ($s.Name -eq $_.FriendlyName) { $exists = $true; break } }
        if (-not $exists) {
          $scanners += [PSCustomObject]@{ Name = $_.FriendlyName; Status = 'Conectado'; Manufacturer = '' }
        }
      }
    } catch {}

    # Método 3: PnP devices con error de driver (informar al usuario)
    try {
      Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'scanner|scan|perfection|flatbed|image' -and $_.Status -eq 'Error' } | ForEach-Object {
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

async function detectNetworkScanners() {
  const subnet = getLocalSubnet();
  const raw = await runPs(`
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
  const names = await Promise.all(openHosts.map(async (host) => {
    const nameRaw = await runPs(`try { $r = Invoke-WebRequest -Uri "http://${host.ip}:9100" -TimeoutSec 1 -UseBasicParsing -ErrorAction SilentlyContinue; $r.Headers['Server'] } catch {}`);
    return nameRaw || `Escáner de Red (${host.ip})`;
  }));
  openHosts.forEach((host, i) => {
    scanners.push({
      name: names[i],
      type: 'Red',
      status: 'Detectado',
      ip: host.ip,
      port: host.port,
      icon: '🌐'
    });
  });
  return scanners;
}

async function detectPrintersWithScanners() {
  const raw = await runPs(`
    $scanners = @()
    try {
      $printers = Get-CimInstance Win32_Printer | Where-Object { -not $_.WorkOffline -and $_.PrinterStatus -notin @(6,7) }
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

async function detectAllScanners() {
  const [usb, net, printers] = await Promise.all([
    detectUsbScanners(),
    detectNetworkScanners(),
    detectPrintersWithScanners()
  ]);

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
let scanInProgress = false;

// Ubica el launcher de EPSON Scan 2 (impresoras multifunción sin driver WIA de escáner).
// Se cachea porque la búsqueda es determinista y el costo es de una sola vez.
let epsonScanLauncher = null;
let epsonScanLauncherChecked = false;
function findEpsonScanLauncher() {
  if (epsonScanLauncherChecked) return epsonScanLauncher;
  epsonScanLauncherChecked = true;
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'EPSON', 'Epson Scan 2', 'Core', 'es2launcher.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'EPSON', 'Epson Scan 2', 'Core', 'es2launcher.exe')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { epsonScanLauncher = c; break; }
  }
  return epsonScanLauncher;
}

// Refresco en segundo plano: no bloquea el event loop durante la detección
// (detectAllScanners ejecuta PowerShell/consultas de red de forma síncrona).
function refreshScannerCacheAsync() {
  if (scannerRefreshRunning) return;
  if ((Date.now() - lastScanCheck) <= SCANNER_CACHE_MS) return;
  scannerRefreshRunning = true;
  detectAllScanners()
    .then(scanners => { cachedScanners = scanners; lastScanCheck = Date.now(); })
    .catch(e => console.error('[SCANNER] Error detecting scanners:', e.message))
    .finally(() => { scannerRefreshRunning = false; });
}

app.get('/api/scanner/status', authMiddleware, requirePermission('scanner.read'), async (req, res) => {
  const now = Date.now();
  const stale = (now - lastScanCheck) > SCANNER_CACHE_MS;
  // Refresco siempre en segundo plano: la detección ejecuta PowerShell síncrono
  // (escaneo de red) y no debe bloquear el event loop.
  if (stale) refreshScannerCacheAsync();

  const trayFiles = await getScannerFiles();

  const connected = cachedScanners.length > 0;

  res.json({
    connected,
    scanners: cachedScanners,
    usbCount: cachedScanners.filter(s => s.type === 'USB').length,
    networkCount: cachedScanners.filter(s => s.type === 'Red').length,
    trayCount: trayFiles.length,
    trayFiles,
    epsonScanAvailable: !!findEpsonScanLauncher(),
    subnet: hasPermission(req.user.role, 'scanner.manage') ? getLocalSubnet() : null,
    lastChecked: new Date(lastScanCheck).toISOString()
  });
});

app.post('/api/scanner/refresh', authMiddleware, requireAnyPermission('scanner.manage', 'scanner.refresh'), scannerLimiter, (req, res) => {
  // Forzar refresco en segundo plano; nunca bloquear el event loop.
  scannerRefreshRunning = false;
  lastScanCheck = 0;
  refreshScannerCacheAsync();
  res.json({ message: 'Actualización de escáneres iniciada. El estado se actualizará en unos segundos.', scanners: cachedScanners, count: cachedScanners.length, refreshing: true });
});

async function scanWithScanner(customName) {
  const escapedDir = SCANNER_DIR.replace(/\\/g, '\\\\');
  const timestamp = Date.now();
  // Nombre base único: el sufijo aleatorio evita colisiones de archivos en la bandeja
  // (antes usaba los últimos 4 dígitos de Date.now(), que colisionaban cada 10 segundos).
  let baseName = (customName || `Escaner_Folio_${timestamp}_${crypto.randomBytes(3).toString('hex')}`)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 200);
  let pdfBase = `${baseName}.pdf`;
  // Si el nombre ya existe en la bandeja (GridFS o disco), generar un sufijo único
  const trayNames = new Set((await getScannerFiles()).map(f => f.filename));
  if (trayNames.has(pdfBase)) {
    pdfBase = `${baseName}_${crypto.randomBytes(4).toString('hex')}.pdf`;
  }
  const tempToken = crypto.randomBytes(4).toString('hex');
  const raw = await runPsAsync(`
    try {
      $deviceManager = New-Object -ComObject WIA.DeviceManager
      $deviceInfo = $deviceManager.DeviceInfos | Where-Object { $_.Type -eq 1 } | Select-Object -First 1
      if (-not $deviceInfo) { throw 'No scanner found' }
      $device = $deviceInfo.Connect()
      $item = $device.Items(1)
      # Fijar resolución horizontal/vertical a 200 dpi. Se itera la colección porque
      # Properties(6147)/Properties.Item(6147) falla con "índice fuera del intervalo"
      # en varios drivers WIA (trata el PID como índice posicional).
      foreach ($prop in $item.Properties) {
        if ($prop.PropertyID -eq 6147 -or $prop.PropertyID -eq 6148) { $prop.Value = 200 }
      }
      # El driver EPSON entrega BMP aunque se pida PNG; se convierte a JPG para el PDF.
      $bmpPath = '${escapedDir}\\_temp_${timestamp}_${tempToken}.bmp'
      $jpgPath = '${escapedDir}\\_temp_${timestamp}_${tempToken}.jpg'
      $image = $item.Transfer('{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}')
      $image.SaveFile($bmpPath)
      Add-Type -AssemblyName System.Drawing
      $img = [System.Drawing.Image]::FromFile($bmpPath)
      try { $img.Save($jpgPath, [System.Drawing.Imaging.ImageFormat]::Jpeg) } finally { $img.Dispose() }
      Remove-Item $bmpPath -ErrorAction SilentlyContinue
      Write-Output $jpgPath
    } catch {
      Write-Output ('ERROR:' + $_.Exception.Message)
    }
  `, 120000);
  if (!raw || raw.startsWith('ERROR:')) {
    const msg = (raw ? raw.replace('ERROR:', '') : '').trim();
    if (msg === 'No scanner found') {
      return 'ERROR:Ningún escáner WIA disponible. Verifique que la impresora esté encendida y conectada (USB o red).';
    }
    return raw;
  }
  const jpgFileName = raw.trim().split(/[\\/]/).pop();
  const tempPath = path.join(SCANNER_DIR, jpgFileName);
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

app.post('/api/scanner/scan', authMiddleware, requireAnyPermission('scanner.manage', 'scanner.scan'), scannerLimiter, async (req, res) => {
  try {
    if (scanInProgress) {
      return res.status(409).json({ error: 'Ya hay un escaneo en curso. Espere a que termine.' });
    }
    if ((Date.now() - lastScanCheck) > SCANNER_CACHE_MS) refreshScannerCacheAsync();
    if (cachedScanners.length === 0) {
      return res.status(400).json({ error: 'No hay escáner conectado.' });
    }
    scanInProgress = true;
    try {
      const customName = req.body.filename ? req.body.filename.trim() : '';
      const result = await scanWithScanner(customName);
      if (!result || result.startsWith('ERROR:')) {
        return res.status(500).json({ error: result ? result.replace('ERROR:', '') : 'Error al escanear.' });
      }
      const filename = result.trim();
      await addAuditLog('Escáner Real', `Documento escaneado: '${filename}'`, req.user.name || 'Sistema', getClientIp(req));
      res.json({ success: true, filename });
    } finally {
      scanInProgress = false;
    }
  } catch (e) {
    scanInProgress = false;
    console.error('[SCAN]', e);
    res.status(500).json({ error: 'Error al ejecutar el escáner.' });
  }
});

app.post('/api/scanner/launch-epson-scan', authMiddleware, requireAnyPermission('scanner.manage', 'scanner.scan'), scannerLimiter, async (req, res) => {
  try {
    const launcher = findEpsonScanLauncher();
    if (!launcher) {
      return res.status(404).json({ error: 'EPSON Scan 2 no está instalado en este equipo.' });
    }
    const child = spawn(launcher, [], { detached: true, stdio: 'ignore' });
    child.on('error', err => console.warn('Error abriendo EPSON Scan 2:', err.message));
    child.unref();
    await addAuditLog('Escáner Real', 'Se abrió EPSON Scan 2 para escanear a la bandeja.', req.user.name || 'Sistema', getClientIp(req));
    res.json({ ok: true, message: 'EPSON Scan 2 abierto. Configure la salida en bandeja_escaner y registre el PDF desde la bandeja.' });
  } catch (e) {
    console.error('[SCAN] Error abriendo EPSON Scan 2:', e.message);
    res.status(500).json({ error: 'Error al abrir EPSON Scan 2.' });
  }
});

app.post('/api/documents/register-scanner', authMiddleware, requirePermission('documents.create'), async (req, res) => {
  const { filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (requireFields(req.body, ['filename', 'employeeId', 'documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios para registrar el documento escaneado.' });
  }
  const statusErr = validateDocStatus(status);
  if (statusErr) return res.status(400).json({ error: statusErr });

  if (!(await isFileInScannerTray(filename))) {
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
    console.error('[GMAIL] Error en /authorize:', error.message, error.code);
    res.status(503).json({ error: 'Gmail no está configurado.', detail: error.message });
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
    // Solo en desarrollo/ejecución local: en producción nunca se imprime.
    if (tokens.refresh_token && process.env.NODE_ENV === 'development') {
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
  res.json(await col('emailsInbox').find().sort({ date: -1 }).limit(200).toArray());
});

// Mutex simple: evita dos sincronizaciones concurrentes que dupliquen archivos/correos
let gmailSyncInProgress = false;
const GMAIL_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

app.post('/api/email-inbox/sync', authMiddleware, requirePermission('email.manage'), async (req, res) => {
  if (gmailSyncInProgress) {
    return res.status(409).json({ error: 'Ya hay una sincronización de correo en curso.' });
  }
  gmailSyncInProgress = true;
  // Watchdog: si una llamada a Google se cuelga pese al timeout, liberar el mutex
  const watchdog = setTimeout(() => { gmailSyncInProgress = false; }, GMAIL_SYNC_TIMEOUT_MS);
  if (watchdog.unref) watchdog.unref();
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
          const contentErr = validateFileContent(b.filename, b.content);
          if (contentErr) {
            console.warn(`[GMAIL] Adjunto '${b.filename}' omitido: ${contentErr}`);
            continue;
          }
          const filename = getUniqueFilename(b.filename);
          await storeFileBuffer(filename, b.content, { source: 'gmail', registered: false });
          attachments.push({ filename, sizeBytes: b.content.length, registered: false, source: 'gmail' });
          storedAttachmentFilenames.add(filename);
          attachmentsDownloaded++;
        }
        if (!attachments.length) continue;

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
      await rollbackStoredAttachments([...storedAttachmentFilenames]);
      throw e;
    }

    if (!newEmails.length) {
      return res.json({ message: 'Bandeja de entrada al día.', updated: false });
    }

    try {
      await col('emailsInbox').insertMany(newEmails);
    } catch (e) {
      // Si el insert falla, limpiar los adjuntos guardados para no dejarlos huérfanos.
      await rollbackStoredAttachments([...storedAttachmentFilenames]);
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
    clearTimeout(watchdog);
    gmailSyncInProgress = false;
  }
});

app.post('/api/documents/register-email-attachment', authMiddleware, requirePermission('documents.create'), async (req, res) => {
  const { emailId, filename, employeeId, documentTypeId, categoryId, description, issueDate, expiryDate, status } = req.body;
  if (requireFields(req.body, ['emailId', 'filename', 'employeeId', 'documentTypeId', 'categoryId', 'issueDate'])) {
    return res.status(400).json({ error: 'Faltan campos obligatorios.' });
  }
  const statusErr = validateDocStatus(status);
  if (statusErr) return res.status(400).json({ error: statusErr });
  const email = await col('emailsInbox').findOne({ id: emailId });
  if (!email) return res.status(404).json({ error: 'Correo electrónico no encontrado.' });

  const result = await registerEmailAttachmentCore({
    req, email, emailId, filename, employeeId, documentTypeId, categoryId,
    description, issueDate, expiryDate, status,
    auditAction: 'Ingesta de Correo',
    auditMessageTemplate: (emp, type, fn) => `Se registró el archivo adjunto '${fn}' del correo de ${email.senderName} asignándolo a ${emp} (${type}).`
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.doc);
});

// --- MANEJADOR DE ERRORES ---
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'El archivo supera el tamaño máximo permitido de 20 MB.' });
    }
    // Otros errores de multer (campos inesperados, archivos no esperados, etc.)
    const multerMessages = {
      LIMIT_UNEXPECTED_FILE: 'Se recibió un archivo no esperado.',
      LIMIT_FIELD_KEY: 'Nombre de campo no válido.',
      LIMIT_FIELD_VALUE: 'Valor de campo demasiado grande.',
      LIMIT_FIELD_COUNT: 'Demasiados campos.',
      LIMIT_FILE_COUNT: 'Demasiados archivos.',
      LIMIT_PART_COUNT: 'Demasiadas partes en la petición.'
    };
    return res.status(400).json({ error: multerMessages[error.code] || 'Error al procesar el archivo subido.' });
  }

  if (error.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({ error: error.message });
  }

  // Cuerpo JSON demasiado grande (express.json)
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'La petición supera el tamaño máximo permitido.' });
  }

  const isTransient = error.name === 'MongoNetworkError' || error.label === 'PoolClearedError' || error.label === 'PoolRequestRetry' || (error.message || '').includes('ERR_SSL_TLSV1') || (error.message || '').includes('PoolCleared');
  if (isTransient) {
    console.warn('[MONGO] Error TLS/transitorio:', error.message);
    return res.status(503).json({ error: 'Error temporal de base de datos. Intente de nuevo en unos segundos.' });
  }

  console.error('Error no controlado:', error.message || error);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
  try {
    const healthy = await isHealthy();
    if (healthy) return res.json({ status: 'ok', db: 'connected' });
    res.status(200).json({ status: 'degraded', db: 'disconnected' });
  } catch (_) {
    res.status(200).json({ status: 'error', db: 'unknown' });
  }
});

// Respaldo SPA — solo para rutas que no sean API
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ruta no encontrada.' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Verificador de salud de conexión: reconexión automática al morir el pool ---
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
