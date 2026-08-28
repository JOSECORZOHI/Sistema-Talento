'use strict';

/**
 * Escapa caracteres HTML para evitar inyección XSS al insertar texto en el DOM.
 *
 * @param {*} value - Valor a escapar (se convierte a texto).
 * @returns {string} Texto seguro para HTML.
 */
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Normaliza un correo electrónico (espacios y mayúsculas) para comparaciones.
 *
 * @param {string} email - Correo electrónico crudo.
 * @returns {string} Correo normalizado en minúsculas.
 */
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Extrae nombre y correo desde una cabecera "From" de un correo.
 *
 * @param {string} fromHeader - Valor crudo de la cabecera From.
 * @returns {{senderName:string, senderEmail:string}} Datos del remitente.
 */
function parseEmailFromHeader(fromHeader) {
  if (!fromHeader) return { senderName: 'Remitente desconocido', senderEmail: '' };
  const match = fromHeader.match(/^(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?$/);
  if (!match) return { senderName: fromHeader, senderEmail: fromHeader };
  return { senderName: (match[1] || match[2] || fromHeader).trim(), senderEmail: normalizeEmail(match[2] || fromHeader) };
}

/**
 * Extrae el correo destinatario desde una cabecera "To".
 * Soporta tanto "correo@dominio.co" como "Nombre <correo@dominio.co>".
 *
 * @param {string} toHeader - Valor crudo de la cabecera To.
 * @returns {string} Correo normalizado o cadena vacía si no hay cabecera.
 */
function parseToEmailHeader(toHeader) {
  if (!toHeader) return '';
  const match = toHeader.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return match ? normalizeEmail(match[0]) : normalizeEmail(toHeader);
}

/**
 * Busca una cabecera por nombre (insensible a mayúsculas) en una lista de la API de Gmail.
 *
 * @param {Array<{name:string, value:string}>} headers - Arreglo de cabeceras (API Gmail).
 * @param {string} name - Nombre de la cabecera a buscar.
 * @returns {string} Valor de la cabecera o cadena vacía.
 */
function getHeader(headers, name) {
  const header = headers.find(item => item.name.toLowerCase() === name.toLowerCase());
  return header ? header.value : '';
}

/**
 * Convierte una fecha de cabecera a ISO-8601. Ante valores inválidos usa el momento actual.
 *
 * @param {string} value - Fecha cruda.
 * @returns {string} Fecha en formato ISO-8601.
 */
function parseDateHeader(value) {
  if (!value) return new Date().toISOString();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * Valida la fortaleza de una contraseña acorde a la política del sistema.
 *
 * @param {string} password - Contraseña a validar.
 * @returns {{valid:boolean, error?:string}} Resultado de la validación.
 */
function validatePasswordStrength(password) {
  if (password.length < 12) return { valid: false, error: 'La contraseña debe tener al menos 12 caracteres.' };
  if (Buffer.byteLength(password, 'utf8') > 72) return { valid: false, error: 'La contraseña no debe superar los 72 caracteres.' };
  if (!/[A-Z]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos una letra mayúscula.' };
  if (!/[a-z]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos una letra minúscula.' };
  if (!/[0-9]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos un número.' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) return { valid: false, error: 'La contraseña debe contener al menos un símbolo.' };
  return { valid: true };
}

module.exports = {
  escapeHtml,
  normalizeEmail,
  parseEmailFromHeader,
  parseToEmailHeader,
  getHeader,
  parseDateHeader,
  validatePasswordStrength
};