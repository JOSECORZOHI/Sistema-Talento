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
const { connect, col, isHealthy, reconnect, closeDb, storeFileBuffer, readFileStream, readFileBuffer, deleteFileByName, listFilesBySource, markFileRegistered, generateTempPassword } = require('./db');
const { analyzeFile, warmupOcr } = require('./documentAnalyzer.js');
const { parsePagination, wantsPagination, paginateQuery } = require('./lib/pagination');
const {
  escapeHtml, normalizeEmail, parseEmailFromHeader, parseToEmailHeader,
  getHeader, parseDateHeader, validatePasswordStrength
} = require('./lib/helpers');
const { renderResetPasswordEmail } = require('./lib/emailTemplates');

// Manejo de errores no controlados.
// unhandledRejection: se loguea sin salir (permite que la reconexión a Mongo se recupere).
// uncaughtException: tras una excepción no capturada el proceso puede quedar corrupto;
// se cierra HTTP y se sale para que Railway reinicie el proceso limpio.
process.on('unhandledRejection', (err) => {
  console.error('[PROCESS] Unhandled rejection:', err && err.stack ? err.stack : err);
});
process.on('uncaughtException', (err) => {
  console.error('[PROCESS] Uncaught exception — reiniciando proceso:', err && err.stack ? err.stack : err);
  try { if (typeof server !== 'undefined' && server) server.close(() => {}); } catch {}
  const exitTimer = setTimeout(() => process.exit(1), 1500);
  if (exitTimer.unref) exitTimer.unref();
});

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
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_REGISTER_BYTES = 50 * 1024 * 1024;
// La persistencia de archivos del sistema vive en GridFS (colección 'documentos'
// de MongoDB). La única carpeta local intencional es la del escáner, que opera en
// una máquina Windows con la multifunción conectada (WIA/COM). Las antiguas
// bandejas locales 'storage/documentos' y 'storage/gmail_adjuntos' se eliminaron:
// eran de solo lectura, no aportaban valor en producción (filesystem efímero en
// Railway) y nada las alimentaba por la web; todo el contenido va a GridFS.
const SCANNER_DIR = path.join(__dirname, 'bandeja_escaner');
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').toLowerCase();
[SCANNER_DIR].forEach(directory => {
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

/**
 * Crea el transporter de nodemailer cuando SMTP está habilitado.
 *
 * @returns {object|null} Transporte configurado o null si SMTP está deshabilitado.
 */
function getMailTransporter() {
  if (!SMTP_ENABLED) return null;
  return nodemailer.createTransport({
    host: SMTP_CONFIG.host,
    port: SMTP_CONFIG.port,
    secure: SMTP_CONFIG.secure,
    auth: { user: SMTP_CONFIG.user, pass: SMTP_CONFIG.pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    // Verificar el certificado TLS por defecto. Solo se desactiva explícitamente
    // cuando el operador lo pide (entornos de prueba con certificados autofirmados).
    tls: { rejectUnauthorized: process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' }
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

/**
 * Envía un correo a través de la API de Google (Gmail): se usa como respaldo
 * cuando SMTP no está configurado. Construye el MIME y lo envía como el usuario
 * autenticado con OAuth2.
 *
 * @param {object} opts - Parámetros del correo.
 * @param {string} opts.to - Destinatario.
 * @param {string} opts.subject - Asunto.
 * @param {string} [opts.html] - Cuerpo en HTML.
 * @param {string} [opts.text] - Cuerpo en texto plano.
 * @returns {Promise<boolean>} true si el envío fue exitoso.
 */
async function sendViaGmailApi({ to, subject, html, text }) {
  try {
    const gmail = getGmailClient();
    const mimeMessage = [
      `From: ${SMTP_FROM}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      html || text || subject
    ].join('\r\n');
    const encodedMessage = Buffer.from(mimeMessage)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: encodedMessage }
    });
    console.log('[MAIL-GAPI] Correo enviado a', to);
    return true;
  } catch (err) {
    console.error('[MAIL-GAPI] Error:', err.message || err);
    return false;
  }
}

/**
 * Envía un correo por SMTP si está habilitado; si no, por la API de Gmail; y en
 * desarrollo sin ambos solo lo simula en consola. Nunca lanza: falla con false.
 *
 * @param {object} opts - Parámetros del correo.
 * @param {string} opts.to - Destinatario.
 * @param {string} opts.subject - Asunto.
 * @param {string} [opts.html] - Cuerpo en HTML.
 * @param {string} [opts.text] - Cuerpo en texto plano.
 * @returns {Promise<boolean>} true si el correo fue enviado o simulado.
 */
async function sendEmail({ to, subject, html, text }) {
  console.log('[MAIL] Intentando enviar a:', to, '| SMTP_ENABLED:', SMTP_ENABLED);

  if (SMTP_ENABLED) {
    const transporter = getMailTransporter();
    if (transporter) {
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
        console.warn('[MAIL] SMTP falló, intentando Gmail API:', err.message || err);
      }
    }
  }

  if (process.env.GMAIL_REFRESH_TOKEN) {
    const sent = await sendViaGmailApi({ to, subject, html, text });
    if (sent) return true;
  }

  console.error('[MAIL] No se pudo enviar correo a', to);
  return false;
}

// --- CSP con NONCE ---
// Función de directiva que emite el nonce por petición (se define antes de helmet
// para que la configuración de CSP pueda referenciarla sin problemas de hoisting).
function cspNonceFromRes(req, res) {
  return `'nonce-${(res.locals && res.locals.cspNonce) || ''}'`;
}
const CSP_SCRIPT_SRC = ["'self'", cspNonceFromRes];

// Genera un nonce por petición. Debe ejecutarse ANTES de helmet para que el encabezado
// CSP se emita con el nonce correcto.
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: CSP_SCRIPT_SRC,
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      // frame-src: 'self' para visores del mismo origen y blob: para los PDF que el
      // frontend carga vía fetch con token en cabecera (Authorization) y renderiza
      // desde un Blob URL (nunca se expone el JWT en la URL del iframe).
      frameSrc: ["'self'", "blob:"],
      // frame-ancestors 'self' permite incrustar en iframes del MISMO origen
      // (visores PDF/documentos). 'none' bloqueaba incluso el iframe propio,
      // causando "la página ha rechazado la conexión" en los visores.
      frameAncestors: ["'self'"],
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
// --- CSP con NONCE (endurecimiento Content-Security-Policy) ---
// Se genera un nonce por petición (en el middleware global de arriba) y se inyecta
// en los <script> en línea de las páginas HTML, eliminando la dependencia de
// 'unsafe-inline' en script-src.

// Inyecta el nonce en los <script> en línea de las páginas HTML servidas desde /public.
app.get(/\.html$/, (req, res, next) => {
  const filePath = path.join(__dirname, 'public', req.path.split('?')[0]);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return next();
    const nonce = res.locals.cspNonce;
    const injected = data.replace(/<script(?![^>]*\bsrc=)(?![^>]*\snonce=)[^>]*>/gi, (tag) => {
      const close = tag.endsWith('/>') ? '/>' : '>';
      const open = tag.slice(0, -close.length);
      return `${open} nonce="${nonce}"${close}`;
    });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });
});

app.use(express.static(path.join(__dirname, 'public'), {
  index: false,
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
  } catch {
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
      try { col('users'); return next(); } catch {}
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

const INLINE_MIMES = new Set(['application/pdf','image/jpeg','image/png','image/gif','image/bmp','image/tiff','text/plain']);
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
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (req, file, cb) => {
    if (!isAllowedFile(file.originalname)) {
      const error = new Error('Formato de archivo no permitido. Use: PDF, Word, Excel, imágenes o texto.');
      error.code = 'INVALID_FILE_TYPE';
      return cb(error);
    }
    cb(null, true);
  }
});

// --- FUNCIONES DE SEGURIDAD ---

/**
 * Determina si un correo es admisible: si ALLOWED_EMAIL_DOMAIN está definido
 * exige ese dominio; sin restricción solo valida un formato básico.
 *
 * @param {string} email - Correo a validar.
 * @returns {boolean} true si está permitido.
 */
function isAllowedInstitutionalEmail(email) {
  const e = normalizeEmail(email);
  if (!ALLOWED_EMAIL_DOMAIN) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  return e.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

/**
 * Genera un token aleatorio de 32 bytes y el hash SHA-256 que se guardará en BD.
 * El token crudo viaja por correo; el hash es lo único persistido.
 *
 * @param {number} [expiresInHours=24] - Vigencia del token en horas.
 * @returns {{raw:string, hash:string, expiresAt:Date}} Token, hash y expiración.
 */
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

/**
 * Indica si una IP superó el límite de bloqueos de cuenta por hora (anti DoS),
 * podando de paso las entradas vencidas de la ventana.
 *
 * @param {string} ip - Dirección IP a consultar.
 * @returns {boolean} true si la IP está limitada por exceso de bloqueos.
 */
function isIpLockoutBlocked(ip) {
  if (!ip || ip === 'unknown') return false;
  const now = Date.now();
  const events = (ipLockEvents.get(ip) || []).filter(t => now - t < IP_LOCK_WINDOW_MS);
  if (events.length === 0) ipLockEvents.delete(ip);
  else ipLockEvents.set(ip, events);
  return events.length >= MAX_LOCKOUTS_PER_IP;
}

/**
 * Registra la hora de un bloqueo de cuenta asociado a una IP (ventana deslizante).
 *
 * @param {string} ip - Dirección IP del origen.
 */
function recordIpLockoutEvent(ip) {
  if (!ip || ip === 'unknown') return;
  const now = Date.now();
  const events = (ipLockEvents.get(ip) || []).filter(t => now - t < IP_LOCK_WINDOW_MS);
  events.push(now);
  ipLockEvents.set(ip, events);
}

/**
 * Registra un intento de inicio de sesión y, tras N fallos dentro de la ventana,
 * bloquea la cuenta (users/employees) y marca la IP de origen.
 *
 * @param {string} identifier - Correo que intenta autenticarse.
 * @param {boolean} success - Si la credencial fue correcta.
 * @param {string} ip - IP del origen.
 * @returns {Promise<{locked:boolean, attempts:number}>} Estado de bloqueo.
 */
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

/**
 * IP del cliente desde req.ip (que ya respeta TRUST_PROXY) con respaldo.
 *
 * @param {object} req - Request de Express.
 * @returns {string} IP del cliente o 'unknown'.
 */
function getClientIp(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

// --- LOGGING DE SEGURIDAD ---
/**
 * Inserta un registro en securityLogs y, si el evento es crítico, dispara la
 * notificación al administrador. Nunca lanza.
 *
 * @param {string} event - Nombre del evento (p. ej. 'Login Fallido').
 * @param {string} details - Detalle legible del evento.
 * @param {string} ip - IP del origen.
 * @param {string} email - Correo del usuario implicado (o 'sistema').
 */
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
  notifyAdminForEvent(entry).catch(() => {});
}

// --- ALERTAS AL ADMINISTRADOR POR CORREO (eventos críticos) ---
const CRITICAL_SECURITY_EVENTS = new Set(['Cuenta Bloqueada', 'Empleado Eliminado', 'Documento Eliminado']);
const ALERT_DEBOUNCE_MS = 30 * 60 * 1000;
const lastAlertSentAt = {};

// Notifica al admin por correo cuando ocurre un evento crítico, con un debounce de
// 30 min por tipo para no saturar la bandeja ante ráfagas (p. ej. múltiples bloqueos).
// Es best-effort: si SMTP/Gmail no está configurado, solo queda el securityLog.
/**
 * Envía al admin una alerta por correo para eventos críticos, con debounce de
 * 30 min por tipo de evento. Destino: ADMIN_ALERT_EMAIL o el primer admin activo.
 * Best-effort: aunque falle el correo, el securityLog ya quedó registrado.
 *
 * @param {object} entry - Documento de securityLog (event/details/timestamp/ip/email).
 * @returns {Promise<void>}
 */
async function notifyAdminForEvent(entry) {
  if (!CRITICAL_SECURITY_EVENTS.has(entry.event)) return;
  const now = Date.now();
  if (now - (lastAlertSentAt[entry.event] || 0) < ALERT_DEBOUNCE_MS) return;
  lastAlertSentAt[entry.event] = now;

  let adminEmail = process.env.ADMIN_ALERT_EMAIL;
  if (!adminEmail) {
    const admin = await col('users').findOne({ role: 'admin', status: 'activa', active: true }, { projection: { email: 1 } });
    adminEmail = admin && admin.email;
  }
  if (!adminEmail) return;

  const ok = await sendEmail({
    to: adminEmail,
    subject: `[ALERTA] ${entry.event} — Sistema de Talento Humano`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;padding:24px;">
        <div style="background:#fff;border-radius:10px;padding:24px;max-width:560px;margin:0 auto;border-top:4px solid #b03a2e;">
          <h2 style="margin:0 0 8px;color:#1A5276;">⚠ Alerta de seguridad</h2>
          <p style="margin:0 0 16px;color:#555;font-size:14px;">El sistema detectó un evento <strong>${escapeHtml(entry.event)}</strong> que requiere su atención.</p>
          <table style="width:100%;font-size:13px;color:#333;border-collapse:collapse;">
            <tr><td style="padding:6px 0;color:#888;">Evento</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(entry.event)}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Detalle</td><td style="padding:6px 0;">${escapeHtml(entry.details)}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Fecha</td><td style="padding:6px 0;">${escapeHtml(new Date(entry.timestamp).toLocaleString('es-CO'))}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">IP</td><td style="padding:6px 0;">${escapeHtml(entry.ip)}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Usuario</td><td style="padding:6px 0;">${escapeHtml(entry.email)}</td></tr>
          </table>
          <p style="margin:16px 0 0;color:#aaa;font-size:11px;">Revise la sección de Seguridad del panel administrativo para más contexto.</p>
        </div>
      </div>`,
    text: `Alerta de seguridad: ${entry.event}\nDetalle: ${entry.details}\nFecha: ${new Date(entry.timestamp).toLocaleString('es-CO')}\nIP: ${entry.ip}\nUsuario: ${entry.email}`
  });
  if (ok) console.log(`[ALERTA] Notificación de '${entry.event}' enviada a ${adminEmail}`);
}

// --- JWT VERSIONING ---
/**
 * Emite el JWT de sesión (HS256, 8 h) con email/name/role y versión de token.
 *
 * @param {object} payload - Datos a firmar.
 * @returns {string} Token JWT firmado.
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '8h', algorithm: 'HS256' });
}

// --- AUTENTICACIÓN COMPARTIDA ---
/**
 * Autentica un usuario de 'users' (admin) o 'employees' (funcionario) con
 * igualación de tiempos (anti timing-attack), bloqueo temporal tras N fallos y
 * mensajes unificados (anti-enumeración). Si las credenciales son válidas, firma
 * el JWT y responde con la sesión.
 *
 * @param {object} user - Documento de la colección.
 * @param {string} collectionName - 'users' o 'employees'.
 * @param {string} role - Rol a asignar en el token.
 * @param {string} username - Correo ingresado.
 * @param {string} password - Contraseña ingresada.
 * @param {string} ip - IP del solicitante.
 * @param {object} res - Respuesta Express (responde o retorna null).
 * @returns {Promise<null>} null si el usuario no tiene contraseña (sin respuesta).
 */
async function authenticateUser(user, collectionName, role, username, password, ip, res) {
  // Iguala el tiempo de respuesta en todos los caminos de fallo (anti timing side-channel):
  // siempre se ejecuta un bcrypt.compare (real o contra un hash ficticio).
  const equalizeTiming = async () => {
    const dummyHash = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7f5D5bJ9K6nXJ6kQxHjV7uWlPmQxI4y';
    if (user.password) { try { await bcrypt.compare(password, user.password); } catch {} }
    else { try { await bcrypt.compare(password, dummyHash); } catch {} }
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
  // Un usuario suspendido/inactivo ve la misma respuesta que una credencial errónea.
  // Los pendientes SÍ pueden entrar para cambiar su contraseña inicial.
  if (user.status === 'suspendida' || user.status === 'inactiva'
    || (role === 'funcionario' && user.active === false && user.status !== 'pendiente')
    || user.status === 'bloqueada') {
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
/**
 * Cambia la contraseña de admin o funcionario: verifica la actual, valida contra
 * el historial (anti reutilización), rota el historial e invalida los JWT previos
 * incrementando jwtVersion.
 *
 * @param {object} user - Usuario autenticado en la petición.
 * @param {string} currentPassword - Contraseña actual.
 * @param {string} newPassword - Contraseña nueva (ya validada).
 * @param {string} role - 'admin' | 'funcionario'.
 * @param {string} ip - IP del solicitante.
 * @param {object} res - Respuesta Express.
 * @returns {Promise<void>}
 */
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
  const activateFields = (doc.mustChangePassword && collectionName === 'employees')
    ? { status: 'activa', active: true }
    : {};
  await col(collectionName).updateOne({ _id: doc._id }, { $set: { password: newHash, jwtVersion: newVersion, mustChangePassword: false, ...activateFields } });
  await addToPasswordHistory(doc.email, newHash, role);
  await addAuditLog('Cambio de Contraseña', `El ${role === 'admin' ? 'administrador' : 'funcionario'} ${doc.name} cambió su contraseña.`, doc.name, ip);
  return res.json({ message: 'Contraseña actualizada. Debe iniciar sesión nuevamente.', forceReauth: true });
}

// --- ARCHIVOS SIN REGISTRAR ---
/**
 * Lista archivos sin registrar: los locales de la bandeja/entrada y los de
 * GridFS con metadata.registered=false, con tamaño y fecha de creación.
 *
 * @param {Array|null} [allDocs] - Documentos registrados (null = consultar en BD).
 * @returns {Promise<Array<{filename:string, fileSize:number, createdAt:Date}>>}
 */
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

    return result;
  } catch (e) { console.warn('Error en getUnregisteredFiles:', e.message); return []; }
}

// --- HISTORIAL DE CONTRASEÑAS ---
/**
 * Indica si la contraseña candidata ya se usó en las últimas rotaciones de la
 * cuenta (historial acotado a PASSWORD_HISTORY_SIZE).
 *
 * @param {string} email - Correo de la cuenta.
 * @param {string} newPassword - Contraseña candidata.
 * @param {string} role - 'admin' | 'funcionario'.
 * @returns {Promise<boolean>} true si ya fue usada antes.
 */
async function checkPasswordHistory(email, newPassword, role) {
  const collection = getCollectionForRole(role);
  const user = await col(collection).findOne({ email });
  if (!user || !user.passwordHistory) return false;
  for (const oldHash of user.passwordHistory.slice(-PASSWORD_HISTORY_SIZE)) {
    if (await bcrypt.compare(newPassword, oldHash)) return true;
  }
  return false;
}

/**
 * Agrega el hash a la rotación de contraseñas de la cuenta (recorta a las
 * últimas PASSWORD_HISTORY_SIZE).
 *
 * @param {string} email - Correo de la cuenta.
 * @param {string} hashedPassword - Hash bcrypt a guardar.
 * @param {string} role - 'admin' | 'funcionario'.
 */
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
      'email.read', 'email.sync',
      'deletion.create'
    ]
  }
};

/**
 * Comprueba si un rol tiene un permiso específico.
 *
 * @param {string} role - 'admin' | 'funcionario'.
 * @param {string} permission - Identificador de permiso.
 * @returns {boolean} true si el rol posee el permiso.
 */
function hasPermission(role, permission) {
  return ROLES[role]?.permissions.includes(permission) || false;
}

/**
 * Middleware Express: responde 403 si el usuario autenticado no tiene el permiso.
 *
 * @param {string} permission - Permiso requerido.
 * @returns {function} Middleware de Express.
 */
function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: 'No tiene permisos para realizar esta acción.' });
    }
    next();
  };
}

/**
 * Middleware Express: responde 403 si el usuario no tiene al menos uno de los
 * permisos indicados.
 *
 * @param {...string} permissions - Permisos alternativos.
 * @returns {function} Middleware de Express.
 */
function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !permissions.some(p => hasPermission(req.user.role, p))) {
      return res.status(403).json({ error: 'No tiene permisos para realizar esta acción.' });
    }
    next();
  };
}

/**
 * Inserta una entrada en auditLogs; nunca lanza (solo advierte en consola).
 *
 * @param {string} action - Acción realizada.
 * @param {string} details - Detalle legible.
 * @param {string} userEmail - Correo del actor.
 * @param {string} ip - IP del actor.
 */
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

/**
 * Resuelve un nombre de archivo a una ruta segura dentro del directorio:
 * rechaza separadores de ruta (..,%2f), nombres vacíos y extensiones no
 * permitidas (anti path traversal).
 *
 * @param {string} directory - Directorio base.
 * @param {string} filename - Nombre del archivo a resolver.
 * @returns {string|null} Ruta segura o null si es inválida.
 */
function getSafeFilePath(directory, filename) {
  if (typeof filename !== 'string' || filename !== path.basename(filename) || !isAllowedFile(filename)) {
    return null;
  }
  return path.join(directory, filename);
}

/**
 * Verifica que el tipo de documento y la categoría existan en sus catálogos y
 * devuelve ambos documentos.
 *
 * @param {string} documentTypeId - ID del tipo de documento.
 * @param {string} categoryId - ID de la categoría.
 * @returns {Promise<{documentType:object, category:object}|null>} null si falta uno.
 */
async function validateDocumentReferences(documentTypeId, categoryId) {
  const documentType = await col('documentTypes').findOne({ id: documentTypeId });
  const category = await col('categories').findOne({ id: categoryId });
  if (!documentType || !category) return null;
  return { documentType, category };
}

// Tipos/categorías que contienen DATOS SENSIBLES (salud, seguridad social,
// identificación) según la Ley 1581/2012 (art. 5). Estos documentos se cifran
// en reposo (AES-256-GCM) para protegerlos durante el almacenamiento.
const SENSITIVE_TYPE_IDS = ['incapacidad'];
const SENSITIVE_CATEGORY_IDS = ['seguridad-social', 'novedades', 'identificacion'];

function isSensitiveDocument(documentTypeId, categoryId) {
  return SENSITIVE_TYPE_IDS.includes(documentTypeId || '') ||
    SENSITIVE_CATEGORY_IDS.includes(categoryId || '');
}

/**
 * Genera un nombre único para evitar colisiones en GridFS (timestamp + aleatorio),
 * conservando la extensión original.
 *
 * @param {string} originalFilename - Nombre original del archivo.
 * @returns {string} Nombre único.
 */
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

/**
 * Comprueba que los campos requeridos del body tengan un valor no vacío.
 *
 * @param {object} body - Cuerpo de la petición.
 * @param {string[]} fields - Campos obligatorios.
 * @returns {string|null} Primer campo faltante o null si todos están presentes.
 */
function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || String(body[f]).trim() === '') return f;
  }
  return null;
}

/**
 * Valida el estado contra la lista permitida.
 *
 * @param {string|undefined} status - Estado del documento.
 * @returns {string|null} Mensaje de error o null si es válido/omitido.
 */
function validateDocStatus(status) {
  if (status !== undefined && !VALID_DOC_STATUSES.includes(status)) {
    return `Estado no válido. Valores permitidos: ${VALID_DOC_STATUSES.join(', ')}.`;
  }
  return null;
}

// Valida fechas de emisión/vencimiento en formato YYYY-MM-DD (o ISO) y que
// expiryDate no sea anterior a issueDate. Devuelve null si todo es correcto.
/**
 * Valida fechas de emisión y vencimiento (fecha válida si se indican) y que la
 * de vencimiento no sea anterior a la de emisión.
 *
 * @param {string|undefined} issueDate - Fecha de emisión (YYYY-MM-DD o ISO).
 * @param {string|undefined} expiryDate - Fecha de vencimiento.
 * @returns {string|null} Mensaje de error o null si es válido.
 */
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

/**
 * Limita la descripción a 2000 caracteres.
 *
 * @param {string|undefined} description - Descripción a validar.
 * @returns {string|null} Mensaje de error o null si es válido/omitida.
 */
function validateDescription(description) {
  if (description !== undefined && description !== null && String(description).length > 2000) {
    return 'La descripción no puede superar los 2000 caracteres.';
  }
  return null;
}

// El archivo debe estar en la bandeja del escáner (local) o ser un archivo de escáner sin registrar en GridFS
/**
 * Indica si el archivo está pendiente de registro en la bandeja del escáner
 * (archivo local en SCANNER_DIR o en GridFS sin marcar como registrado).
 *
 * @param {string} filename - Nombre del archivo.
 * @returns {Promise<boolean>}
 */
async function isFileInScannerTray(filename) {
  const scanPath = getSafeFilePath(SCANNER_DIR, filename);
  if (scanPath && fs.existsSync(scanPath)) return true;
  return (await listFilesBySource('scanner', false).catch(() => []))
    .some(f => f.filename === filename);
}

async function rollbackStoredAttachments(filenames) {
  for (const fn of filenames) { try { await deleteFileByName(fn); } catch { /* ignorar */ } }
}

// Valida que el contenido coincida con la extensión (magic bytes).
// Evita que un .pdf sea en realidad HTML/script u otro binario.
/**
 * Verifica los magic bytes del buffer contra la extensión declarada para evitar
 * cargar archivos suplantados (p. ej. un .pdf que es HTML o un script).
 *
 * @param {string} filename - Nombre del archivo (define la extensión esperada).
 * @param {Buffer} buffer - Contenido del archivo.
 * @returns {boolean} true si el contenido corresponde a la extensión.
 */
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
  const sensitive = isSensitiveDocument(documentTypeId, categoryId);

  try {
    if (fileBuffer) {
      targetFilename = getUniqueFilename(filename);
      await storeFileBuffer(targetFilename, fileBuffer, { source: gridFSSource || 'upload', registered: true, sensitive });
      stored = true;
      fileSize = fileBuffer.length;
    } else if (mover) {
      // 'mover' se usa para el escáner (bandeja local) y para adjuntos de correo.
      // La fuente autoritativa es GridFS; el disco solo se consulta para la bandeja
      // del escáner (archivo físico aún no cargado a GridFS).
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
        await storeFileBuffer(targetFilename, buf, { source: gridFSSource || sourceDir || 'upload', registered: true, sensitive });
        stored = true;
        fileSize = buf.length;
        deferredOriginalDelete = { type: 'gridfs', name: filename };
      } else if (sourceDir === SCANNER_DIR) {
        // Escáner: el PDF físico vive en la bandeja local, se copia a GridFS al registrar.
        const sourcePath = getSafeFilePath(sourceDir, filename);
        if (!sourcePath) return { error: `Ruta de origen no válida para '${filename}'.`, status: 400 };
        let buf;
        try {
          const stat = fs.statSync(sourcePath);
          if (stat.size > MAX_REGISTER_BYTES) {
            return { error: `El archivo '${filename}' supera el tamaño máximo permitido (${Math.round(MAX_REGISTER_BYTES / 1024 / 1024)} MB).`, status: 400 };
          }
        } catch { return { error: `El archivo '${filename}' ya no está disponible en la bandeja.`, status: 404 }; }
        try { buf = fs.readFileSync(sourcePath); }
        catch { return { error: `El archivo '${filename}' ya no está disponible en la bandeja.`, status: 404 }; }
        targetFilename = getUniqueFilename(filename);
        await storeFileBuffer(targetFilename, buf, { source: gridFSSource || sourceDir || 'upload', registered: true, sensitive });
        stored = true;
        fileSize = buf.length;
        deferredOriginalDelete = { type: 'disk', path: sourcePath };
      }
    } else {
      const gridFile = await readFileStream(filename).catch(() => null);
      if (gridFile) {
        targetFilename = filename;
        if (sensitive) {
          // Re-cifrar si el archivo existente aún no estaba cifrado (p.ej. un escaneo
          // que se clasificó como sensible después de generarse en la bandeja).
          const storedMeta = gridFile.file && gridFile.file.metadata;
          if (!(storedMeta && storedMeta.encrypted === true)) {
            const got = await readFileBuffer(filename).catch(() => null);
            if (got && got.buffer) {
              const buf = got.buffer;
              await deleteFileByName(filename);
              await storeFileBuffer(filename, buf, { source: gridFSSource || sourceDir || 'upload', registered: true, sensitive });
              fileSize = buf.length;
            }
          }
        }
        if (!fileSize) fileSize = gridFile.file.length || 0;
        try { await markFileRegistered(filename); } catch (e) { console.warn('Error marcando archivo como registrado:', e.message); }
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
      } catch {
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
    mover: true,
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

function getAttachmentParts(part, attachmentParts = []) {
  if (part.filename && isAllowedFile(part.filename) && part.body && part.body.attachmentId) {
    attachmentParts.push(part);
  } else if (!part.filename && part.body && part.body.attachmentId && part.mimeType) {
    const extFromMime = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'text/plain': '.txt', 'text/csv': '.csv', 'application/msword': '.doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx' };
    const ext = extFromMime[part.mimeType];
    if (ext && isAllowedFile('file' + ext)) {
      attachmentParts.push({ ...part, filename: `adjunto${ext}` });
    }
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
    if (dbUser.status === 'suspendida' || dbUser.status === 'inactiva' || dbUser.status === 'bloqueada') {
      return res.status(401).json({ error: 'Su cuenta no está activa. Contacte al administrador.' });
    }
    if (decoded.role === 'funcionario' && dbUser.active === false && !req.originalUrl.includes('/auth/change-password')) {
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
      { $set: { status: 'activa', password: hashedPassword, mustChangePassword: false, lockedUntil: null, failedAttempts: 0 } }
    );
  } else {
    await col('employees').updateOne(
      { email: activationToken.email },
      { $set: { status: 'activa', active: true, password: hashedPassword, mustChangePassword: false, lockedUntil: null, failedAttempts: 0 } }
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
    html: renderResetPasswordEmail({ name: user.name, resetUrl, logoUrl })
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
      // Cada funcionario solo ve los correos que Google matcheó con su propio
      // correo (suggestedEmployeeId), para que registre únicamente sus adjuntos.
      emails = await col('emailsInbox').find({ suggestedEmployeeId: req.user.employeeId }).sort({ date: -1 }).toArray();
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
  // Bandeja compartida: cualquier funcionario puede registrar adjuntos

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
  res.json(await col('employees').find({}, { projection: { password: 0, passwordHistory: 0 } }).limit(2000).toArray());
});

app.post('/api/employees', authMiddleware, requirePermission('employees.create'), createLimiter, async (req, res) => {
  const ip = getClientIp(req);
  let { id, name, department, position, email, consent } = req.body;
  if (!department || !email) {
    return res.status(400).json({ error: 'La dependencia y el correo electrónico son obligatorios.' });
  }
  if (consent !== true) {
    return res.status(400).json({ error: 'Debe confirmar que el titular autoriza el tratamiento de sus datos personales conforme a la Política de Privacidad.' });
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
    status: 'pendiente',
    active: false,
    mustChangePassword: true,
    password: tempHash,
    registeredAt: new Date().toISOString(),
    registeredBy: 'Administrador',
    failedAttempts: 0,
    lockedUntil: null,
    dataConsent: {
      granted: true,
      grantedAt: new Date().toISOString(),
      grantedByAccount: 'Administrador',
      grantedByIp: ip,
      version: 'v1'
    }
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
      : {
          emailSent: false,
          message: 'Empleado creado, pero no se pudo enviar el correo.',
          // La contraseña temporal NO se expone por la API por seguridad.
          // Solo se devuelve si el operador lo habilita explícitamente (entornos de prueba sin SMTP).
          ...(process.env.ALLOW_TEMP_PASSWORD_RESPONSE === 'true' ? { tempPassword } : {})
        })
  });
});

app.delete('/api/employees/:id', authMiddleware, requirePermission('employees.delete'), async (req, res) => {
  try {
    const ip = getClientIp(req);
    const { id } = req.params;
    const employee = await col('employees').findOne({ id });
    if (!employee) return res.status(404).json({ error: 'Funcionario no encontrado.' });

    const empEmail = employee.email;
    const empName = employee.name;

    // 1) Eliminar documentos del funcionario (registro + archivo físico en GridFS)
    const empDocs = await col('documents').find({ employeeId: id }).toArray();
    for (const doc of empDocs) {
      await deleteDocAndPhysicalFile(doc.id, doc.filename);
    }

    // 2) Eliminar solicitudes de eliminación asociadas
    await col('deletionRequests').deleteMany({ email: empEmail });
    await col('deletionRequests').deleteMany({ employeeId: id });

    // 3) Eliminar correos sugeridos al funcionario
    await col('emailsInbox').deleteMany({ suggestedEmployeeId: id });

    // 4) Eliminar tokens y registros de acceso vinculados
    await col('employees').deleteOne({ id });
    await col('loginAttempts').deleteMany({ identifier: empEmail });
    await col('activationTokens').deleteMany({ email: empEmail });
    await col('passwordResetTokens').deleteMany({ email: empEmail });

    // 5) Anonimizar historial (auditLogs / securityLogs) para cumplir el derecho de
    //    supresión (art. 8 lit. f, Ley 1581): se eliminan los datos personales que
    //    identifican al titular, conservando el agregado no personal.
    const scrub = '[Dato eliminado por supresión]';
    await col('auditLogs').updateMany(
      { $or: [{ actor: empEmail }, { actor: empName }, { actor: id }] },
      { $set: { actor: scrub, actorDeleted: true } }
    );
    await col('securityLogs').updateMany(
      { $or: [{ actor: empEmail }, { actor: empName }, { actor: id }, { user: empEmail }] },
      { $set: { actor: scrub, user: scrub, actorDeleted: true } }
    );
    // Reemplazar referencias al nombre/C.C./correo dentro de las descripciones de los logs
    const { replaceManyText } = require('./lib/logScrub');
    if (typeof replaceManyText === 'function') {
      await replaceManyText(col('auditLogs'), [empName, id, empEmail], scrub);
      await replaceManyText(col('securityLogs'), [empName, id, empEmail], scrub);
    }

    await addAuditLog('Eliminar Empleado', `Se eliminó permanentemente al funcionario (C.C. ${id}) y todos sus datos personales, documentos y registros asociados conforme a la Ley 1581 de 2012 (derecho de supresión).`, req.user.name, ip);
    await addSecurityLog('Empleado Eliminado', `Funcionario (C.C. ${id}) eliminado permanentemente con supresión total de sus datos personales por ${req.user.name}.`, ip);
    res.json({ message: `Funcionario eliminado permanentemente. Sus datos personales, documentos y registros asociados fueron suprimidos conforme a la Ley 1581 de 2012.` });
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
    const wasPending = employee.status === 'pendiente';
    // Pendientes activados por admin se marcan como activa directamente
    const newStatus = wasPending && newActive ? 'activa' : (wasPending && !newActive ? 'inactiva' : (newActive ? 'activa' : 'inactiva'));
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
  if (wantsPagination(req)) {
    const pagination = parsePagination(req, { defaultLimit: 100, maxLimit: 500 });
    res.json(await paginateQuery(col('documents'), {}, { registeredAt: -1 }, pagination));
    return;
  }
  res.json(await col('documents').find().sort({ registeredAt: -1 }).limit(1000).toArray());
});

app.get('/api/documents/unregistered', authMiddleware, requirePermission('documents.read'), async (req, res) => {
  try {
    res.json(await getUnregisteredFiles());
  } catch {
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
    mover: false,
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
    const requests = await col('deletionRequests').find().sort({ createdAt: -1 }).limit(200).toArray();
    res.json(requests);
  } catch {
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

// --- ANÁLISIS DE DOCUMENTO (OCR + sugerencias) ---
app.post('/api/documents/analyze', authMiddleware, requirePermission('documents.create'), async (req, res) => {
  const { filename, folder } = req.body || {};
  if (!filename) return res.status(400).json({ error: 'Se requiere el nombre del archivo.' });
  const targetFilename = String(filename);
  if (!isAllowedFile(targetFilename)) {
    return res.status(400).json({ error: 'Formato de archivo no soportado para análisis.' });
  }

  // Reutiliza la constante global MAX_UPLOAD_BYTES (25MB) para que multer,
  // el analizador y la bandeja Gmail compartan el mismo límite coherente.
  const MAX_ANALYZE_BYTES = MAX_UPLOAD_BYTES;

  let employees = [];
  try {
    employees = await col('employees').find({}, { projection: { id: 1, name: 1, lastName: 1, identification: 1 } }).limit(2000).toArray();
  } catch (e) {
    console.warn('[ANALYZE] No se pudieron cargar los empleados para sugerir:', e.message);
  }

  const readBufferFromGridFs = () => new Promise((resolve, reject) => {
    readFileStream(targetFilename).then((r) => {
      if (!r) return resolve(null);
      if (r.file.length > MAX_ANALYZE_BYTES) return resolve({ error: 'limite' });
      const chunks = [];
      let size = 0;
      r.stream.on('data', (c) => {
        size += c.length;
        if (size > MAX_ANALYZE_BYTES) { try { r.stream.destroy(); } catch {} return reject({ error: 'limite' }); }
        chunks.push(c);
      });
      r.stream.on('end', () => resolve(Buffer.concat(chunks)));
      r.stream.on('error', (e) => reject(e));
    }).catch((e) => reject(e));
  });

  let buf;
  try { buf = await readBufferFromGridFs(); } catch { return res.status(413).json({ error: 'El archivo supera el tamaño máximo para análisis.' }); }

  // Fallback a disco SOLO para la bandeja del escáner (archivo físico aún no en GridFS).
  // Los documentos cargados y los adjuntos de correo ya viven en GridFS.
  if (!buf && folder === 'scanner') {
    const filePath = getSafeFilePath(SCANNER_DIR, targetFilename);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'El archivo no está disponible en el servidor.' });
    }
    if (fs.statSync(filePath).size > MAX_ANALYZE_BYTES) {
      return res.status(413).json({ error: 'El archivo supera el tamaño máximo para análisis.' });
    }
    buf = fs.readFileSync(filePath);
  }

  try {
    const result = await analyzeFile(buf, targetFilename, { employees });
    if (!result) return res.status(422).json({ error: 'No se pudo extraer información del documento.' });
    console.log(`[ANALYZE] '${targetFilename}' por ${req.user.email}: type=${result.suggestions.documentTypeId} cat=${result.suggestions.categoryId} ocr=${result.ocrUsed}`);
    res.json(result);
  } catch (e) {
    console.error('[ANALYZE] Error al analizar el documento:', e.message);
    res.status(422).json({ error: 'No se pudo analizar el documento.' });
  }
});

// --- SERVIR ARCHIVOS ---
// Token via query param para iframes que no pueden enviar headers Authorization
function fileAuthMiddleware(req, res, next) {
  // El token SOLO se acepta por cabecera Authorization (Bearer). No se admite en
  // la URL (?token=): evita que el JWT quede expuesto en logs, referrer o historial.
  if (req.query.token && !req.headers.authorization) {
    return res.status(401).json({ error: 'Autenticación inválida. Vuelva a iniciar sesión.' });
  }
  return authMiddleware(req, res, next);
}
app.get('/api/document-file/:filename', fileAuthMiddleware, async (req, res) => {
  const filename = req.params.filename;
  console.log(`[FILE-SERVE] Solicitud: user=${req.user.email} filename="${filename}" folder=${req.query.folder || '(none)'}`);
  const folder = req.query.folder;
  // La fuente autoritativa de archivos es GridFS. El único archivo que puede
  // vivir en disco es el de la bandeja del escáner (aún no cargado a GridFS).
  const isScanner = folder === 'scanner';
  if (!getSafeFilePath(isScanner ? SCANNER_DIR : process.cwd(), filename)) {
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
      if (!email) {
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
      let finished = false;

      // Capturar errores del stream ANTES de pipe para evitar que escapen al uncaughtException
      const streamErrorHandler = (err) => {
        console.error(`[FILE-SERVE] Stream error para '${filename}':`, err.message);
        if (!finished) {
          finished = true;
          try { r.stream.destroy(); } catch {}
          try { if (!res.headersSent) { res.status(500).json({ error: 'Error al transmitir archivo.' }); } else { res.end(); } } catch {}
        }
      };
      r.stream.on('error', streamErrorHandler);

      r.stream.on('end', () => { finished = true; });
      r.stream.on('close', () => { if (!finished) { finished = true; } });

      // Si el cliente cierra la conexión, destruir el stream GridFS
      req.on('close', () => {
        if (!finished) {
          finished = true;
          try { r.stream.destroy(); } catch {}
        }
      });

      // Si el socket se cierra abruptamente
      if (res.socket) {
        res.socket.on('close', () => {
          if (!finished) {
            finished = true;
            try { r.stream.destroy(); } catch {}
          }
        });
      }

      r.stream.pipe(res);

      // Timeout de seguridad: si el stream no termina en 60s, abortar
      const streamTimeout = setTimeout(() => {
        if (!finished) {
          console.error(`[FILE-SERVE] Timeout de 60s para '${filename}', abortando stream.`);
          finished = true;
          try { r.stream.destroy(); } catch {}
          try { if (!res.headersSent) { res.status(504).json({ error: 'Timeout al transmitir archivo.' }); } else { res.end(); } } catch {}
        }
      }, 60000);
      if (streamTimeout.unref) streamTimeout.unref();
      r.stream.on('end', () => clearTimeout(streamTimeout));
      r.stream.on('error', () => clearTimeout(streamTimeout));

      return;
    }
  } catch (e) {
    console.error(`[FILE-SERVE] Error leyendo '${filename}' de GridFS:`, e.message);
  }

  // Fallback a disco SOLO para la bandeja del escáner (archivo físico aún no en GridFS).
  if (isScanner) {
    try {
      const filePath = getSafeFilePath(SCANNER_DIR, filename);
      if (filePath && fs.existsSync(filePath)) {
        const mimeType = getMimeType(filename);
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', buildContentDisposition(mimeType, filename));
        res.sendFile(filePath);
      } else {
        res.status(404).json({ error: 'Archivo no encontrado en el servidor.' });
      }
    } catch (e) {
      console.error(`[FILE-SERVE] Error sirviendo archivo de escáner '${filename}':`, e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Error al servir archivo.' });
    }
  } else {
    res.status(404).json({ error: 'Archivo no encontrado en el servidor.' });
  }
});

// --- REGISTROS DE AUDITORÍA ---
app.get('/api/audit-logs', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  if (wantsPagination(req)) {
    const pagination = parsePagination(req, { defaultLimit: 50, maxLimit: 500 });
    res.json(await paginateQuery(col('auditLogs'), {}, { timestamp: -1 }, pagination));
    return;
  }
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 500, 1000));
  res.json(await col('auditLogs').find().sort({ timestamp: -1 }).limit(limit).toArray());
});

app.get('/api/security-logs', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  if (wantsPagination(req)) {
    const pagination = parsePagination(req, { defaultLimit: 50, maxLimit: 500 });
    res.json(await paginateQuery(col('securityLogs'), {}, { timestamp: -1 }, pagination));
    return;
  }
  const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 100, 500));
  res.json(await col('securityLogs').find().sort({ timestamp: -1 }).limit(limit).toArray());
});

// --- ESCÁNER ---
app.get('/api/scanner-files', authMiddleware, requirePermission('scanner.read'), async (req, res) => {
  res.json(await getScannerFiles());
});

// --- ESTADO DEL ESCÁNER (Detección USB + Red + Monitoreo de bandeja) ---
function runPs(cmd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const full = `$ProgressPreference='SilentlyContinue';${cmd}`;
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      { timeout: timeoutMs, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const raw = (stdout || '').replace(/#< CLIXML[\s\S]*?<\/Objs>\s*/g, '').trim();
        if (error && !raw) { console.warn('Error ejecutando PowerShell:', error.message); return resolve(''); }
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
  // Se aplica una ALLOWLIST estricta: solo letras, números, espacios, guion y punto,
  // para impedir cualquier inyección hacia el filesystem o PowerShell (a pesar de que
  // el nombre solo se usa como nombre de archivo, no se ejecuta).
  let baseName = String((customName || `Escaner_Folio_${timestamp}_${crypto.randomBytes(3).toString('hex')}`))
    .replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ _.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\-]+|[.\-]+$/g, '')
    .substring(0, 150);
  if (!baseName || baseName === '') baseName = `Escaner_Folio_${timestamp}_${crypto.randomBytes(3).toString('hex')}`;
  let pdfBase = `${baseName}.pdf`;
  // Si el nombre ya existe en la bandeja (GridFS o disco), generar un sufijo único
  const trayNames = new Set((await getScannerFiles()).map(f => f.filename));
  if (trayNames.has(pdfBase)) {
    pdfBase = `${baseName}_${crypto.randomBytes(4).toString('hex')}.pdf`;
  }
  const tempToken = crypto.randomBytes(4).toString('hex');
  const raw = await runPs(`
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
// DEBUG temporal: diagnosticar sync Gmail paso a paso
app.get('/api/gmail/debug', authMiddleware, requirePermission('email.manage'), async (req, res) => {
  // Endpoint de diagnóstico: solo disponible en desarrollo para no exponer
  // contenido/env de producción.
  if (process.env.NODE_ENV !== 'development') {
    return res.status(404).json({ error: 'No encontrado.' });
  }
  try {
    const gmail = getGmailClient();
    const result = {};

    // Paso 1: Listar mensajes SIN filtro de adjuntos
    try {
      const listAll = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], maxResults: 10 });
      result.paso1_listAll = { count: (listAll.data.messages || []).length, totalEstimate: listAll.data.resultSizeEstimate, sampleIds: (listAll.data.messages || []).slice(0, 5).map(m => m.id) };
    } catch (e) { result.paso1_error = e.message; }

    // Paso 2: Listar mensajes CON has:attachment
    try {
      const listAtt = await gmail.users.messages.list({ userId: 'me', labelIds: ['INBOX'], q: 'has:attachment', maxResults: 10 });
      result.paso2_listAttachment = { count: (listAtt.data.messages || []).length, sampleIds: (listAtt.data.messages || []).slice(0, 5).map(m => m.id) };
    } catch (e) { result.paso2_error = e.message; }

    // Paso 3: Listar mensajes SIN labelIds (prueba sin filtro de label)
    try {
      const listNoLabel = await gmail.users.messages.list({ userId: 'me', q: 'has:attachment', maxResults: 10 });
      result.paso3_listNoLabel = { count: (listNoLabel.data.messages || []).length, sampleIds: (listNoLabel.data.messages || []).slice(0, 5).map(m => m.id) };
    } catch (e) { result.paso3_error = e.message; }

    // Paso 4: Tomar el primer mensaje y ver su contenido completo
    if (result.paso1_listAll && result.paso1_listAll.sampleIds.length > 0) {
      try {
        const firstId = result.paso1_listAll.sampleIds[0];
        const msg = await gmail.users.messages.get({ userId: 'me', id: firstId, format: 'full' });
        const headers = (msg.data.payload || {}).headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const parts = [];
        const collectParts = (p) => {
          if (p.filename) parts.push({ filename: p.filename, mimeType: p.mimeType, hasAttachmentId: !!p.body?.attachmentId, size: p.body?.size || 0 });
          (p.parts || []).forEach(collectParts);
        };
        collectParts(msg.data.payload || {});
        result.paso4_firstMessage = { id: firstId, subject, from, hasParts: parts.length > 0, parts, snippet: (msg.data.snippet || '').slice(0, 200) };
      } catch (e) { result.paso4_error = e.message; }
    }

    // Paso 5: Verificar quéExtensiones se permiten
    result.paso5_allowedExtensions = [...ALLOWED_EXTENSIONS];

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    // El refresh token solo se imprime en consola en desarrollo. Para permitir que
    // el administrador lo capture en producción sin acceso al servidor, se devuelve
    // (una sola vez, en la respuesta de esta autorización) al navegador.
    const refreshTokenToShow = tokens.refresh_token ? tokens.refresh_token : null;
    if (process.env.NODE_ENV === 'development') {
      console.log('[GMAIL] Autorización completada. Agregue al .env:');
      console.log('GMAIL_REFRESH_TOKEN=' + (refreshTokenToShow || ''));
    }
    if (refreshTokenToShow) {
      // Mostrar el token una sola vez para que el admin lo copie a Railway sin
      // acceso a la consola del servidor.
      return res.send(`
<!doctype html><html><head><meta charset="utf-8"><title>Autorización completada</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f6fb;display:flex;justify-content:center;padding:60px 16px;margin:0}
.card{background:#fff;border-radius:12px;padding:28px;max-width:560px;width:100%;box-shadow:0 6px 24px rgba(0,0,0,.08)}
h2{margin:0 0 8px}code{display:block;background:#f1f3f5;border:1px solid #e0e2e6;border-radius:6px;padding:12px;font-size:12px;word-break:break-all;margin:14px 0;color:#333}
.btn{background:#2563eb;color:#fff;border:0;padding:10px 18px;border-radius:6px;font-size:14px;cursor:pointer}
.hint{color:#666;font-size:13px}.ok{color:#16a34a;font-weight:600}</style></head><body>
<div class="card"><h2>Autorización completada</h2>
<p class="ok">Gmail vinculado correctamente con talentohumanova23@gmail.com</p>
<p class="hint">Copia este <b>refresh token</b> y pégalo en Railway como la variable <code>GMAIL_REFRESH_TOKEN</code> (menú Variables), y pulsa Redelploy:</p>
<code id="tok">${refreshTokenToShow}</code>
<button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('tok').textContent);this.textContent='¡Copiado!';this.style.opacity=.7">Copiar token</button>
<p class="hint" style="margin-top:14px">Este token solo se muestra una vez en este momento.</p>
</div></body></html>`);
    }
    res.json({ success: true, message: 'Autorización completada. Gmail ya quedó autorizado.' });
  } catch (error) {
    console.error('Error al autorizar Gmail:', error);
    res.status(502).json({ error: 'No se pudo completar la autorización con Google.' });
  }
});

app.get('/api/email-inbox', authMiddleware, requireAnyPermission('email.manage', 'email.read'), async (req, res) => {
  try {
    if (wantsPagination(req)) {
      const pagination = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
      res.json(await paginateQuery(col('emailsInbox'), {}, { date: -1 }, pagination));
      return;
    }
    const emails = await col('emailsInbox').find().sort({ date: -1 }).limit(200).toArray();
    res.json(emails);
  } catch (e) {
    console.error('[EMAIL-INBOX] Error:', e.message);
    res.status(503).json({ error: 'Error al obtener correos.' });
  }
});

// Mutex simple: evita dos sincronizaciones concurrentes que dupliquen archivos/correos
let gmailSyncInProgress = false;
const GMAIL_SYNC_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Lógica central de sincronización de la bandeja de una cuenta Gmail.
 *
 * Trae los correos con adjuntos de la cuenta autenticada y los inserta en
 * `emailsInbox`. El `suggestedEmployeeId` se fija según la opción:
 * - modo 'admin': por remitente (el funcionario cuyo correo coincide con el remitente).
 * - modo 'funcionario': fijado al propio funcionario (ve solo sus correos).
 *
 * @param {object} gmail - Cliente Gmail autenticado.
 * @param {object} opts - { mode, employeeId, actorName }
 * @returns {Promise<{updated: boolean, count: number, downloaded: number, emails: Array}>}
 */
async function performGmailSync(gmail, opts = {}) {
  const employeeId = opts.employeeId || null;
  const knownEmailIds = new Set((await col('emailsInbox').find().toArray()).map(e => e.id));

  // Paginar hasta agotar la bandeja (máx. 500 correos por sincronización) para no
  // dejar correos antiguos sin procesar cuando hay más de 25 pendientes.
  // Solo se traen correos con archivos adjuntos (has:attachment).
  const messageRefs = [];
  let pageToken = null;
  for (let page = 0; page < 5; page++) {
    const list = await gmail.users.messages.list({
      userId: 'me', maxResults: 100, q: 'has:attachment',
      ...(pageToken ? { pageToken } : {})
    });
    messageRefs.push(...(list.data.messages || []));
    console.log(`[GMAIL-SYNC] Página ${page + 1}: ${(list.data.messages || []).length} mensajes, nextToken: ${list.data.nextPageToken ? 'sí' : 'no'}`);
    pageToken = list.data.nextPageToken || null;
    if (!pageToken) break;
  }
  console.log(`[GMAIL-SYNC] Total mensajes con adjuntos: ${messageRefs.length}, conocidos: ${knownEmailIds.size}`);
  const newEmails = [];
  let attachmentsDownloaded = 0;

  // Todos los adjuntos persistidos a GridFS durante este lote, para revertir
  // cualquier huérfano si algo falla antes del insertMany.
  const storedAttachmentFilenames = new Set();

  try {
    for (const messageRef of messageRefs) {
      if (knownEmailIds.has(messageRef.id)) {
        continue;
      }
      const message = await gmail.users.messages.get({ userId: 'me', id: messageRef.id, format: 'full' });
      const payload = message.data.payload || {};
      const attachmentParts = getAttachmentParts(payload);

      const buffered = [];
      for (const part of attachmentParts) {
        if (!part.body || !part.body.attachmentId) {
          console.warn(`[GMAIL-SYNC] Adjunto '${part.filename}' sin attachmentId, se omite.`);
          continue;
        }
        let attachment;
        try {
          attachment = await gmail.users.messages.attachments.get({ userId: 'me', messageId: messageRef.id, id: part.body.attachmentId });
        } catch (e) {
          console.warn(`[GMAIL-SYNC] Error descargando '${part.filename}': ${e.message}`);
          continue;
        }
        if (!attachment.data || !attachment.data.data) {
          console.warn(`[GMAIL-SYNC] Adjunto '${part.filename}' sin datos, se omite.`);
          continue;
        }
        const content = Buffer.from(attachment.data.data, 'base64url');
        if (content.length > MAX_GMAIL_ATTACHMENT_BYTES) {
          console.warn(`[GMAIL-SYNC] Adjunto '${part.filename}' excede ${MAX_GMAIL_ATTACHMENT_BYTES} bytes; se omite.`);
          continue;
        }
        buffered.push({ filename: path.basename(part.filename), content });
      }

      if (await col('emailsInbox').findOne({ id: messageRef.id })) continue;

      const attachments = [];
      for (const b of buffered) {
        const contentErr = validateFileContent(b.filename, b.content);
        if (contentErr) {
          console.warn(`[GMAIL-SYNC] Adjunto '${b.filename}' omitido: ${contentErr}`);
          continue;
        }
        const filename = getUniqueFilename(b.filename);
        await storeFileBuffer(filename, b.content, { source: 'gmail', registered: false });
        attachments.push({ filename, sizeBytes: b.content.length, registered: false, source: 'gmail' });
        storedAttachmentFilenames.add(filename);
        attachmentsDownloaded++;
      }

      // Solo se registran correos que traen al menos un archivo adjunto válido.
      if (!attachments.length) {
        continue;
      }

      const headers = payload.headers || [];
      const fromHeader = getHeader(headers, 'From');
      const { senderName, senderEmail } = parseEmailFromHeader(fromHeader);

      let suggestedEmployeeId = null;
      if (opts.mode === 'funcionario') {
        suggestedEmployeeId = employeeId;
      } else {
        const matchedEmployee = await col('employees').findOne({ email: senderEmail });
        suggestedEmployeeId = matchedEmployee ? matchedEmployee.id : null;
      }

      newEmails.push({
        id: messageRef.id, sender: senderEmail || fromHeader,
        senderName, senderEmail,
        toEmail: parseToEmailHeader(getHeader(headers, 'To')),
        subject: getHeader(headers, 'Subject') || '(Sin asunto)',
        body: message.data.snippet || '',
        date: parseDateHeader(getHeader(headers, 'Date')),
        read: false, syncedBy: 'Sistema',
        suggestedEmployeeId,
        attachments
      });
    }
  } catch (e) {
    // Revertir TODOS los adjuntos guardados del lote para no dejar huérfanos.
    await rollbackStoredAttachments([...storedAttachmentFilenames]);
    throw e;
  }

  if (!newEmails.length) {
    return { updated: false, count: 0, downloaded: 0, emails: [] };
  }

  try {
    await col('emailsInbox').insertMany(newEmails);
  } catch (e) {
    // Si el insert falla, limpiar los adjuntos guardados para no dejarlos huérfanos.
    await rollbackStoredAttachments([...storedAttachmentFilenames]);
    throw e;
  }

  await addAuditLog(
    'Sincronización de Correo',
    `Se descargaron ${attachmentsDownloaded} archivo(s) desde ${newEmails.length} correo(s) de Gmail.`,
    opts.actorName || 'Sistema',
    opts.ip || ''
  );
  return { updated: true, count: newEmails.length, downloaded: attachmentsDownloaded, emails: newEmails };
}

app.post('/api/email-inbox/sync', authMiddleware, requireAnyPermission('email.manage', 'email.sync'), async (req, res) => {
  if (gmailSyncInProgress) {
    return res.status(409).json({ error: 'Ya hay una sincronización de correo en curso.' });
  }
  gmailSyncInProgress = true;
  // Watchdog: si una llamada a Google se cuelga pese al timeout, liberar el mutex
  const watchdog = setTimeout(() => { gmailSyncInProgress = false; }, GMAIL_SYNC_TIMEOUT_MS);
  if (watchdog.unref) watchdog.unref();
  try {
    const gmail = getGmailClient();
    const result = await performGmailSync(gmail, { mode: 'admin', actorName: req.user.name || 'Sistema', ip: getClientIp(req) });
    if (!result.updated) {
      return res.json({ message: 'No hay correos nuevos para sincronizar.', updated: false });
    }
    res.json({ message: `${result.count} correo(s) sincronizado(s), ${result.downloaded} archivo(s) descargado(s).`, updated: true, emails: result.emails });
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

// ============================================================
// GMAIL POR FUNCIONARIO — cada funcionario vincula SU cuenta y ve sus correos
// ============================================================
// Estados OAuth separados (anti-CSRF) para el flujo del funcionario.
const funcionarioGmailStates = new Map();
const FUNCIONARIO_GMAIL_CALLBACK = '/api/funcionario/gmail/callback';

/**
 * Crea un cliente OAuth para autorizar la cuenta de un funcionario.
 * Las credenciales del sistema (CLIENT_ID/SECRET) se reutilizan; la redirect URI
 * es la específica del funcionario.
 */
function createFuncionarioGmailAuthClient() {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET) {
    const error = new Error('Faltan variables de configuración de Gmail.');
    error.code = 'GMAIL_NOT_CONFIGURED';
    throw error;
  }
  const { google } = require('googleapis');
  return new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, FUNCIONARIO_GMAIL_CALLBACK);
}

// Consulta el estado de vínculo de la cuenta de cada funcionario (no expone el token).
app.get('/api/funcionario/gmail/status', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  try {
    let employee = null;
    try { employee = await col('employees').findOne({ id: req.user.employeeId }); } catch {}
    const linked = !!(employee && employee.gmailRefreshToken);
    res.json({
      configured: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET),
      linked,
      linkedEmail: (employee && employee.gmailEmail) || null
    });
  } catch {
    res.status(503).json({ error: 'Error al obtener el estado de Gmail.' });
  }
});

// Inicia la autorización OAuth de la cuenta del funcionario.
app.get('/api/funcionario/gmail/authorize', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  try {
    const auth = createFuncionarioGmailAuthClient();
    const state = crypto.randomBytes(24).toString('hex');
    funcionarioGmailStates.set(state, { employeeId: req.user.employeeId, at: Date.now() });
    // Limpiar estados viejos (> 15 min)
    for (const [s, v] of funcionarioGmailStates) {
      if (Date.now() - v.at > 15 * 60 * 1000) funcionarioGmailStates.delete(s);
    }
    const url = auth.generateAuthUrl({
      access_type: 'offline', prompt: 'consent', state,
      scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
    });
    res.json({ url });
  } catch (error) {
    console.error('[GMAIL-FUNC] Error en /authorize:', error.message, error.code);
    res.status(503).json({ error: 'Gmail no está configurado.' });
  }
});

// Callback OAuth del funcionario: guarda el refresh token en el empleado.
app.get('/api/funcionario/gmail/callback', async (req, res) => {
  try {
    if (!req.query.code) return res.status(400).json({ error: 'Google no devolvió un código de autorización.' });
    const state = req.query.state;
    const stateValue = state ? funcionarioGmailStates.get(state) : undefined;
    if (!state || !stateValue || Date.now() - stateValue.at > 15 * 60 * 1000) {
      if (state) funcionarioGmailStates.delete(state);
      return res.status(403).json({ error: 'Autorización inválida o expirada. Reinicie el proceso de autorización.' });
    }
    funcionarioGmailStates.delete(state);
    const employeeId = stateValue.employeeId;

    const auth = createFuncionarioGmailAuthClient();
    const { tokens } = await auth.getToken(req.query.code);
    if (!tokens.refresh_token) {
      return res.status(400).json({ error: 'Google no devolvió un refresh token. Vuélvalo a intentar.' });
    }

    // Guardar el token en el empleado y limpiar correos previos de la bandeja que
    // pertenecían a este funcionario (para evitar mezclas entre cuentas).
    const result = await col('employees').updateOne({ id: employeeId }, {
      $set: {
        gmailRefreshToken: tokens.refresh_token,
        gmailLinkedAt: new Date().toISOString()
      }
    });
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: 'Funcionario no encontrado.' });
    }

    await col('emailsInbox').deleteMany({ suggestedEmployeeId: employeeId });
    const linkedEmployee = await col('employees').findOne({ id: employeeId });
    await addAuditLog('Autorización Gmail', `El funcionario vinculó su cuenta de Gmail para la sincronización de correos.`, (linkedEmployee && linkedEmployee.name) || 'Funcionario', '');
    return res.send(`
<!doctype html><html><head><meta charset="utf-8"><title>Gmail vinculado</title>
<style>body{font-family:system-ui,sans-serif;background:#f3f6fb;display:flex;justify-content:center;padding:60px 16px;margin:0}
.card{background:#fff;border-radius:12px;padding:28px;max-width:480px;width:100%;box-shadow:0 6px 24px rgba(0,0,0,.08)}
h2{margin:0 0 8px}.ok{color:#16a34a;font-weight:600}.hint{color:#666;font-size:13px}</style></head><body>
<div class="card"><h2>Gmail vinculado</h2><p class="ok">Tu cuenta de Gmail quedó conectada.</p>
<p class="hint">Vuelve al portal del funcionario y presiona <b>Sincronizar</b> para traer los correos con documentos.</p>
<button class="btn" onclick="window.close()" style="margin-top:14px;background:#2563eb;color:#fff;border:0;padding:10px 18px;border-radius:6px;cursor:pointer">Cerrar</button>
</div></body></html>`);
  } catch (error) {
    console.error('Error al autorizar Gmail del funcionario:', error);
    res.status(502).json({ error: 'No se pudo completar la autorización con Google.' });
  }
});

// Sincroniza la cuenta del funcionario con SU propio refresh token. Solo almacena
// correos con `suggestedEmployeeId` = este funcionario, de modo que ve únicamente
// los suyos.
app.post('/api/funcionario/gmail/sync', authMiddleware, async (req, res) => {
  if (req.user.role !== 'funcionario') return res.status(403).json({ error: 'Acceso denegado.' });
  const employee = await col('employees').findOne({ id: req.user.employeeId });
  if (!employee || !employee.gmailRefreshToken) {
    return res.status(400).json({ error: 'Debe vincular su cuenta de Gmail primero.' });
  }
  try {
    const gmail = getGmailClient(employee.gmailRefreshToken);
    const result = await performGmailSync(gmail, {
      mode: 'funcionario',
      employeeId: req.user.employeeId,
      actorName: req.user.name || 'Funcionario',
      ip: getClientIp(req)
    });
    if (!result.updated) {
      return res.json({ message: 'No hay correos nuevos para sincronizar.', updated: false });
    }
    res.json({ message: `${result.count} correo(s) sincronizado(s), ${result.downloaded} archivo(s) descargado(s).`, updated: true, emails: result.emails });
  } catch (error) {
    console.error('Error al sincronizar Gmail del funcionario:', error);
    const status = error.code === 'GMAIL_NOT_CONFIGURED' ? 503 : 502;
    res.status(status).json({
      error: error.code === 'GMAIL_NOT_CONFIGURED'
        ? 'Gmail no está configurado.'
        : 'No se pudo sincronizar su bandeja de Gmail.'
    });
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

  console.error('Error no controlado:', error.stack || error.message || error);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// --- PANEL DE ESTADO DEL SISTEMA ---
// Estado consolidado para el admin: BD, índices, Gmail, escáner, métricas y seguridad.
app.get('/api/system/status', authMiddleware, requirePermission('audit.read'), async (req, res) => {
  const startedAt = Date.now();
  let dbConnected = false;
  let dbLatencyMs = null;
  const counts = {};
  let indexes = { ok: true, missing: [] };
  try {
    const t0 = Date.now();
    const [users, employees, documents] = await Promise.all([
      col('users').countDocuments(),
      col('employees').countDocuments(),
      col('documents').countDocuments()
    ]);
    dbLatencyMs = Date.now() - t0;
    dbConnected = true;
    counts.users = users;
    counts.employees = employees;
    counts.documents = documents;

    // Verificar presencia de los índices esenciales (los que listan por fecha).
    const requiredIndexes = {
      documents: ['issueDate_-1'],
      securityLogs: ['timestamp_-1'],
      emailsInbox: ['date_-1'],
      auditLogs: ['timestamp_-1']
    };
    for (const [collectionName, wanted] of Object.entries(requiredIndexes)) {
      let names = [];
      try {
        names = (await col(collectionName).indexes()).map(i => i.name);
      } catch { indexes.ok = false; }
      for (const indexName of wanted) {
        if (!names.includes(indexName)) indexes.missing.push(`${collectionName}.${indexName}`);
      }
    }
    if (indexes.missing.length > 0) indexes.ok = false;
  } catch {
    dbConnected = false;
  }

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI, GMAIL_REFRESH_TOKEN } = process.env;
  const gmailConfigured = !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REDIRECT_URI);

  let securityLast24h = null;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    securityLast24h = await col('securityLogs').countDocuments({ timestamp: { $gte: since } });
  } catch {}

  let unregistered = 0;
  try { unregistered = (await getUnregisteredFiles()).length; } catch {}

  const pkg = require('./package.json');
  res.json({
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    version: pkg.version || null,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    database: { connected: dbConnected, latencyMs: dbLatencyMs, counts, indexes },
    gmail: { configured: gmailConfigured, authenticated: gmailConfigured && !!GMAIL_REFRESH_TOKEN },
    scanner: { localFolder: fs.existsSync(SCANNER_DIR) },
    security: { last24hEvents: securityLast24h },
    documents: { unregistered },
    responseTimeMs: Date.now() - startedAt
  });
});

// --- HEALTH CHECK ---
app.get('/api/health', async (req, res) => {
  try {
    const healthy = await isHealthy();
    if (healthy) return res.json({ status: 'ok', db: 'connected' });
    res.status(200).json({ status: 'degraded', db: 'disconnected' });
  } catch {
    res.status(200).json({ status: 'error', db: 'unknown' });
  }
});

// Respaldo SPA — solo para rutas que no sean API
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ruta no encontrada.' });
  }
  const filePath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return res.status(404).send('Not found');
    const nonce = res.locals.cspNonce;
    const injected = data.replace(/<script(?![^>]*\bsrc=)(?![^>]*\snonce=)[^>]*>/gi, (tag) => {
      const close = tag.endsWith('/>') ? '/>' : '>';
      const open = tag.slice(0, -close.length);
      return `${open} nonce="${nonce}"${close}`;
    });
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });
});

// --- Verificador de salud de conexión: reconexión automática al morir el pool ---
let lastReconnectAttempt = 0;
let reconnectCooldownMs = 10000;
const RECONNECT_COOLDOWN_MS_MAX = 120000;

async function checkConnection() {
  if (isReconnecting) return;
  try {
    const healthy = await isHealthy();
    if (!healthy) {
      const now = Date.now();
      if (now - lastReconnectAttempt < reconnectCooldownMs) return;
      lastReconnectAttempt = now;
      console.warn('[MONGO] Conexión perdida, reconectando...');
      isReconnecting = true;
      const ok = await reconnect();
      isReconnecting = false;
      if (ok) {
        reconnectCooldownMs = 10000;
        console.log('[MONGO] Reconexión exitosa.');
      } else {
        reconnectCooldownMs = Math.min(RECONNECT_COOLDOWN_MS_MAX, reconnectCooldownMs * 2);
        console.warn(`[MONGO] Reconexión falló. Se reintentará en ${Math.round(reconnectCooldownMs / 1000)}s.`);
      }
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
    runDocumentRetention();
    setInterval(runDocumentRetention, 24 * 60 * 60 * 1000); // diario
  })
  .catch(error => {
    console.error('No se pudo conectar a la base de datos remota:', error.message);
  });

// Pre-cargar el modelo OCR (Tesseract 'spa') en segundo plano: no bloquea el arranque
// ni perjudica si falla (se reintenta en el primer análisis real).
if (process.env.OCR_WARMUP !== '0') {
  warmupOcr().then(ok => {
    console.log('[OCR] Modelo español precargado' + (ok ? ' (listo)' : ' (falló; se reintentará en el primer análisis)'));
  });
}

// --- RETENCIÓN DOCUMENTAL (Ley 594/2000 y política de retención) ---
function retentionMs() {
  const days = Number(process.env.DOC_RETENTION_DAYS);
  const n = Number.isFinite(days) && days > 0 ? days : 3650; // 10 años por defecto
  return n * 24 * 60 * 60 * 1000;
}

async function runDocumentRetention() {
  try {
    if (!isHealthy()) return;
    const cutoff = new Date(Date.now() - retentionMs()).toISOString();
    // Solo purga documentos archivados que hayan vencido su periodo de retención.
    const stale = await col('documents').find({
      status: { $in: ['Archivado', 'Eliminado'] },
      registeredAt: { $lt: cutoff }
    }).toArray();
    let purged = 0;
    for (const doc of stale) {
      await deleteDocAndPhysicalFile(doc.id, doc.filename);
      purged++;
    }
    if (purged > 0) {
      console.log(`[RETENCIÓN] ${purged} documento(s) vencido(s) purgado(s) por retención documental.`);
    }
  } catch (err) {
    console.warn('[RETENCIÓN] Error al ejecutar retención:', err.message);
  }
}
