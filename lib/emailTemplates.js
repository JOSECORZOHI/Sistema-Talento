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

/**
 * Plantilla HTML del correo de credenciales de acceso (creación de empleado).
 * Mismo diseño de marca que el correo de restablecimiento de contraseña.
 *
 * @param {object} params - Parámetros de la plantilla.
 * @param {string} params.name - Nombre del funcionario.
 * @param {string} params.email - Correo institucional (ya normalizado).
 * @param {string} params.tempPassword - Contraseña temporal generada.
 * @param {string} params.logoUrl - URL del escudo de la alcaldía.
 * @param {string} params.loginUrl - URL de inicio de sesión.
 * @returns {string} HTML listo para enviar.
 */
function renderCredentialsEmail({ name, email, tempPassword, logoUrl, loginUrl }) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#1A5276 0%,#154360 50%,#0E2F44 100%);padding:32px 40px;text-align:center;">
            <img src="${logoUrl}" alt="Escudo" width="72" height="72" style="display:block;margin:0 auto 16px;border-radius:14px;background:rgba(255,255,255,0.12);padding:8px;">
            <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">Sistema de Talento Humano</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Alcald&iacute;a de Valledupar</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px;">
            <p style="margin:0 0 16px;color:#333;font-size:15px;">Hola <strong>${escapeHtml(name)}</strong>,</p>
            <p style="margin:0 0 20px;color:#555;font-size:14px;line-height:1.6;">Se cre&oacute; su cuenta en el Sistema de Gesti&oacute;n Documental de la Alcald&iacute;a de Valledupar. A continuaci&oacute;n sus credenciales de acceso iniciales:</p>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7fb;border:1px solid #d6e8f2;border-radius:8px;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 4px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Correo electr&oacute;nico</p>
                <p style="margin:0 0 16px;color:#1A5276;font-size:16px;font-weight:700;">${escapeHtml(email)}</p>
                <p style="margin:0 0 4px;color:#888;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;">Contrase&ntilde;a temporal</p>
                <p style="margin:0 0 4px;color:#c0392b;font-size:18px;font-weight:700;font-family:Consolas,Monaco,monospace;letter-spacing:1px;">${escapeHtml(tempPassword)}</p>
                <p style="margin:8px 0 0;color:#e67e22;font-size:12px;font-weight:600;">Debe cambiar esta contrase&ntilde;a en su primer inicio de sesi&oacute;n.</p>
              </td></tr>
            </table>
            <p style="margin:0 0 12px;color:#555;font-size:14px;line-height:1.6;">Ingrese al sistema con las credenciales anteriores. Ser&aacute; obligatorio crear una nueva contrase&ntilde;a.</p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px 0 24px;">
                  <a href="${escapeHtml(loginUrl)}" style="display:inline-block;background:#1A5276;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:14px 36px;border-radius:8px;">Ingresar al sistema</a>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#999;font-size:12px;line-height:1.5;">Por seguridad, cambie su contrase&ntilde;a lo antes posible. Si no solicit&oacute; esta cuenta, ignore este correo.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f8f9fa;border-top:1px solid #eee;padding:20px 40px;text-align:center;">
            <p style="margin:0;color:#aaa;font-size:11px;">Sistema de Gesti&oacute;n Documental &mdash; Talento Humano &middot; Alcald&iacute;a de Valledupar</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

module.exports = { renderResetPasswordEmail, renderCredentialsEmail };