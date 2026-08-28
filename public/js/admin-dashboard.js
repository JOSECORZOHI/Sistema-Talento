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
      <div class="emp-avatar-sm" style="width:32px;height:32px;font-size:11px;flex-shrink:0;${isAuto ? 'background:linear-gradient(135deg,#1A5276,#2E86C1);color:#fff;' : ''}">${initials}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${isInactive ? 'text-decoration:line-through;color:var(--text-muted);' : ''}">${sanitize(emp.name)}</div>
        <div style="font-size:10px;color:var(--text-muted);">${sanitize(emp.department)} &bull; ${docCount} doc(s)</div>
      </div>
      ${isInactive ? '<span style="font-size:9px;font-weight:700;color:#922B21;background:#FADBD8;border-radius:10px;padding:1px 6px;flex-shrink:0;">Inactivo</span>' : isAuto ? '<span style="font-size:9px;font-weight:700;color:#1A5276;background:#D4E6F1;border-radius:10px;padding:1px 6px;flex-shrink:0;">Auto</span>' : ''}
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