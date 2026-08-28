'use strict';

const { escapeHtml } = require('./helpers');

/**
 * Plantilla HTML del correo de restablecimiento de contraseña.
 * Reutiliza exactamente el diseño de marca del sistema (escudo de Valledupar).
 *
 * @param {object} params - Parámetros de la plantilla.
 * @param {string} params.name - Nombre del destinatario.
 * @param {string|null} params.resetUrl - Enlace de restablecimiento (o `null` si no aplica).
 * @param {string} params.logoUrl - URL del escudo de la alcaldía.
 * @returns {string} HTML listo para enviar.
 */
function renderResetPasswordEmail({ name, resetUrl, logoUrl }) {
  if (!resetUrl) {
    return `<p>Hola <strong>${escapeHtml(name)}</strong>:</p>
        <p>Recibimos una solicitud para restablecer su contraseña. Contacte al administrador del sistema para continuar.</p>`;
  }
  return `<!DOCTYPE html>
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
            <p style="margin:0 0 16px;color:#333;font-size:15px;">Hola <strong>${escapeHtml(name)}</strong>,</p>
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
</html>`;
}

module.exports = { renderResetPasswordEmail };