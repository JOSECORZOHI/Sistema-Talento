// Módulo AUDITORÍA del panel administrativo.
// (división de app.js: trazabilidad de acciones y solicitudes de eliminación)

// Listas de tabla de auditoría
function renderAuditLogsTable() {
  const tbody = document.getElementById('audit-table-body');
  const resultsCount = document.getElementById('audit-results-count');
  const actionFilter = document.getElementById('audit-filter-action');
  if (!tbody || !actionFilter) return;

  const searchQuery = document.getElementById('audit-search-input').value.toLowerCase();

  const actions = [...new Set(appState.auditLogs.map(l => l.action))].sort();
  const currentVal = actionFilter.value;
  actionFilter.innerHTML = '<option value="todos">-- Todas las acciones --</option>';
  actions.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a; opt.textContent = a;
    actionFilter.appendChild(opt);
  });
  actionFilter.value = currentVal || 'todos';

  const filtered = appState.auditLogs.filter(log => {
    const textMatch = !searchQuery || 
                      (log.details || '').toLowerCase().includes(searchQuery) ||
                      (log.user || '').toLowerCase().includes(searchQuery) ||
                      (log.action || '').toLowerCase().includes(searchQuery);

    const actionMatch = actionFilter.value === 'todos' || log.action === actionFilter.value;

    return textMatch && actionMatch;
  });

  tbody.innerHTML = '';
  resultsCount.textContent = `${filtered.length} registro${filtered.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="text-center" style="text-align: center; padding: 40px; color: var(--text-muted); font-style: italic;">
          Ningún registro coincide con los criterios.
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach(log => {
    const tr = document.createElement('tr');
    
    const dateFormatted = formatDate(log.timestamp, { dateStyle: 'medium', timeStyle: 'short' });

    tr.innerHTML = `
      <td style="white-space: nowrap; font-weight: 500; font-size: 13px;">${dateFormatted}</td>
      <td>
        <strong>${sanitize(log.user)}</strong>
        ${log.ip ? `<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">${sanitize(log.ip)}</div>` : ''}
      </td>
      <td>
        <span class="category-tag" style="background-color: var(--background); color: var(--text-primary); font-size: 11px; border: 1px solid var(--border-color);">${sanitize(log.action)}</span>
      </td>
      <td style="font-size: 13px; line-height: 1.4;">${sanitize(log.details)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// --- SOLICITUDES DE ELIMINACIÓN ---

function renderDeletionRequests() {
  const tbody = document.getElementById('deletion-requests-table-body');
  const countEl = document.getElementById('deletion-requests-count');
  const badge = document.getElementById('deletion-requests-badge');
  if (!tbody) return;

  const requests = appState.deletionRequests || [];
  const pending = requests.filter(r => r.status === 'Pendiente');
  if (countEl) countEl.textContent = `${pending.length} pendiente(s) / ${requests.length} total`;
  if (badge) {
    if (pending.length > 0) { badge.style.display = 'inline'; badge.textContent = pending.length; }
    else { badge.style.display = 'none'; }
  }

  if (requests.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted);">No hay solicitudes de eliminación.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  requests.forEach(req => {
    const date = formatDate(req.createdAt, { dateStyle: 'medium', timeStyle: 'short' });
    const isPending = req.status === 'Pendiente';
    const statusColor = isPending ? '#F39C12' : req.status === 'Aprobada' ? '#27AE60' : '#E74C3C';
    const tr = document.createElement('tr');
    tr.style.opacity = isPending ? '1' : '0.6';
    tr.innerHTML = `
      <td style="font-size:13px;font-weight:600;">
        <div style="display:flex;align-items:center;gap:6px;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="var(--danger)" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
          ${sanitize(req.documentFilename)}
        </div>
      </td>
      <td style="font-size:12px;">${sanitize(req.employeeName)}</td>
      <td style="font-size:12px;max-width:200px;word-break:break-word;">${sanitize(req.reason || 'Sin motivo')}</td>
      <td style="font-size:12px;">${sanitize(req.requestedBy)}</td>
      <td style="font-size:11px;white-space:nowrap;">${date}</td>
      <td>
        <span style="font-size:11px;font-weight:700;color:${statusColor};padding:3px 10px;border-radius:6px;background:${statusColor}18;">${sanitize(req.status)}</span>
        ${isPending ? `
          <div style="display:flex;gap:4px;margin-top:6px;">
            <button class="btn btn-primary" style="padding:5px 12px;font-size:11px;" onclick="approveDeletionRequest('${escOnclick(req.id)}')">Aprobar</button>
            <button class="btn btn-secondary" style="padding:5px 12px;font-size:11px;color:var(--danger);border-color:var(--danger);" onclick="rejectDeletionRequest('${escOnclick(req.id)}')">Rechazar</button>
          </div>
        ` : `<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Por: ${sanitize(req.processedBy || '—')} ${req.processedAt ? 'el ' + new Date(req.processedAt).toLocaleString('es-CO') : ''}</div>`}
      </td>`;
    tbody.appendChild(tr);
  });
}

window.approveDeletionRequest = async function(id) {
  if (!confirm('¿Está seguro de aprobar esta eliminación? El documento se eliminará permanentemente.')) return;
  try {
    const res = await apiFetch(`/api/deletion-requests/${id}/approve`, { method: 'PATCH' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Error al aprobar.', 'error'); return; }
    showToast('Eliminación aprobada.', 'success');
    await loadAllData();
  } catch (e) { showToast('Error de conexión.', 'error'); }
};

window.rejectDeletionRequest = async function(id) {
  if (!confirm('¿Está seguro de rechazar esta solicitud?')) return;
  try {
    const res = await apiFetch(`/api/deletion-requests/${id}/reject`, { method: 'PATCH' });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Error al rechazar.', 'error'); return; }
    showToast('Solicitud rechazada.', 'success');
    await loadAllData();
  } catch (e) { showToast('Error de conexión.', 'error'); }
};