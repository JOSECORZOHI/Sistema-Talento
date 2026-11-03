'use strict';
const jwt = require('jsonwebtoken');
const { col } = require('../db');

function getCollectionForRole(role) {
  return role === 'admin' ? 'users' : 'employees';
}

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET no está configurado. El servidor no puede arrancar sin esta variable de entorno.');
}

const AUTH_COOKIE = 'th_token';
const AUTH_COOKIE_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const AUTH_COOKIE_SECURE = process.env.NODE_ENV === 'production';

function authCookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: AUTH_COOKIE_SECURE, path: '/' };
}

function parseCookies(req) {
  const header = req && req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function getAuthToken(req) {
  const fromCookie = parseCookies(req)[AUTH_COOKIE];
  if (fromCookie) return fromCookie;
  const authHeader = req && req.headers && req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, { ...authCookieOptions(), maxAge: AUTH_COOKIE_MAX_AGE_MS });
}

function clearAuthCookie(res) {
  res.clearCookie(AUTH_COOKIE, authCookieOptions());
}

async function authMiddleware(req, res, next) {
  const token = getAuthToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No autenticado. Inicie sesión.' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded.v === undefined) {
      return res.status(401).json({ error: 'Sesión no válida. Inicie sesión nuevamente.' });
    }
    const collection = getCollectionForRole(decoded.role);
    const dbUser = await col(collection).findOne(
      { email: decoded.email },
      { projection: { jwtVersion: 1, status: 1, active: 1, id: 1, name: 1, mustChangePassword: 1, totpEnabled: 1 } }
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
    const bootstrapPath = req.baseUrl + req.path;
    const allowedWhileRestricted = [
      '/api/auth/change-password',
      '/api/auth/me',
      '/api/auth/2fa/status',
      '/api/auth/2fa/setup',
      '/api/auth/2fa/enable',
      '/api/auth/logout'
    ].includes(bootstrapPath);
    if (decoded.role === 'funcionario' && dbUser.active === false && !allowedWhileRestricted) {
      return res.status(401).json({ error: 'Su cuenta no está activa. Contacte al administrador.' });
    }
    if (dbUser.mustChangePassword && !allowedWhileRestricted) {
      return res.status(403).json({ error: 'Debe cambiar su contraseña antes de continuar.', mustChangePassword: true });
    }
    const requireAdmin2FA = process.env.REQUIRE_ADMIN_2FA === 'true' || process.env.NODE_ENV === 'production';
    if (decoded.role === 'admin' && requireAdmin2FA && !dbUser.totpEnabled && !allowedWhileRestricted) {
      return res.status(403).json({
        error: 'Debe configurar la autenticación de dos factores (2FA) antes de realizar acciones administrativas.',
        mustSetup2FA: true
      });
    }
    req.user = decoded;
    if (decoded.role === 'admin' && !dbUser.totpEnabled) {
      req.user.mustSetup2FA = true;
    }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Sesión expirada. Inicie sesión nuevamente.' });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return res.status(401).json({ error: 'Token inválido. Inicie sesión nuevamente.' });
    }
    return res.status(503).json({ error: 'Error temporal de base de datos. Intente de nuevo en unos segundos.' });
  }
}

function fileAuthMiddleware(req, res, next) {
  if (req.query && req.query.token && (!req.headers || !req.headers.authorization)) {
    return res.status(401).json({ error: 'Autenticación inválida. Vuelva a iniciar sesión.' });
  }
  return authMiddleware(req, res, next);
}

module.exports = {
  AUTH_COOKIE,
  AUTH_COOKIE_MAX_AGE_MS,
  authCookieOptions,
  parseCookies,
  getAuthToken,
  setAuthCookie,
  clearAuthCookie,
  authMiddleware,
  fileAuthMiddleware
};
