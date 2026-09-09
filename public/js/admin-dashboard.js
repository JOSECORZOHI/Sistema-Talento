/* exported renderStats, fetchSystemStatus, renderSystemStatus, initTwoFactorPanel */
// Módulo DASHBOARD del panel administrativo.
// Funciones puras de renderizado del dashboard general (redux: app.js se dividió
// en módulos por vista). Se cargan ANTES de app.js; dependen de utils.js y del
// estado global `appState` (definido en app.js) solo en tiempo de ejecución.

function renderStats(stats) {
  statTotalDocs.textContent = stats.totalRegistered;
  statPendingDocs.textContent = stats.pendingCount;
  statTotalEmployees.textContent = stats.totalEmployees;
  statUnregisteredDocs.textContent = stats.unregisteredCount;
  badgeUnregistered.textContent = stats.unregisteredCount;
  badgeUnregistered.style.display = stats.unregisteredCount > 0 ? 'inline-block' : 'none';
  renderDashboardChart(stats.docTypesDistribution, stats.totalRegistered);
  renderRecentActivity(stats.recentLogs);
  renderDashboardEmployees();
}

// Gráfico de barras personalizado del dashboard
function renderDashboardChart(data, totalCount) {
  const wrapper = document.getElementById('types-chart-wrapper');
  if (!wrapper) return;

  if (data.length === 0 || totalCount === 0) {
    wrapper.innerHTML = '<div class="no-data-placeholder">No hay documentos registrados para graficar.</div>';
    return;
  }

  wrapper.innerHTML = '';
  data.forEach(item => {
    const percent = totalCount > 0 ? Math.round((item.count / totalCount) * 100) : 0;

    const row = document.createElement('div');
    row.className = 'chart-bar-row';
    row.innerHTML = `
      <div class="chart-bar-info">
        <span class="chart-bar-label">${sanitize(item.name)}</span>
        <span class="chart-bar-value">${item.count} (${percent}%)</span>
      </div>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width: ${percent}%"></div>
      </div>
    `;
    wrapper.appendChild(row);
  });
}

// Lista de empleados del dashboard
function renderDashboardEmployees() {
  const container = document.getElementById('dashboard-employee-list');
  const countEl = document.getElementById('dashboard-employee-count');
  if (!container) return;

  const employees = appState.employees;
  if (countEl) countEl.textContent = employees.length + ' registrados';

  if (employees.length === 0) {
    container.innerHTML = '<div class="no-data-placeholder" style="height:80px;">No hay funcionarios registrados.</div>';
    return;
  }

  container.innerHTML = '';
  employees.forEach(emp => {
    const isInactive = emp.active === false;
    const isAuto = emp.registeredBy === 'Auto-Registro';
    const initials = getInitials(emp.name);
    const docCount = appState.documents.filter(d => d.employeeId === emp.id).length;

    const div = document.createElement('div');
    div.style.cssText = `display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border-color);cursor:pointer;${isInactive ? 'opacity:0.5;' : ''}`;
    div.onclick = () => { window.location.hash = '#expedientes'; setTimeout(() => selectEmployeeForFolder(emp.id), 100); };
    div.innerHTML = `
      <div class="emp-avatar-sm" style="width:32px;height:32px;font-size:11px;flex-shrink:0;${isAuto ? 'background:linear-gradient(135deg,var(--primary),var(--primary-hover));color:#fff;' : ''}">${initials}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${isInactive ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${sanitize(emp.name)}</div>
        <div style="font-size:10px;color:var(--text-muted);">${sanitize(emp.department)} &bull; ${docCount} doc(s)</div>
      </div>
      ${isInactive ? '<span class="badge-chip red" style="flex-shrink:0;">Inactivo</span>' : isAuto ? '<span class="badge-chip blue" style="flex-shrink:0;">Auto</span>' : ''}
    `;
    container.appendChild(div);
  });
}

// Actividades recientes del dashboard
function renderRecentActivity(logs) {
  const wrapper = document.getElementById('recent-activity-timeline');
  if (!wrapper) return;

  if (!logs || logs.length === 0) {
    wrapper.innerHTML = '<div class="no-data-placeholder">No hay movimientos registrados.</div>';
    return;
  }

  wrapper.innerHTML = '';
  logs.forEach(log => {
    const timeFormatted = formatRelativeTime(new Date(log.timestamp));

    // Clasificar acción para estilos
    let actionClass = 'update';
    const act = (log.action || '').toLowerCase();
    if (act.includes('crear') || act.includes('registro')) {
      actionClass = 'create';
    } else if (act.includes('carga') || act.includes('subi')) {
      actionClass = 'upload';
    } else if (act.includes('elimin') || act.includes('borrar')) {
      actionClass = 'delete';
    } else if (act.includes('archiv')) {
      actionClass = 'archive';
    }

    const item = document.createElement('div');
    item.className = `timeline-item ${actionClass}`;
    item.innerHTML = `
      <div class="timeline-marker"></div>
      <div class="timeline-content">
        <h5>${sanitize(log.action)}</h5>
        <p>${sanitize(log.details)}</p>
        <span class="timeline-time">${timeFormatted} &bull; Por ${sanitize(log.user)}</span>
      </div>
    `;
    wrapper.appendChild(item);
  });
}

// Helper de formato de tiempo relativo
function formatRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'Hace un momento';
  if (diffMin < 60) return `Hace ${diffMin} min`;
  if (diffHr < 24) return `Hace ${diffHr} hr`;
  if (diffDay === 1) return 'Ayer';
  return date.toLocaleDateString();
}

// --- PANEL DE ESTADO DEL SISTEMA ---
async function fetchSystemStatus() {
  try {
    const res = await apiFetch('/api/system/status');
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

function renderSystemStatus(status) {
  const el = document.getElementById('system-status-panel');
  if (!el || !status) return;

  const dbColor = status.database.connected ? 'var(--success)' : 'var(--danger)';
  const dbText = status.database.connected ? 'Conectada' : 'Desconectada';
  const gmailColor = status.gmail.authenticated ? 'var(--success)' : (status.gmail.configured ? 'var(--warning)' : 'var(--danger)');
  const gmailText = status.gmail.authenticated ? 'Autenticado' : (status.gmail.configured ? 'Sin autorizar' : 'No configurado');
  const indexesMissing = (status.database.indexes && status.database.indexes.missing) || [];
  const indexesText = indexesMissing.length === 0 ? 'OK' : `Faltan: ${indexesMissing.join(', ')}`;
  const indexesColor = indexesMissing.length === 0 ? 'var(--success)' : 'var(--danger)';
  const mem = status.memoryMb != null ? status.memoryMb + ' MB' : '—';
  const uptimeMin = status.uptimeSeconds != null ? Math.round(status.uptimeSeconds / 60) + ' min' : '—';
  const secColor = status.security.last24hEvents > 0 ? 'var(--warning)' : 'var(--success)';

  el.innerHTML = `
    <div class="system-status-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;font-size:12px;">
      <div style="background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:10px;">
        <div style="color:var(--text-muted);font-size:11px;">Base de datos</div>
        <div style="font-weight:700;color:${dbColor};font-size:13px;">● ${dbText}</div>
        <div style="color:var(--text-muted);">${status.database.latencyMs != null ? status.database.latencyMs + ' ms' : '—'} · ${status.database.connected ? status.database.counts.documents + ' docs' : ''}</div>
      </div>
      <div style="background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:10px;">
        <div style="color:var(--text-muted);font-size:11px;">Gmail</div>
        <div style="font-weight:700;color:${gmailColor};font-size:13px;">● ${gmailText}</div>
        <div style="color:var(--text-muted);">Configurado: ${status.gmail.configured ? 'Sí' : 'No'}</div>
      </div>
      <div style="background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:10px;">
        <div style="color:var(--text-muted);font-size:11px;">Índices BD</div>
        <div style="font-weight:700;color:${indexesColor};font-size:13px;">${indexesMissing.length === 0 ? '✓ OK' : '✕ Revisar'}</div>
        <div style="color:var(--text-muted);">${sanitize(indexesText)}</div>
      </div>
      <div style="background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:10px;">
        <div style="color:var(--text-muted);font-size:11px;">Seguridad (24 h)</div>
        <div style="font-weight:700;color:${secColor};font-size:13px;">${status.security.last24hEvents != null ? status.security.last24hEvents + ' eventos' : '—'}</div>
        <div style="color:var(--text-muted);">Uptime: ${uptimeMin} · RAM ${mem}</div>
      </div>
      <div style="background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:10px;">
        <div style="color:var(--text-muted);font-size:11px;">Bandeja escáner / Archivos</div>
        <div style="font-weight:700;font-size:13px;">${status.scanner.localFolder ? '✓ Local' : '— No-local'} · ${status.documents.unregistered} por registrar</div>
        <div style="color:var(--text-muted);">Node ${status.node || '—'} · v${status.version || '—'} · ${status.responseTimeMs} ms</div>
      </div>
    </div>
    <button class="btn btn-text btn-sm" style="margin-top:10px;font-size:12px;" onclick="fetchSystemStatus().then(renderSystemStatus)">↻ Refrescar estado</button>
  `;
}

// --- SEGURIDAD: AUTENTICACIÓN DE DOS FACTORES (2FA / TOTP) ---
const TWO_FA_SHIELD_SVG = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>';

async function initTwoFactorPanel() {
  const panel = document.getElementById('twofa-panel');
  if (!panel) return;
  try {
    const res = await apiFetch('/api/auth/2fa/status');
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    renderTwoFactorPanel(!!data.enabled);
  } catch (e) {
    panel.innerHTML = '<div class="no-data-placeholder">No se pudo consultar el estado de 2FA.</div>';
  }
}

function renderTwoFactorPanel(enabled) {
  const panel = document.getElementById('twofa-panel');
  if (!panel) return;
  const title = enabled
    ? '<div style="font-size:13px;font-weight:700;color:var(--success);margin-bottom:6px;">● Activada</div>'
    : '<div style="font-size:13px;font-weight:700;color:var(--text-muted);margin-bottom:6px;">● Desactivada</div>';
  const desc = enabled
    ? '<p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">Se solicita el código de su aplicación de autenticación al iniciar sesión.</p>'
    : '<p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">Agregue una capa adicional de seguridad a su cuenta con una aplicación de autenticación (Google Authenticator, Authy, Microsoft Authenticator, etc.).</p>';
  const btn = enabled
    ? '<button class="btn btn-text btn-sm" id="btn-2fa-disable" style="font-size:12px;color:var(--danger);">Desactivar 2FA</button>'
    : '<button class="btn btn-primary btn-sm" id="btn-2fa-setup" style="font-size:12px;">Configurar 2FA</button>';
  panel.innerHTML = title + desc + btn;

  const setupBtn = document.getElementById('btn-2fa-setup');
  if (setupBtn) setupBtn.addEventListener('click', twoFaSetup);
  const disableBtn = document.getElementById('btn-2fa-disable');
  if (disableBtn) disableBtn.addEventListener('click', renderTwoFactorDisable);
}

async function twoFaSetup() {
  const panel = document.getElementById('twofa-panel');
  if (!panel) return;
  try {
    const res = await apiFetch('/api/auth/2fa/setup', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error generando el secreto.');
    panel.innerHTML = `
      <div style="font-size:13px;font-weight:700;color:var(--primary);margin-bottom:6px;">Configuración de 2FA</div>
      <p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">Escanee el código con su aplicación de autenticación o ingrese manualmente este secreto:</p>
      <div style="font-family:monospace;background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:10px;font-size:13px;word-break:break-all;margin-bottom:10px;">${sanitize(data.secret)}</div>
      <a href="${sanitize(data.otpauth)}" target="_blank" rel="noopener" style="font-size:12px;color:var(--primary);">Abrir enlace de configuración (otpauth)</a>
      <div class="login-field" style="margin-top:12px;">
        <label for="twofa-enable-code">Código de la aplicación</label>
        <div class="login-input-wrapper">
          ${TWO_FA_SHIELD_SVG}
          <input type="text" id="twofa-enable-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" id="btn-2fa-enable" style="font-size:12px;">Activar 2FA</button>
        <button class="btn btn-text btn-sm" id="btn-2fa-cancel-setup" style="font-size:12px;">Cancelar</button>
      </div>
      <div class="login-error-msg" id="twofa-error" style="display:none;margin-top:10px;"></div>
    `;
    const enableBtn = document.getElementById('btn-2fa-enable');
    if (enableBtn) enableBtn.addEventListener('click', () => twoFaEnable(data.secret));
    const cancelBtn = document.getElementById('btn-2fa-cancel-setup');
    if (cancelBtn) cancelBtn.addEventListener('click', initTwoFactorPanel);
    const codeInput = document.getElementById('twofa-enable-code');
    if (codeInput) codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); });
  } catch (e) {
    panel.innerHTML = '<div class="no-data-placeholder">' + sanitize(e.message) + '</div>';
  }
}

async function twoFaEnable(secret) {
  const codeInput = document.getElementById('twofa-enable-code');
  const errDiv = document.getElementById('twofa-error');
  const btn = document.getElementById('btn-2fa-enable');
  if (!codeInput || !btn) return;
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    if (errDiv) { errDiv.textContent = 'Ingrese el código de 6 dígitos.'; errDiv.style.display = 'block'; }
    return;
  }
  if (errDiv) errDiv.style.display = 'none';
  btn.disabled = true;
  btn.textContent = 'Activando...';
  try {
    const res = await apiFetch('/api/auth/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, code }) });
    const data = await res.json();
    if (!res.ok) {
      if (errDiv) { errDiv.textContent = data.error || 'No se pudo activar 2FA.'; errDiv.style.display = 'block'; }
      return;
    }
    showToast(data.message || '2FA activada.', 'success');
    renderTwoFactorPanel(true);
  } catch (err) {
    if (errDiv) { errDiv.textContent = 'Error de conexión.'; errDiv.style.display = 'block'; }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Activar 2FA';
  }
}

function renderTwoFactorDisable() {
  const panel = document.getElementById('twofa-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div style="font-size:13px;font-weight:700;color:var(--danger);margin-bottom:6px;">Desactivar 2FA</div>
    <p style="margin:0 0 12px;font-size:13px;color:var(--text-secondary);">Ingrese un código vigente de su aplicación para confirmar la desactivación.</p>
    <div class="login-field">
      <label for="twofa-disable-code">Código de la aplicación</label>
      <div class="login-input-wrapper">
        ${TWO_FA_SHIELD_SVG}
        <input type="text" id="twofa-disable-code" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code">
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
      <button class="btn btn-text btn-sm" id="btn-2fa-disable-confirm" style="font-size:12px;color:var(--danger);">Confirmar desactivación</button>
      <button class="btn btn-text btn-sm" id="btn-2fa-cancel-disable" style="font-size:12px;">Cancelar</button>
    </div>
    <div class="login-error-msg" id="twofa-error" style="display:none;margin-top:10px;"></div>
  `;
  const confirmBtn = document.getElementById('btn-2fa-disable-confirm');
  if (confirmBtn) confirmBtn.addEventListener('click', twoFaDisable);
  const cancelBtn = document.getElementById('btn-2fa-cancel-disable');
  if (cancelBtn) cancelBtn.addEventListener('click', () => renderTwoFactorPanel(true));
  const codeInput = document.getElementById('twofa-disable-code');
  if (codeInput) codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6); });
}

async function twoFaDisable() {
  const codeInput = document.getElementById('twofa-disable-code');
  const errDiv = document.getElementById('twofa-error');
  const btn = document.getElementById('btn-2fa-disable-confirm');
  if (!codeInput || !btn) return;
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    if (errDiv) { errDiv.textContent = 'Ingrese el código de 6 dígitos.'; errDiv.style.display = 'block'; }
    return;
  }
  if (errDiv) errDiv.style.display = 'none';
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/auth/2fa/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const data = await res.json();
    if (!res.ok) {
      if (errDiv) { errDiv.textContent = data.error || 'No se pudo desactivar 2FA.'; errDiv.style.display = 'block'; }
      return;
    }
    showToast(data.message || '2FA desactivada.', 'success');
    renderTwoFactorPanel(false);
  } catch (err) {
    if (errDiv) { errDiv.textContent = 'Error de conexión.'; errDiv.style.display = 'block'; }
  } finally {
    btn.disabled = false;
  }
}