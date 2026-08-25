// Verificación de autenticación (sanitize, apiFetch, checkAuth en utils.js)
(function checkAuthAdmin() {
  if (!checkAuth('admin')) return;
  fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + getToken() } })
    .then(res => { if (!res.ok) logout(); })
    .catch(() => {});
})();

// --- CAMBIO FORZADO DE CONTRASEÑA ---
(function initForceChangePassword() {
  const user = getUser();
  if (!user || !user.mustChangePassword) return;
  const modal = document.getElementById('modal-force-change-password');
  if (!modal) return;
  modal.classList.add('show');
  document.addEventListener('keydown', function blockEsc(e) { if (e.key === 'Escape') e.stopPropagation(); }, true);
  modal.addEventListener('click', function blockBg(e) { if (e.target === modal) e.stopPropagation(); }, true);
  document.getElementById('form-force-change-password').addEventListener('submit', async function(e) {
    e.preventDefault();
    const errDiv = document.getElementById('fcp-error');
    errDiv.style.display = 'none';
    const currentPassword = document.getElementById('fcp-current').value;
    const newPassword = document.getElementById('fcp-new').value;
    const confirm = document.getElementById('fcp-confirm').value;
    if (newPassword !== confirm) { errDiv.textContent = 'Las contraseñas nuevas no coinciden.'; errDiv.style.display = 'block'; return; }
    if (newPassword === currentPassword) { errDiv.textContent = 'La nueva contraseña debe ser diferente a la actual.'; errDiv.style.display = 'block'; return; }
    try {
      const res = await apiFetch('/api/auth/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword, newPassword }) });
      const data = await res.json();
      if (!res.ok) { errDiv.textContent = data.error || 'Error al cambiar contraseña.'; errDiv.style.display = 'block'; return; }
      user.mustChangePassword = false;
      localStorage.setItem('th_user', JSON.stringify(user));
      modal.classList.remove('show');
      showToast('Contraseña actualizada. Debe iniciar sesión nuevamente.', 'success');
      setTimeout(() => { logout(); }, 1500);
    } catch (err) { errDiv.textContent = 'Error de conexión.'; errDiv.style.display = 'block'; }
  });
})();

// GLOBALES Y ESTADO
let appState = {
  employees: [],
  documentTypes: [],
  categories: [],
  documents: [],
  unregisteredFiles: [],
  auditLogs: [],
  selectedEmployeeId: null,
  currentFolderCategory: 'todos',
  scannerFiles: [],
  emails: [],
  selectedEmailId: null,
  scannerIntervalId: null
};

// ELEMENTOS DEL DOM
const sections = document.querySelectorAll('.app-section');
const menuItems = document.querySelectorAll('.menu-item');
const sectionTitle = document.getElementById('current-section-title');
const sectionSubtitle = document.getElementById('current-section-subtitle');

// Disparadores de navegación
const navDashboard = document.getElementById('btn-nav-dashboard');
const navConsultas = document.getElementById('btn-nav-consultas');
const navRegistro = document.getElementById('btn-nav-registro');
const navFuncionarios = document.getElementById('btn-nav-funcionarios');
const navExpedientes = document.getElementById('btn-nav-expedientes');
const navAuditoria = document.getElementById('btn-nav-auditoria');
const navEliminaciones = document.getElementById('btn-nav-eliminaciones');

// DOM de estadísticas
const statTotalDocs = document.getElementById('stat-total-docs');
const statPendingDocs = document.getElementById('stat-pending-docs');
const statTotalEmployees = document.getElementById('stat-total-employees');
const statUnregisteredDocs = document.getElementById('stat-unregistered-docs');
const badgeUnregistered = document.getElementById('badge-unregistered-files');

// Elementos de tema se manejan en utils.js

// Información del usuario desde sesión
const userInfo = getUser() || {};
if (userInfo.name) {
  document.getElementById('user-avatar').textContent = getInitials(userInfo.name);
  document.getElementById('user-display-name').textContent = userInfo.name;
  document.getElementById('user-display-dept').textContent = userInfo.department || 'Talento Humano';
  document.getElementById('user-display-email').textContent = userInfo.email || '';
}

// Modales
const modalViewPdf = document.getElementById('modal-view-pdf');
const modalEditDoc = document.getElementById('modal-edit-document');
const modalAddEmp = document.getElementById('modal-add-employee');

// INICIALIZACIÓN
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupEventListeners();
  loadAllData();

  // Botón de cerrar sesión
  document.getElementById('btn-logout').addEventListener('click', logout);

  // Botón de actualizar escáneres
  document.getElementById('btn-portal-refresh-scanners')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-portal-refresh-scanners');
    btn.disabled = true;
    btn.textContent = '🔄 Buscando...';
    try {
      await apiFetch('/api/scanner/refresh', { method: 'POST' });
      await refreshScannerStatus();
    } catch (e) { console.error('Error refrescando escáneres:', e); }
    btn.disabled = false;
    btn.textContent = '🔄 Actualizar lista';
  });

  // Botón de escaneo real
  const btnScan = document.getElementById('btn-portal-scan');
  if (btnScan) {
    btnScan.addEventListener('click', async () => {
      const filenameInput = document.getElementById('input-scan-filename');
      const customName = filenameInput ? filenameInput.value.trim() : '';
      btnScan.disabled = true;
      btnScan.textContent = 'Escaneando...';
      try {
        const res = await apiFetch('/api/scanner/scan', { method: 'POST', body: JSON.stringify({ filename: customName || undefined }), headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Error al escanear.', 'error');
        } else {
          showToast('Archivo escaneado: ' + data.filename, 'success');
          if (filenameInput) filenameInput.value = '';
          await fetchScannerFiles();
        }
      } catch (e) {
        showToast('Error de red al escanear.', 'error');
      } finally {
        btnScan.disabled = false;
        btnScan.textContent = 'Escanear Documento';
      }
    });
  }

  // Botón para abrir EPSON Scan 2 (multifunción sin WIA: escanear a la bandeja)
  const btnEpsonScan = document.getElementById('btn-portal-epson-scan');
  if (btnEpsonScan) {
    btnEpsonScan.addEventListener('click', async () => {
      btnEpsonScan.disabled = true;
      try {
        const res = await apiFetch('/api/scanner/launch-epson-scan', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          showToast(data.error || 'Error al abrir EPSON Scan 2.', 'error');
        } else {
          showToast(data.message || 'EPSON Scan 2 abierto.', 'success');
        }
      } catch (e) {
        showToast('Error de red al abrir EPSON Scan 2.', 'error');
      } finally {
        btnEpsonScan.disabled = false;
      }
    });
  }

  // Botón de sincronización de correo
  const btnSync = document.getElementById('btn-sync-email');
  if (btnSync) {
    btnSync.addEventListener('click', async () => {
      btnSync.disabled = true;
      btnSync.textContent = 'Sincronizando...';
      try {
        const res = await apiFetch('/api/email-inbox/sync', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 503) {
            showToast('Gmail no está configurado. Revise las instrucciones en la bandeja de correo.', 'warning');
          } else {
            showToast(data.error || 'Error al sincronizar correos.', 'error');
          }
        } else {
          showToast(data.message || 'Bandeja sincronizada con éxito.', 'success');
          await fetchEmails();
        }
      } catch (e) {
        showToast('Error de red al sincronizar correos.', 'error');
      } finally {
        btnSync.disabled = false;
        btnSync.textContent = 'Sincronizar';
      }
    });
  }

  // Botón de cancelar subida
  const btnCancelUpload = document.getElementById('btn-cancel-upload');
  if (btnCancelUpload) {
    btnCancelUpload.addEventListener('click', () => {
      document.getElementById('form-upload-document').reset();
      const preview = document.getElementById('file-name-preview');
      if (preview) preview.textContent = 'Ningún archivo seleccionado';
    });
  }

  // Actualización automática del estado del escáner al cargar
  refreshScannerStatus();
});

// apiFetch() se define en utils.js

// initTheme y updateThemeUI se definen en utils.js
initTheme('.sun-icon', '.moon-icon', '#theme-text');
setupThemeToggle('#theme-toggle', '.sun-icon', '.moon-icon', '#theme-text');

// 2. ENRUTADOR DE NAVEGACIÓN SPA
function setupNavigation() {
  const navigateTo = (hash) => {
    // Detener interval de escáner al cambiar de pestaña
    if (appState.scannerIntervalId) {
      clearInterval(appState.scannerIntervalId);
      appState.scannerIntervalId = null;
    }

    sections.forEach(sec => sec.classList.remove('active'));
    menuItems.forEach(item => item.classList.remove('active'));
    
    let targetSection = 'section-dashboard';
    let title = 'Dashboard General';
    let subtitle = 'Gestión e indicadores clave de expedientes laborales';
    let activeBtn = navDashboard;

    if (hash === '#consultas') {
      targetSection = 'section-consultas';
      title = 'Consultas y Búsquedas';
      subtitle = 'Consulte expedientes de forma centralizada y filtre con rapidez';
      activeBtn = navConsultas;
      renderDocumentsTable();
    } else if (hash === '#registro') {
      targetSection = 'section-registro';
      title = 'Digitalización y Carga';
      subtitle = 'Suba nuevos documentos PDF o registre expedientes locales detectados';
      activeBtn = navRegistro;
      switchSubTab('manual');
      fetchUnregisteredFiles();
      // Reiniciar interval de escáner al entrar a la pestaña de registro
      refreshScannerStatus();
      appState.scannerIntervalId = setInterval(refreshScannerStatus, 15000);
    } else if (hash === '#expedientes') {
      targetSection = 'section-expedientes';
      title = 'Expedientes por Funcionario';
      subtitle = 'Inspeccione la hoja de vida digital completa de cada funcionario';
      activeBtn = navExpedientes;
      renderEmployeeDirectory();
    } else if (hash === '#funcionarios') {
      targetSection = 'section-funcionarios';
      title = 'Gestión de Funcionarios';
      subtitle = 'Directorio completo del talento humano de la administración municipal';
      activeBtn = navFuncionarios;
      renderEmployeesTable();
    } else if (hash === '#auditoria') {
      targetSection = 'section-auditoria';
      title = 'Trazabilidad y Auditoría';
      subtitle = 'Bitácora detallada de integridad de la información y accesos';
      activeBtn = navAuditoria;
      renderAuditLogsTable();
    } else if (hash === '#eliminaciones') {
      targetSection = 'section-eliminaciones';
      title = 'Solicitudes de Eliminación';
      subtitle = 'Gestione las solicitudes de eliminación de documentos de los funcionarios';
      activeBtn = navEliminaciones;
      renderDeletionRequests();
    }

    const targetEl = document.getElementById(targetSection);
    if (targetEl) targetEl.classList.add('active');
    if (activeBtn) activeBtn.classList.add('active');
    sectionTitle.textContent = title;
    sectionSubtitle.textContent = subtitle;
  };

  // Escuchar cambios de hash
  window.addEventListener('hashchange', () => {
    navigateTo(window.location.hash);
  });

  // Navegar al hash actual al cargar
  if (window.location.hash) {
    navigateTo(window.location.hash);
  }
}

// 3. OBTENEDORES DE DATOS DE API
async function loadAllData(retries = 5) {
  showLoader();
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await apiFetch('/api/dashboard');
      if (!response.ok) throw new Error(`Error HTTP ${response.status}`);
      const data = await response.json();

      appState.config = data.config || {};
      appState.documentTypes = (data.config && data.config.documentTypes) || [];
      appState.categories = (data.config && data.config.categories) || [];
      appState.employees = data.employees || [];
      appState.documents = data.documents || [];
      appState.auditLogs = data.auditLogs || [];
      appState.deletionRequests = data.deletionRequests;
      appState.unregisteredFiles = data.unregisteredFiles;
      appState.scannerFiles = data.scannerFiles;
      appState.emails = data.emails;
      appState.stats = data.stats;

      populateDropdown('upload-type', appState.documentTypes);
      populateDropdown('upload-category', appState.categories);
      populateDropdown('edit-type', appState.documentTypes);
      populateDropdown('edit-category', appState.categories);
      populateDropdown('upload-employee', appState.employees, '', '-- Seleccionar Funcionario --', 'id', 'name');
      populateDropdown('edit-employee', appState.employees, '', '-- Seleccionar Funcionario --', 'id', 'name');
      populateDropdown('filter-type', appState.documentTypes, 'todos', '-- Todos los tipos --');
      populateDropdown('filter-category', appState.categories, 'todas', '-- Todas las categorías --');

      badgeUnregistered.textContent = appState.unregisteredFiles.length;
      badgeUnregistered.style.display = appState.unregisteredFiles.length > 0 ? 'inline-block' : 'none';
      statUnregisteredDocs.textContent = appState.unregisteredFiles.length;

      renderStats(data.stats);
      renderUnregisteredFiles();
      break;
    } catch (error) {
      if (error.message && error.message.includes('503') && attempt < retries) {
        showToast('Base de datos conectándose... reintentando.', 'warning');
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      console.error('Error cargando los datos:', error);
      showToast('Error de conexión con el servidor.', 'error');
    }
  }
  hideLoader();
  refreshActiveSectionViews();
}



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

async function fetchStats() {
  const response = await apiFetch('/api/dashboard');
  if (!response.ok) throw new Error(`Error HTTP ${response.status}`);
  const data = await response.json();
  appState.documents = data.documents;
  appState.auditLogs = data.auditLogs;
  appState.deletionRequests = data.deletionRequests;
  appState.unregisteredFiles = data.unregisteredFiles;
  appState.scannerFiles = data.scannerFiles;
  appState.emails = data.emails;
  appState.stats = data.stats;
  renderStats(data.stats);
}

async function fetchEmployees() {
  const response = await apiFetch('/api/employees');
  if (!response.ok) throw new Error(`Error HTTP ${response.status}`);
  appState.employees = await response.json();
  
  // Llenar desplegables del formulario
  populateDropdown('upload-employee', appState.employees, '', '-- Seleccionar Funcionario --', 'id', 'name');
  populateDropdown('edit-employee', appState.employees, '', '-- Seleccionar Funcionario --', 'id', 'name');
}

// fetchDocuments y fetchAuditLogs eliminados (cargados vía loadAllData/dashboard)

async function fetchUnregisteredFiles() {
  const response = await apiFetch('/api/documents/unregistered');
  if (!response.ok) return;
  appState.unregisteredFiles = await response.json();
  
  badgeUnregistered.textContent = appState.unregisteredFiles.length;
  badgeUnregistered.style.display = appState.unregisteredFiles.length > 0 ? 'inline-block' : 'none';
  statUnregisteredDocs.textContent = appState.unregisteredFiles.length;

  renderUnregisteredFiles();
}

// 4. FUNCIONES DE RENDERIZADO

// populateDropdown se define en utils.js

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

// Tabla de funcionarios (sección dedicada)
function renderEmployeesTable() {
  const tbody = document.getElementById('funcionarios-table-body');
  const countEl = document.getElementById('funcionarios-count');
  if (!tbody) return;

  const searchVal = (document.getElementById('emp-search-input')?.value || '').toLowerCase().trim();
  const statusFilter = document.getElementById('emp-filter-status')?.value || 'todos';

  let filtered = appState.employees.filter(emp => {
    if (statusFilter !== 'todos' && (emp.status || (emp.active !== false ? 'activa' : 'inactiva')) !== statusFilter) return false;
    if (searchVal) {
      const match = `${emp.id} ${emp.name} ${emp.department} ${emp.position || ''} ${emp.email}`.toLowerCase();
      if (!match.includes(searchVal)) return false;
    }
    return true;
  });

  if (countEl) countEl.textContent = filtered.length + ' funcionarios';

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-muted);">No se encontraron funcionarios.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(emp => {
    const status = emp.status || (emp.active !== false ? 'activa' : 'inactiva');
    let statusBadge = '';
    switch (status) {
      case 'activa': statusBadge = '<span style="font-size:11px;font-weight:600;color:#1B5E20;background:#C8E6C9;border-radius:10px;padding:2px 8px;">Activo</span>'; break;
      case 'pendiente': statusBadge = '<span style="font-size:11px;font-weight:600;color:#E65100;background:#FFE0B2;border-radius:10px;padding:2px 8px;">Pendiente</span>'; break;
      case 'suspendida': statusBadge = '<span style="font-size:11px;font-weight:600;color:#B71C1C;background:#FFCDD2;border-radius:10px;padding:2px 8px;">Suspendido</span>'; break;
      default: statusBadge = '<span style="font-size:11px;font-weight:600;color:#555;background:#E0E0E0;border-radius:10px;padding:2px 8px;">Inactivo</span>';
    }

    const isActive = status === 'activa';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight:500;">${sanitize(emp.id)}</td>
      <td><strong>${sanitize(emp.name)}</strong></td>
      <td>${sanitize(emp.department)}</td>
      <td>${sanitize(emp.position || 'Funcionario')}</td>
      <td style="font-size:12px;color:var(--text-muted);">${sanitize(emp.email)}</td>
      <td>${statusBadge}</td>
      <td class="text-right" style="white-space:nowrap;">
        <button class="btn btn-text btn-sm" onclick="window.location.hash='#expedientes';setTimeout(()=>selectEmployeeForFolder('${escOnclick(emp.id)}'),100)" title="Ver expediente">Expediente</button>
        ${status !== 'pendiente' ? `<button class="btn btn-text btn-sm" style="color:${isActive ? 'var(--danger)' : 'var(--success)'};" onclick="toggleEmployeeStatus('${escOnclick(emp.id)}')">${isActive ? 'Desactivar' : 'Activar'}</button>` : ''}
        <button class="btn btn-danger-text btn-sm" onclick="deleteEmployee('${escOnclick(emp.id)}','${escOnclick(emp.name)}')" title="Eliminar funcionario">Eliminar</button>
      </td>
    `;
    tbody.appendChild(tr);
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

// Tabla de consulta de documentos
function renderDocumentsTable() {
  const tbody = document.getElementById('documents-table-body');
  const resultsCount = document.getElementById('results-count');
  if (!tbody) return;

  const searchQuery = document.getElementById('search-input').value.toLowerCase();
  const typeFilter = document.getElementById('filter-type').value;
  const catFilter = document.getElementById('filter-category').value;
  const statusFilter = document.getElementById('filter-status').value;
  const dateStart = document.getElementById('filter-date-start').value;
  const dateEnd = document.getElementById('filter-date-end').value;

  // Filtrar documentos por estado
  const filtered = appState.documents.filter(doc => {
    // 1. Text Search matches filename, employeeId, employeeName, or description
    const textMatch = !searchQuery || 
                      (doc.filename || '').toLowerCase().includes(searchQuery) ||
                      (doc.employeeId || '').toLowerCase().includes(searchQuery) ||
                      (doc.employeeName || '').toLowerCase().includes(searchQuery) ||
                      (doc.description || '').toLowerCase().includes(searchQuery);

    // 2. Type filter
    const typeMatch = typeFilter === 'todos' || doc.documentTypeId === typeFilter;

    // 3. Category filter
    const catMatch = catFilter === 'todas' || doc.categoryId === catFilter;

    // 4. Status filter
    const statusMatch = statusFilter === 'todos' || doc.status === statusFilter;

    // 5. Date filter
    let dateMatch = true;
    if (dateStart && doc.issueDate < dateStart) dateMatch = false;
    if (dateEnd && doc.issueDate > dateEnd) dateMatch = false;

    return textMatch && typeMatch && catMatch && statusMatch && dateMatch;
  });

  // Ordenar: mostrar registros más recientes primero
  filtered.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));

  tbody.innerHTML = '';
  resultsCount.textContent = `${filtered.length} documento${filtered.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center" style="text-align: center; padding: 40px; color: var(--text-muted); font-style: italic;">
          Ningún documento coincide con los criterios de búsqueda.
        </td>
      </tr>
    `;
    return;
  }

  filtered.forEach(doc => {
    const tr = document.createElement('tr');
    
    // Mapeo de iconos
    const fileIcon = `
      <svg class="file-icon-pdf" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    `;

    // Nombre del tipo
    const typeObj = appState.documentTypes.find(t => t.id === doc.documentTypeId);
    const categoryObj = appState.categories.find(c => c.id === doc.categoryId);
    const typeLabel = typeObj ? typeObj.name : doc.documentTypeId;
    const catLabel = categoryObj ? categoryObj.name : doc.categoryId;

    const sizeKB = doc.fileSize ? Math.round(doc.fileSize / 1024) : '—';

    tr.innerHTML = `
      <td>
        <div class="filename-cell-content">
          ${fileIcon}
          <div>
            <span class="filename-primary">${sanitize(doc.filename)}</span>
            <span class="filename-secondary">${sizeKB} KB &bull; Subido el ${new Date(doc.registeredAt).toLocaleDateString()}</span>
          </div>
        </div>
      </td>
      <td>
        <strong>${sanitize(doc.employeeName)}</strong>
        <div style="font-size: 11px; color: var(--text-muted)">C.C. ${sanitize(doc.employeeId)}</div>
      </td>
      <td>
        <span class="category-tag">${sanitize(catLabel)}</span>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">${sanitize(typeLabel)}</div>
      </td>
      <td>${sanitize(doc.issueDate)}</td>
      <td>
        <span class="badge-status ${(doc.status || '').toLowerCase()}">${sanitize(doc.status)}</span>
        ${doc.visibleToEmployee ? '<span title="Visible al funcionario" style="margin-left:4px;font-size:13px;">👁</span>' : ''}
      </td>
      <td class="text-right">
        <div class="action-buttons-cell">
          <button class="btn btn-secondary btn-icon-only" onclick="openPdfModal('${escOnclick(doc.filename)}', 'documents', '${escOnclick(doc.id)}')" title="Ver Documento">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button class="btn btn-secondary btn-icon-only" onclick="openEditDocModal('${escOnclick(doc.id)}')" title="Editar Metadatos">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
          <button class="btn btn-danger-text btn-icon-only" onclick="archiveDocument('${escOnclick(doc.id)}')" title="Archivar / Borrar">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 8h14M10 9v8m4-8v8m1 8H9a2 2 0 01-2-2V8h10v10a2 2 0 01-2 2zM9 5h6a1 1 0 011 1v2H8V6a1 1 0 011-1z" />
            </svg>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// Lista de archivos locales sin registrar
function renderUnregisteredFiles() {
  const container = document.getElementById('unregistered-files-list');
  if (!container) return;

  if (appState.unregisteredFiles.length === 0) {
    container.innerHTML = `
      <div class="no-data-placeholder" style="height: 120px;">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 8px;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        Todos los archivos locales están registrados.
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  appState.unregisteredFiles.forEach(file => {
    const sizeKB = file.fileSize ? Math.round(file.fileSize / 1024) : '—';
    
    const div = document.createElement('div');
    div.className = 'local-file-item';
    div.innerHTML = `
      <div class="local-file-info">
        <svg class="file-icon-pdf" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
        <div class="local-file-details">
          <h5 title="${sanitize(file.filename)}">${sanitize(file.filename)}</h5>
          <span>${sizeKB} KB &bull; PDF local</span>
        </div>
      </div>
      <button class="btn btn-secondary btn-icon-only" onclick="openRegisterLocalModal('${escOnclick(file.filename)}')" title="Registrar metadatos">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
    `;
    container.appendChild(div);
  });
}

// Lista directorio de empleados
function renderEmployeeDirectory() {
  const container = document.getElementById('employees-cards-list');
  if (!container) return;

  const filterText = document.getElementById('employee-search').value.toLowerCase();
  const filterType = document.getElementById('employee-filter-type') ? document.getElementById('employee-filter-type').value : 'todos';
  const filtered = appState.employees.filter(emp => {
    const matchesText = (emp.name || '').toLowerCase().includes(filterText) ||
           (emp.id || '').includes(filterText) ||
           (emp.department || '').toLowerCase().includes(filterText);
    if (!matchesText) return false;
    if (filterType === 'auto-registro') return emp.registeredBy === 'Auto-Registro';
    if (filterType === 'admin') return emp.registeredBy !== 'Auto-Registro';
    if (filterType === 'activos') return emp.active !== false && emp.status !== 'pendiente';
    if (filterType === 'inactivos') return emp.active === false || emp.status === 'inactiva';
    if (filterType === 'pendientes') return emp.status === 'pendiente';
    if (filterType === 'suspendidos') return emp.status === 'suspendida';
    if (filterType === 'bloqueados') return emp.status === 'bloqueada';
    return true;
  });

  container.innerHTML = '';
  
  if (filtered.length === 0) {
    container.innerHTML = '<div class="no-data-placeholder" style="height: 120px;">No se encontraron funcionarios.</div>';
    return;
  }

  filtered.forEach(emp => {
    const isActive = appState.selectedEmployeeId === emp.id;
    const initials = getInitials(emp.name);
    const isInactive = emp.active === false || emp.status === 'inactiva';
    const isPending = emp.status === 'pendiente';
    const isSuspended = emp.status === 'suspendida';
    const isBlocked = emp.status === 'bloqueada';
    
    // Contar todos los documentos de este empleado (incluye archivados)
    const docCount = appState.documents.filter(d => d.employeeId === emp.id).length;

    const isAutoRegistered = emp.registeredBy === 'Auto-Registro';
    const regDate = emp.registeredAt ? new Date(emp.registeredAt).toLocaleDateString('es-CO') : '';

    const div = document.createElement('div');
    div.className = `employee-mini-card ${isActive ? 'active' : ''} ${isInactive ? 'inactive' : ''}`;
    div.onclick = () => selectEmployeeForFolder(emp.id);
    div.style.opacity = isInactive ? '0.55' : '1';
    div.innerHTML = `
      <div class="emp-avatar-sm" style="${isAutoRegistered ? 'background: linear-gradient(135deg, #1A5276, #2E86C1); color: white;' : ''}">${initials}</div>
      <div class="emp-info-sm" style="flex: 1;">
        <h4 style="${isInactive ? 'text-decoration: line-through; color: var(--text-muted);' : ''}">${sanitize(emp.name)}</h4>
        <p>C.C. ${sanitize(emp.id)} &bull; ${sanitize(emp.department)}</p>
        ${emp.position ? `<p style="font-size:11px;color:var(--text-muted);margin-top:2px;">${sanitize(emp.position)}</p>` : ''}
        ${emp.email ? `<p style="font-size:11px;color:${isInactive ? 'var(--text-muted)' : 'var(--primary)'};margin-top:1px;">${sanitize(emp.email)}</p>` : ''}
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;">
          ${isPending ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#7D6608;background:#FEF9E7;border:1px solid #F9E79F;border-radius:20px;padding:2px 8px;">⏳ Pendiente</span>' : ''}
          ${isSuspended ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#922B21;background:#FADBD8;border:1px solid #F5B7B1;border-radius:20px;padding:2px 8px;">⊘ Suspendido</span>' : ''}
          ${isBlocked ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#4A235A;background:#E8DAEF;border:1px solid #D2B4DE;border-radius:20px;padding:2px 8px;">🔒 Bloqueado</span>' : ''}
          ${isInactive && !isPending && !isSuspended && !isBlocked ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#922B21;background:#FADBD8;border:1px solid #F5B7B1;border-radius:20px;padding:2px 8px;">✕ Inactivo</span>' : ''}
          ${!isInactive && !isPending && !isSuspended && !isBlocked ? '<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:700;color:#1E8449;background:#D5F5E3;border:1px solid #82E0AA;border-radius:20px;padding:2px 8px;">✓ Activo</span>' : ''}
          ${regDate ? `<span style="font-size:10px;color:var(--text-muted);">${regDate}</span>` : ''}
        </div>
      </div>
      <span class="count-badge" style="background-color: ${isActive ? 'rgba(255,255,255,0.2)' : 'var(--background)'}; color: ${isActive ? 'white' : 'var(--text-primary)'}; font-size: 11px;">
        ${docCount} doc${docCount === 1 ? '' : 's'}
      </span>
    `;
    container.appendChild(div);
  });

  // Mantener contenido del expediente si hay empleado seleccionado
  renderEmployeeDossier();

  // Actualizar conteo
  const countEl = document.getElementById('employee-directory-count');
  if (countEl) {
    const statusCounts = {
      activos: appState.employees.filter(e => e.status === 'activa').length,
      pendientes: appState.employees.filter(e => e.status === 'pendiente').length,
      inactivos: appState.employees.filter(e => e.status === 'inactiva' || e.active === false).length
    };
    countEl.textContent = `${filtered.length} de ${appState.employees.length} | ✓ ${statusCounts.activos} activos | ⏳ ${statusCounts.pendientes} pendientes | ✕ ${statusCounts.inactivos} inactivos`;
  }
}

// Seleccionar perfil del empleado para inspeccionar expediente
function selectEmployeeForFolder(employeeId) {
  appState.selectedEmployeeId = employeeId;
  appState.currentFolderCategory = 'todos'; // reset category filter inside folder
  renderEmployeeDirectory(); // will redraw list with active class and render dossier
}

// Renderizar detalles del expediente
function renderEmployeeDossier() {
  const blankState = document.getElementById('folder-blank-state');
  const realContent = document.getElementById('folder-real-content');
  if (!blankState || !realContent) return;

  if (!appState.selectedEmployeeId) {
    blankState.style.display = 'flex';
    realContent.style.display = 'none';
    return;
  }

  blankState.style.display = 'none';
  realContent.style.display = 'block';

  const employee = appState.employees.find(e => e.id === appState.selectedEmployeeId);
  if (!employee) return;

  // Establecer detalles del encabezado
  document.getElementById('folder-emp-name').textContent = employee.name;
  document.getElementById('folder-emp-id').textContent = `C.C. ${employee.id}`;
  document.getElementById('folder-emp-pos').textContent = employee.position;
  document.getElementById('folder-emp-dep').textContent = employee.department;
  document.getElementById('folder-emp-email').textContent = employee.email || 'Sin correo registrado';
  
  const initials = getInitials(employee.name);
  document.getElementById('folder-emp-avatar').textContent = initials;

  // Agregar insignia de info de registro al encabezado del expediente
  const existingRegBadge = document.getElementById('folder-emp-reg-badge');
  if (existingRegBadge) existingRegBadge.remove();

  const badgeInfo = document.querySelector('.badge-info');
  if (badgeInfo) {
    const isAutoRegistered = employee.registeredBy === 'Auto-Registro';
    const regDate = employee.registeredAt ? new Date(employee.registeredAt).toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const badge = document.createElement('div');
    badge.id = 'folder-emp-reg-badge';
    badge.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap;';
    badge.innerHTML = `
      ${isAutoRegistered
        ? '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#1A5276;background:#D4E6F1;border:1px solid #AED6F1;border-radius:20px;padding:3px 10px;">✓ Auto-Registrado</span>'
        : '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;color:#1E8449;background:#D5F5E3;border:1px solid #82E0AA;border-radius:20px;padding:3px 10px;">✓ Creado por Admin</span>'}
      ${regDate ? `<span style="font-size:11px;color:var(--text-muted);">Registrado el ${regDate}</span>` : ''}
    `;
    badgeInfo.appendChild(badge);
  }

  // Documentos del empleado (incluye archivados; el conteo por categoría y
  // el badge de la carpeta se mantienen consistentes con este criterio)
  const empDocs = appState.documents.filter(d => d.employeeId === employee.id);

  // Agrupar por conteo de categorías
  const categoryCounts = { todos: empDocs.length };
  appState.categories.forEach(c => {
    categoryCounts[c.id] = empDocs.filter(d => d.categoryId === c.id).length;
  });

  // Renderizar sub-navegación de categorías
  const catNav = document.getElementById('folder-categories-nav-list');
  catNav.innerHTML = '';

  // "Todos" item
  const allItem = document.createElement('div');
  allItem.className = `folder-cat-item ${appState.currentFolderCategory === 'todos' ? 'active' : ''}`;
  allItem.onclick = () => setFolderCategory('todos');
  allItem.innerHTML = `Todos <span class="dot-count">${categoryCounts.todos}</span>`;
  catNav.appendChild(allItem);

  appState.categories.forEach(c => {
    if (categoryCounts[c.id] > 0 || appState.currentFolderCategory === c.id) {
      const catItem = document.createElement('div');
      catItem.className = `folder-cat-item ${appState.currentFolderCategory === c.id ? 'active' : ''}`;
      catItem.onclick = () => setFolderCategory(c.id);
      catItem.innerHTML = `${sanitize(c.name)} <span class="dot-count">${categoryCounts[c.id]}</span>`;
      catNav.appendChild(catItem);
    }
  });

  // Filtrar documentos por subcategoría dentro del expediente
  const displayedDocs = appState.currentFolderCategory === 'todos' 
    ? empDocs 
    : empDocs.filter(d => d.categoryId === appState.currentFolderCategory);

  // Establecer título y conteos
  const currentCatName = appState.currentFolderCategory === 'todos' 
    ? 'Todos los Documentos' 
    : (appState.categories.find(c => c.id === appState.currentFolderCategory) || {}).name || 'Categoría desconocida';
  
  document.getElementById('folder-current-category-title').textContent = currentCatName;
  document.getElementById('folder-category-docs-count').textContent = displayedDocs.length;

  // Renderizar tarjetas de documentos en cuadrícula
  const grid = document.getElementById('folder-documents-grid');
  grid.innerHTML = '';

  if (displayedDocs.length === 0) {
    grid.innerHTML = '<div class="no-data-placeholder" style="grid-column: 1/-1;">No hay documentos en esta categoría.</div>';
    return;
  }

  displayedDocs.forEach(doc => {
    const card = document.createElement('div');
    card.className = 'folder-doc-card';
    
    const typeName = appState.documentTypes.find(t => t.id === doc.documentTypeId)?.name || doc.documentTypeId;
    const dateFormatted = formatIssueDate(doc.issueDate);

    card.innerHTML = `
      <div class="folder-doc-meta" onclick="openPdfModal('${escOnclick(doc.filename)}', 'documents', '${escOnclick(doc.id)}')" style="cursor: pointer;">
        <svg class="file-icon-pdf" viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 8px;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
        <h5 title="${sanitize(doc.filename)}">${sanitize(doc.filename)}</h5>
        <span style="font-weight: 500; color: var(--text-secondary); margin-top: 4px;">${sanitize(typeName)}</span>
        <span>Emisión: ${dateFormatted}</span>
      </div>
      <div class="folder-doc-card-footer">
        <span class="badge-status ${(doc.status || '').toLowerCase()}" style="padding: 2px 6px; font-size: 9px;">${sanitize(doc.status)}</span>
        ${doc.visibleToEmployee ? '<span title="Visible al funcionario" style="font-size:12px;cursor:default;">👁</span>' : ''}
        <div style="display: flex; gap: 4px;">
          <button class="btn btn-secondary btn-icon-only" style="width: 28px; height: 28px;" onclick="openPdfModal('${escOnclick(doc.filename)}', 'documents', '${escOnclick(doc.id)}')" title="Abrir y verificar">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          <button class="btn btn-secondary btn-icon-only" style="width: 28px; height: 28px;" onclick="openEditDocModal('${escOnclick(doc.id)}')" title="Editar metadatos">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
            </svg>
          </button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function setFolderCategory(catId) {
  appState.currentFolderCategory = catId;
  renderEmployeeDossier();
}

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
    
    const dateFormatted = new Date(log.timestamp).toLocaleString();

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
    const date = new Date(req.createdAt).toLocaleString('es-CO');
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

// 5. LÓGICA DE MODALES (ABRIR Y CERRAR)

// MODAL DE VISUALIZACIÓN PDF
window.openPdfModal = function(filename, folder = 'documents', docId) {
  let doc = null;
  const iframe = document.getElementById('pdf-iframe');
  const ext = (filename || '').split('.').pop().toLowerCase();
  const viewableTypes = ['pdf','jpg','jpeg','png','gif','bmp','tiff','tif','txt'];
  const canViewInline = viewableTypes.includes(ext);
  
  // Restablecer estado de botones deshabilitados
  document.getElementById('btn-update-pdf-status').disabled = false;
  document.getElementById('btn-archive-pdf-direct').disabled = false;

  document.getElementById('btn-toggle-visibility').style.display = 'none';

  function setIframeSrc(url) {
    if (canViewInline) {
      iframe.style.display = 'block';
      iframe.src = url;
    } else {
      iframe.style.display = 'none';
      const viewerFrame = iframe.parentElement;
      let downloadMsg = viewerFrame.querySelector('.download-fallback-msg');
      if (!downloadMsg) {
        downloadMsg = document.createElement('div');
        downloadMsg.className = 'download-fallback-msg';
        downloadMsg.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;text-align:center;color:var(--text-secondary);padding:40px;';
        viewerFrame.appendChild(downloadMsg);
      }
      downloadMsg.style.display = 'flex';
      downloadMsg.innerHTML = `
        <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
        </svg>
        <h3 style="margin:0;color:var(--text-primary);"></h3>
        <p style="margin:0;font-size:13px;">Este tipo de archivo no se puede previsualizar en el navegador.</p>
        <a href="" download="" class="btn btn-primary" style="text-decoration:none;padding:10px 24px;">
          Descargar archivo
        </a>
      `;
      downloadMsg.querySelector('h3').textContent = filename;
      downloadMsg.querySelector('a').href = url;
      downloadMsg.querySelector('a').download = filename;
    }
  }

  function hideDownloadFallback() {
    const viewerFrame = iframe.parentElement;
    const downloadMsg = viewerFrame.querySelector('.download-fallback-msg');
    if (downloadMsg) downloadMsg.style.display = 'none';
    iframe.style.display = 'block';
  }

  if (folder === 'scanner') {
    // Mostrar vista previa de metadatos del archivo escaneado
    document.getElementById('pdf-modal-title').textContent = filename;
    document.getElementById('pdf-detail-employee').textContent = 'Documento no registrado';
    document.getElementById('pdf-detail-employee-id').textContent = 'Escáner local (bandeja_escaner/)';
    document.getElementById('pdf-detail-type').textContent = 'Archivo Digital Escaneado';
    document.getElementById('pdf-detail-category').textContent = 'Pendiente';
    document.getElementById('pdf-detail-issue-date').textContent = new Date().toLocaleDateString();
    document.getElementById('pdf-detail-expiry-date').textContent = 'Indefinido';
    document.getElementById('pdf-detail-desc').textContent = 'Este archivo se encuentra en la bandeja de entrada del escáner. Regístrelo para asignarlo a un funcionario y clasificarlo.';
    
    document.getElementById('pdf-status-changer').value = 'Pendiente';
    document.getElementById('btn-update-pdf-status').disabled = true;
    document.getElementById('btn-archive-pdf-direct').disabled = true;
    
    hideDownloadFallback();
    setIframeSrc(`/api/document-file/${encodeURIComponent(filename)}?folder=scanner`);
  } else if (folder === 'email') {
    // Mostrar vista previa de metadatos del adjunto de correo
    document.getElementById('pdf-modal-title').textContent = filename;
    document.getElementById('pdf-detail-employee').textContent = 'Documento no registrado';
    document.getElementById('pdf-detail-employee-id').textContent = 'Adjunto de Correo Electrónico';
    document.getElementById('pdf-detail-type').textContent = 'Archivo Adjunto';
    document.getElementById('pdf-detail-category').textContent = 'Pendiente';
    document.getElementById('pdf-detail-issue-date').textContent = new Date().toLocaleDateString();
    document.getElementById('pdf-detail-expiry-date').textContent = 'Indefinido';
    document.getElementById('pdf-detail-desc').textContent = 'Este archivo es un adjunto de correo recibido. Regístrelo para asignarlo a un funcionario y clasificarlo.';
    
    document.getElementById('pdf-status-changer').value = 'Pendiente';
    document.getElementById('btn-update-pdf-status').disabled = true;
    document.getElementById('btn-archive-pdf-direct').disabled = true;
    
    hideDownloadFallback();
    setIframeSrc(`/api/document-file/${encodeURIComponent(filename)}?folder=gmail`);
  } else {
    // Por defecto: documentos registrados
    doc = docId
      ? appState.documents.find(d => d.id === docId)
      : appState.documents.find(d => d.filename === filename);
    if (!doc) {
      showToast('Metadatos de documento no encontrados.', 'error');
      return;
    }

    document.getElementById('pdf-modal-title').textContent = doc.filename;
    document.getElementById('pdf-detail-employee').textContent = doc.employeeName;
    document.getElementById('pdf-detail-employee-id').textContent = `C.C. ${doc.employeeId}`;
    
    const typeName = appState.documentTypes.find(t => t.id === doc.documentTypeId)?.name || doc.documentTypeId;
    const categoryName = appState.categories.find(c => c.id === doc.categoryId)?.name || doc.categoryId;
    
    document.getElementById('pdf-detail-type').textContent = typeName;
    document.getElementById('pdf-detail-category').textContent = categoryName;
    document.getElementById('pdf-detail-issue-date').textContent = formatIssueDate(doc.issueDate);
    document.getElementById('pdf-detail-expiry-date').textContent = doc.expiryDate ? formatIssueDate(doc.expiryDate) : 'No vence';
    document.getElementById('pdf-detail-desc').textContent = doc.description || 'Sin descripción o comentarios.';
    
    document.getElementById('pdf-status-changer').value = doc.status;
    
    document.getElementById('btn-update-pdf-status').onclick = () => updateDocumentStatus(doc.id, document.getElementById('pdf-status-changer').value);
    document.getElementById('btn-archive-pdf-direct').onclick = () => {
      if (confirm(`¿Está seguro de que desea archivar el documento '${doc.filename}'?`)) {
        archiveDocument(doc.id);
        closeModal(modalViewPdf);
      }
    };

    // Alternador de visibilidad
    const btnVis = document.getElementById('btn-toggle-visibility');
    btnVis.style.display = 'block';
    btnVis.textContent = doc.visibleToEmployee
      ? '🙈 Ocultar al funcionario'
      : '👁 Permitir que funcionario vea este doc';
    btnVis.onclick = () => toggleDocVisibility(doc.id);

    hideDownloadFallback();
    setIframeSrc(`/api/document-file/${encodeURIComponent(filename)}`);
  }

  // Disparador de descarga común
  document.getElementById('btn-download-pdf-direct').onclick = async () => {
    let downloadUrl = `/api/document-file/${encodeURIComponent(filename)}`;
    if (folder === 'scanner') downloadUrl += '?folder=scanner';
    if (folder === 'email') downloadUrl += '?folder=gmail';
    try {
      const res = await apiFetch(downloadUrl);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      showToast('Error al descargar el archivo.', 'error');
    }
  };

  openModal(modalViewPdf);
};

// MODAL DE EDICIÓN DE METADATOS (Para documentos existentes)
window.openEditDocModal = function(docId) {
  const doc = appState.documents.find(d => d.id === docId);
  if (!doc) return;

  document.getElementById('edit-modal-title').textContent = 'Editar Metadatos de Expediente';
  document.getElementById('edit-doc-id').value = doc.id;
  document.getElementById('edit-doc-filename').value = doc.filename;
  document.getElementById('edit-doc-filename-display').textContent = doc.filename;
  document.getElementById('edit-employee').value = doc.employeeId;
  document.getElementById('edit-category').value = doc.categoryId;
  document.getElementById('edit-type').value = doc.documentTypeId;
  document.getElementById('edit-issue-date').value = doc.issueDate;
  document.getElementById('edit-expiry-date').value = doc.expiryDate || '';
  document.getElementById('edit-status').value = doc.status;
  document.getElementById('edit-description').value = doc.description || '';
  
  document.getElementById('edit-mode-local').value = 'false'; // Modo de edición estándar

  openModal(modalEditDoc);
};

// MODAL DE REGISTRO UNIFICADO (local, scanner, email)
function openRegisterModal(filename, options = {}) {
  const mode = options.mode || 'local';
  const emailId = options.emailId || '';
  const suggestedEmployeeId = options.suggestedEmployeeId || '';
  const titles = { local: 'Registrar Documento Existente', scanner: 'Registrar Documento Escaneado', email: 'Registrar Adjunto de Correo Electrónico' };
  const defaultStatuses = { local: 'Aprobado', scanner: 'Pendiente', email: 'Pendiente' };

  document.getElementById('edit-modal-title').textContent = titles[mode] || 'Registrar Documento';
  document.getElementById('edit-doc-id').value = '';
  document.getElementById('edit-doc-filename').value = filename;
  document.getElementById('edit-doc-filename-display').textContent = filename;
  document.getElementById('edit-employee').value = suggestedEmployeeId;
  document.getElementById('edit-category').value = '';
  document.getElementById('edit-type').value = '';
  document.getElementById('edit-issue-date').value = new Date().toISOString().substring(0, 10);
  document.getElementById('edit-expiry-date').value = '';
  document.getElementById('edit-status').value = defaultStatuses[mode] || 'Pendiente';
  document.getElementById('edit-description').value = '';
  document.getElementById('edit-mode-local').value = mode;
  document.getElementById('edit-email-id').value = emailId;
  openModal(modalEditDoc);
}

// Mantener nombres anteriores para compatibilidad
window.openRegisterLocalModal = function(filename) { openRegisterModal(filename, { mode: 'local' }); };
window.openRegisterScannerModal = function(filename) { openRegisterModal(filename, { mode: 'scanner' }); };
window.openRegisterEmailModal = function(filename, emailId) {
  const email = appState.emails?.find(e => e.id === emailId);
  openRegisterModal(filename, { mode: 'email', emailId, suggestedEmployeeId: email?.suggestedEmployeeId || '' });
};

// openModal y closeModal se definen en utils.js

// 6. ENVÍOS DE FORMULARIO Y ACCIONES

// Formulario de crear empleado
guardSubmit(document.getElementById('form-add-employee'), async (e) => {
  const email = document.getElementById('emp-email').value.trim();
  const department = document.getElementById('emp-department').value.trim();
  const emailPrefix = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
  const id = emailPrefix + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  const name = emailPrefix.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim() || emailPrefix;
  const position = 'Funcionario';

  if (!email || !department) {
    showToast('El correo y la dependencia son obligatorios.', 'error');
    return;
  }

  try {
    const response = await apiFetch('/api/employees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name, department, position, email })
    });

    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'No se pudo crear el funcionario.', 'error');
      return;
    }

    const emailInfo = data.emailSent ? ' Se enviaron las credenciales al correo del funcionario.' : '';
    showToast(`Funcionario ${name} creado. Debe iniciar sesión para activar su cuenta.${emailInfo}`, 'success');
    closeModal(modalAddEmp);
    e.target.reset();
    
    await fetchEmployees();
    await fetchStats();
    
    refreshActiveSectionViews();
  } catch (error) {
    console.error(error);
    showToast('Error de red al crear funcionario.', 'error');
  }
});

// Formulario de editar metadatos
guardSubmit(document.getElementById('form-edit-document'), async (e) => {
  const id = document.getElementById('edit-doc-id').value;
  const filename = document.getElementById('edit-doc-filename').value;
  const registerMode = document.getElementById('edit-mode-local').value; // 'true'/'local', 'scanner', 'email', or 'false'/'edit'

  const payload = {
    filename,
    employeeId: document.getElementById('edit-employee').value,
    categoryId: document.getElementById('edit-category').value,
    documentTypeId: document.getElementById('edit-type').value,
    issueDate: document.getElementById('edit-issue-date').value,
    expiryDate: document.getElementById('edit-expiry-date').value,
    status: document.getElementById('edit-status').value,
    description: document.getElementById('edit-description').value
  };

  try {
    let url = `/api/documents/${id}`;
    let method = 'PUT';
    let successMessage = 'Metadatos actualizados con éxito.';

    if (registerMode === 'local') {
      url = '/api/documents/register-local';
      method = 'POST';
      successMessage = 'Archivo local vinculado con éxito.';
    } else if (registerMode === 'scanner') {
      url = '/api/documents/register-scanner';
      method = 'POST';
      successMessage = 'Documento escaneado vinculado con éxito.';
    } else if (registerMode === 'email') {
      url = '/api/documents/register-email-attachment';
      method = 'POST';
      payload.emailId = document.getElementById('edit-email-id').value;
      successMessage = 'Documento adjunto de correo vinculado con éxito.';
    }

    const response = await apiFetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'Ocurrió un error al guardar.', 'error');
      return;
    }

    showToast(successMessage, 'success');
    closeModal(modalEditDoc);
    await reloadAll();
  } catch (error) {
    console.error(error);
    showToast('Error al enviar formulario.', 'error');
  }
});

// Formulario de subir documento
let submittingUpload = false;
document.getElementById('form-upload-document').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submittingUpload) return;
  submittingUpload = true;
  
  const fileInput = document.getElementById('upload-file');
  if (!fileInput.files || fileInput.files.length === 0) {
    showToast('Por favor seleccione un archivo.', 'warning');
    submittingUpload = false;
    return;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('employeeId', document.getElementById('upload-employee').value);
  formData.append('categoryId', document.getElementById('upload-category').value);
  formData.append('documentTypeId', document.getElementById('upload-type').value);
  formData.append('status', document.getElementById('upload-status').value);
  formData.append('issueDate', document.getElementById('upload-issue-date').value);
  formData.append('expiryDate', document.getElementById('upload-expiry-date').value);
  formData.append('description', document.getElementById('upload-description').value);

  showLoader();
  try {
    const response = await apiFetch('/api/documents/upload', {
      method: 'POST',
      body: formData
    });

    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'Error al digitalizar documento.', 'error');
      return;
    }

    showToast('Documento digitalizado y guardado con éxito.', 'success');
    e.target.reset();
    document.getElementById('file-name-preview').textContent = 'Ningún archivo seleccionado';
    await reloadAll();
  } catch (error) {
    console.error(error);
    showToast('Error de red al subir documento.', 'error');
  } finally {
    hideLoader();
    submittingUpload = false;
  }
});

// Actualizar estado del documento (actualización inline desde barra lateral del visor PDF)
async function updateDocumentStatus(docId, newStatus) {
  const btn = event && event.currentTarget;
  if (btn && btn.dataset.busy === '1') return;
  if (btn) btn.dataset.busy = '1';
  try {
    const response = await apiFetch(`/api/documents/${docId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });

    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'No se pudo actualizar el estado.', 'error');
      return;
    }

    showToast(`Estado del documento actualizado a '${newStatus}'`, 'success');
    await reloadAll();
  } catch (error) {
    console.error(error);
    showToast('Error al actualizar el estado.', 'error');
  } finally {
    if (btn) delete btn.dataset.busy;
  }
}

// Alternar visibilidad del documento para portal del funcionario
async function toggleDocVisibility(docId) {
  const btn = event && event.currentTarget;
  if (btn && btn.dataset.busy === '1') return;
  if (btn) btn.dataset.busy = '1';
  try {
    const response = await apiFetch(`/api/documents/${docId}/visibilidad`, { method: 'PATCH' });
    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'No se pudo cambiar la visibilidad.', 'error');
      return;
    }
    const isVisible = data.visibleToEmployee;
    showToast(isVisible ? 'Documento visible para el funcionario.' : 'Documento oculto al funcionario.', 'success');
    document.getElementById('btn-toggle-visibility').textContent = isVisible
      ? '🙈 Ocultar al funcionario'
      : '👁 Permitir que funcionario vea este doc';

    // Actualizar estado local
    const docIdx = appState.documents.findIndex(d => d.id === docId);
    if (docIdx !== -1) appState.documents[docIdx].visibleToEmployee = isVisible;
    refreshActiveSectionViews();
  } catch (error) {
    showToast('Error al cambiar visibilidad.', 'error');
  } finally {
    if (btn) delete btn.dataset.busy;
  }
}

// Archivar documento (eliminación suave)
window.archiveDocument = async function(docId) {
  try {
    const response = await apiFetch(`/api/documents/${docId}`, {
      method: 'DELETE'
    });

    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'No se pudo archivar el documento.', 'error');
      return;
    }

    showToast('El documento se ha archivado exitosamente.', 'success');
    await reloadAll();
  } catch (error) {
    console.error(error);
    showToast('Error al archivar el documento.', 'error');
  }
};

// Eliminar empleado (borrado permanente de la BD)
window.deleteEmployee = async function(empId, empName) {
  if (!confirm(`¿Está seguro de eliminar PERMANENTEMENTE al funcionario "${empName}"? Esta acción no se puede deshacer.`)) return;

  try {
    const response = await apiFetch(`/api/employees/${empId}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'No se pudo eliminar el funcionario.', 'error');
      return;
    }
    showToast(`Funcionario "${empName}" eliminado permanentemente.`, 'info');
    await fetchEmployees();
    await fetchStats();
    if (appState.selectedEmployeeId === empId) {
      appState.selectedEmployeeId = null;
    }
    refreshActiveSectionViews();
  } catch (error) {
    console.error(error);
    showToast('Error al eliminar el funcionario.', 'error');
  }
};

window.toggleEmployeeActive = async function(empId, empName, isCurrentlyInactive) {
  const actionLabel = isCurrentlyInactive ? 'activar' : 'desactivar';
  const hint = isCurrentlyInactive
    ? ' Podrá iniciar sesión nuevamente.'
    : ' Podrá reactivarlo después desde este mismo botón.';
  if (!confirm(`¿Está seguro de ${actionLabel} al funcionario "${empName}"?${hint}`)) return;

  try {
    const response = await apiFetch(`/api/employees/${empId}/toggle-active`, { method: 'PATCH' });
    const data = await response.json();
    if (!response.ok) {
      showToast(data.error || 'No se pudo cambiar el estado.', 'error');
      return;
    }
    showToast(data.message, 'success');
    await fetchEmployees();
    refreshActiveSectionViews();
  } catch (error) {
    console.error(error);
    showToast('Error al cambiar el estado del funcionario.', 'error');
  }
};

// Helper para toggle desde la tabla de funcionarios
window.toggleEmployeeStatus = function(empId) {
  const emp = appState.employees.find(e => e.id === empId);
  if (!emp) return;
  window.toggleEmployeeActive(empId, emp.name, emp.active === false || emp.status === 'inactiva');
};

// 7. ESCUCHADORES DE EVENTOS Y HELPERS

function setupEventListeners() {
  // Botón de actualizar
  document.getElementById('btn-refresh-data').addEventListener('click', () => {
    loadAllData();
  });

  // Disparadores de modal de nuevo empleado
  document.getElementById('btn-add-employee-trigger').addEventListener('click', () => openModal(modalAddEmp));
  document.getElementById('btn-close-emp-modal').addEventListener('click', () => closeModal(modalAddEmp));
  document.getElementById('btn-cancel-emp').addEventListener('click', () => closeModal(modalAddEmp));

  // Disparadores de modal de editar metadatos
  document.getElementById('btn-close-edit-modal').addEventListener('click', () => closeModal(modalEditDoc));
  document.getElementById('btn-cancel-edit').addEventListener('click', () => closeModal(modalEditDoc));

  // Disparadores de modal PDF
  document.getElementById('btn-close-pdf-modal').addEventListener('click', () => closeModal(modalViewPdf));

  // Atajos del dashboard
  document.getElementById('card-unregistered-trigger').addEventListener('click', () => {
    window.location.hash = '#registro';
  });
  document.getElementById('btn-see-all-logs').addEventListener('click', () => {
    window.location.hash = '#auditoria';
  });

  // Disparadores de filtro (filtro instantáneo al escribir/cambiar)
  document.getElementById('search-input').addEventListener('input', renderDocumentsTable);
  document.getElementById('filter-type').addEventListener('change', renderDocumentsTable);
  document.getElementById('filter-category').addEventListener('change', renderDocumentsTable);
  document.getElementById('filter-status').addEventListener('change', renderDocumentsTable);
  document.getElementById('filter-date-start').addEventListener('change', renderDocumentsTable);
  document.getElementById('filter-date-end').addEventListener('change', renderDocumentsTable);
  
  // Botón de limpiar filtros
  document.getElementById('btn-clear-filters').addEventListener('click', () => {
    document.getElementById('search-input').value = '';
    document.getElementById('filter-type').value = 'todos';
    document.getElementById('filter-category').value = 'todas';
    document.getElementById('filter-status').value = 'todos';
    document.getElementById('filter-date-start').value = '';
    document.getElementById('filter-date-end').value = '';
    renderDocumentsTable();
  });

  // Vista previa de estilo de arrastre de archivo (setupDragDrop en utils.js)
  setupDragDrop('file-drop-area', 'upload-file', 'file-name-preview');

  // Filtro de lista de empleados (Expedientes)
  document.getElementById('employee-search').addEventListener('input', renderEmployeeDirectory);
  const filterTypeSelect = document.getElementById('employee-filter-type');
  if (filterTypeSelect) {
    filterTypeSelect.addEventListener('change', renderEmployeeDirectory);
  }

  // Filtros de tabla de funcionarios
  const empSearchInput = document.getElementById('emp-search-input');
  if (empSearchInput) empSearchInput.addEventListener('input', renderEmployeesTable);
  const empFilterStatus = document.getElementById('emp-filter-status');
  if (empFilterStatus) empFilterStatus.addEventListener('change', renderEmployeesTable);

  // Filtro de auditoría
  document.getElementById('audit-search-input').addEventListener('input', renderAuditLogsTable);
  document.getElementById('audit-filter-action').addEventListener('change', renderAuditLogsTable);
}

// Redibujar pestaña actual dinámicamente en actualizaciones
function refreshActiveSectionViews() {
  const hash = window.location.hash;
  if (!hash || hash === '#dashboard') {
    // Re-render desde el estado en caché (sin llamada extra a /api/dashboard;
    // fetchStats() se invoca explícitamente cuando se necesita refrescar).
    if (appState.stats) renderStats(appState.stats);
  } else if (hash === '#consultas') {
    renderDocumentsTable();
  } else if (hash === '#registro') {
    renderUnregisteredFiles();
  } else if (hash === '#expedientes') {
    renderEmployeeDirectory();
  } else if (hash === '#auditoria') {
    renderAuditLogsTable();
  } else if (hash === '#funcionarios') {
    renderEmployeesTable();
  } else if (hash === '#eliminaciones') {
    renderDeletionRequests();
  }
}

// Recarga unificada de datos (1 sola llamada API)
async function reloadAll() {
  await loadAllData();
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

// showToast, removeToast, showLoader, hideLoader se definen en utils.js

// ===========================================================
// 8. SCANNER & EMAIL INGESTION CONTROLLERS
// ===========================================================

// --- SUBTAB NAVIGATION ---
window.switchSubTab = function(tabName) {
  document.querySelectorAll('.subtab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.subtabs-navigation .btn').forEach(b => b.classList.remove('active'));

  const panel = document.getElementById('subtab-panel-' + tabName);
  if (panel) panel.classList.add('active');

  const btn = document.getElementById('btn-subtab-' + tabName);
  if (btn) btn.classList.add('active');

  if (tabName === 'scanner') fetchScannerFiles();
  else if (tabName === 'email') fetchEmails();
};

// --- SCANNER ---

async function fetchScannerFiles() {
  try {
    const response = await apiFetch('/api/scanner-files');
    if (!response.ok) throw new Error('Scanner API error');
    appState.scannerFiles = await response.json();
    renderScannerFiles();
  } catch (e) {
    console.error('Error cargando bandeja escanér:', e);
  }
}

function renderScannerFiles() {
  const list = document.getElementById('portal-scanner-list');
  const trayCount = document.getElementById('portal-scanner-tray-count');
  if (trayCount) trayCount.textContent = `${appState.scannerFiles.length} archivo${appState.scannerFiles.length !== 1 ? 's' : ''}`;

  if (!list) return;

  if (appState.scannerFiles.length === 0) {
    list.innerHTML = `
      <div class="portal-no-docs">
        <h4>No hay archivos en la bandeja de escáner</h4>
        <p>Cuando un documento sea escaneado, aparecerá aquí para que pueda registrarlo en un expediente.</p>
      </div>`;
    return;
  }

  let html = '';
  for (let i = 0; i < appState.scannerFiles.length; i++) {
    const f = appState.scannerFiles[i];
    const sizeKB = f.fileSize ? Math.round(f.fileSize / 1024) : '—';
    const safeFn = escOnclick(f.filename);
    html += `<div class="portal-item-card" style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;border:1px solid var(--border-color);">
      <span style="font-size:22px;">📄</span>
      <div class="portal-item-info" style="flex:1;min-width:0;">
        <h5 style="margin:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${sanitize(f.filename)}">${sanitize(f.filename)}</h5>
        <span style="font-size:11px;color:var(--text-muted);">${sizeKB} KB &bull; ${new Date(f.createdAt).toLocaleDateString('es-CO')}</span>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0;">
        <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px;" onclick="event.stopPropagation();openPdfModal('${safeFn}', 'scanner')" title="Vista previa">👁 Ver</button>
        <button class="btn btn-primary" style="padding:5px 12px;font-size:11px;" onclick="openRegisterScannerModal('${safeFn}')">Registrar</button>
      </div></div>`;
  }
  list.innerHTML = html;
}

// --- EMAIL ---

async function fetchGmailStatus() {
  try {
    const res = await apiFetch('/api/gmail/status');
    if (!res.ok) return { configured: false, authenticated: false };
    return await res.json();
  } catch (e) {
    return { configured: false, authenticated: false };
  }
}

function renderGmailStatusBanner(status) {
  const container = document.getElementById('email-inbox-list');
  const syncBtn = document.getElementById('btn-sync-email');
  if (!container) return;

  const existing = document.getElementById('gmail-status-banner');
  if (existing) existing.remove();

  if (status.authenticated) {
    if (syncBtn) syncBtn.disabled = false;
    return;
  }

  if (syncBtn) syncBtn.disabled = true;

  const banner = document.createElement('div');
  banner.id = 'gmail-status-banner';
  banner.style.cssText = 'background:var(--background);border:1px solid var(--border-color);border-radius:8px;padding:16px;margin-bottom:12px;font-size:13px;line-height:1.6;';

  if (!status.configured) {
    banner.innerHTML = `
      <strong style="color:var(--warning);">⚠ Gmail no configurado</strong><br>
      Para sincronizar correos con adjuntos PDF, defina las siguientes variables de entorno antes de iniciar el servidor:<br>
      <code style="display:block;background:var(--border-color);padding:8px;border-radius:4px;margin-top:8px;font-size:12px;">
        GMAIL_CLIENT_ID=&lt;tu_client_id&gt;<br>
        GMAIL_CLIENT_SECRET=&lt;tu_client_secret&gt;<br>
        GMAIL_REDIRECT_URI=http://localhost:3000/api/gmail/oauth2callback<br>
        GMAIL_REFRESH_TOKEN=&lt;obtenido_desde /api/gmail/authorize&gt;
      </code>`;
  } else {
    banner.innerHTML = `
      <strong style="color:var(--warning);">⚠ Gmail pendiente de autorización</strong><br>
      Las credenciales OAuth están configuradas pero falta el <em>refresh token</em>.<br>
      <button onclick="startGmailAuthorization()" style="color:var(--primary);font-weight:600;text-decoration:underline;border:none;background:none;cursor:pointer;">Autorizar Gmail</button>
      para completar la autorización. Luego copie el <code>GMAIL_REFRESH_TOKEN</code> desde la consola del servidor al archivo <code>.env</code>.`;
  }

  container.insertAdjacentElement('beforebegin', banner);
}

async function startGmailAuthorization() {
  try {
    const res = await apiFetch('/api/gmail/authorize');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'No se pudo iniciar la autorización.', 'error');
      return;
    }
    const data = await res.json();
    if (data.url) window.open(data.url, '_blank');
  } catch (e) {
    showToast('Error al iniciar la autorización de Gmail.', 'error');
  }
}

async function fetchEmails() {
  try {
    const [gmailStatus, response] = await Promise.all([
      fetchGmailStatus(),
      apiFetch('/api/email-inbox')
    ]);

    renderGmailStatusBanner(gmailStatus);

    if (!response.ok) throw new Error('Email API error');
    appState.emails = await response.json();
    renderEmailInbox();
    const unread = appState.emails.filter(e => !e.read).length;
    const badge = document.getElementById('badge-email-unread');
    if (badge) {
      badge.textContent = unread;
      badge.style.display = unread > 0 ? 'inline-block' : 'none';
    }
  } catch (e) {
    console.error('Error cargando bandeja de correo:', e);
  }
}

function renderEmailInbox() {
  const container = document.getElementById('email-inbox-list');
  if (!container) return;

  if (appState.emails.length === 0) {
    container.innerHTML = '<div class="no-data-placeholder" style="height:120px;">No hay correos en la bandeja de entrada.</div>';
    return;
  }

  container.innerHTML = '';
  appState.emails.forEach(email => {
    const isActive = appState.selectedEmailId === email.id;
    const docAttachments = (email.attachments || []);

    const card = document.createElement('div');
    card.className = 'email-mini-card' + (isActive ? ' active' : '');
    if (!email.read) card.style.borderLeft = '3px solid var(--primary)';
    card.onclick = () => selectEmail(email.id);

    card.innerHTML = `
      <div class="email-header-sm">
        <span class="email-sender-sm">${sanitize(email.senderName)}</span>
        <span class="email-date-sm">${new Date(email.date).toLocaleDateString()}</span>
      </div>
      <div class="email-subject-sm">${sanitize(email.subject)}</div>
      <div class="email-body-preview-sm">${sanitize((email.body || '').substring(0, 80))}...</div>
      ${docAttachments.length > 0 ? `
        <span class="email-attachments-badge">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
          </svg>
          ${docAttachments.length} adjunto(s)
        </span>` : ''}`;
    container.appendChild(card);
  });
}

function selectEmail(emailId) {
  appState.selectedEmailId = emailId;
  renderEmailInbox();
  renderEmailDetail(emailId);
}

function renderEmailDetail(emailId) {
  const email = appState.emails.find(e => e.id === emailId);
  const blankState = document.getElementById('email-blank-state');
  const detailView = document.getElementById('email-detail-real');
  if (!email || !blankState || !detailView) return;

  blankState.style.display = 'none';
  detailView.style.display = 'flex';

  document.getElementById('email-detail-subject').textContent = email.subject;
  document.getElementById('email-detail-date').textContent = new Date(email.date).toLocaleString();
  document.getElementById('email-detail-sender-name').textContent = email.senderName;
  document.getElementById('email-detail-sender-email').textContent = email.senderEmail || email.sender || 'correo@ejemplo.com';
  document.getElementById('email-detail-body').textContent = email.body;

  const grid = document.getElementById('email-attachments-grid');
  grid.innerHTML = '';

  const docAttachments = (email.attachments || []);

  if (docAttachments.length === 0) {
    grid.innerHTML = '<p style="font-size:12px; color: var(--text-muted); font-style: italic;">Este correo no tiene archivos adjuntos.</p>';
    return;
  }

  docAttachments.forEach(att => {
    const sizeKB = Math.round((att.sizeBytes || att.size || 0) / 1024);
    const isRegistered = att.registered === true;

    const card = document.createElement('div');
    card.className = 'attachment-card';
    card.innerHTML = `
      <div class="attachment-info">
        <svg class="file-icon-pdf" viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
        </svg>
        <div class="attachment-details">
          <h5 title="${sanitize(att.filename)}">${sanitize(att.filename)}</h5>
          <span>${sizeKB > 0 ? sizeKB + ' KB' : 'Adjunto'}</span>
        </div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
        ${isRegistered
          ? '<span class="badge-status aprobado" style="font-size:10px;padding:2px 8px;">Registrado ✓</span>'
          : `<button class="btn btn-primary" style="padding:5px 12px;font-size:11px;white-space:nowrap;"
                     onclick="openRegisterEmailModal('${escOnclick(att.filename)}', '${escOnclick(email.id)}')">Registrar</button>
             <button class="btn btn-secondary btn-icon-only" style="width:28px;height:28px;"
                     onclick="openPdfModal('${escOnclick(att.filename)}', 'email')" title="Vista previa">
               <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2">
                 <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                 <path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
               </svg>
             </button>`
        }
      </div>`;
    grid.appendChild(card);
  });
}



// --- SCANNER STATUS ---
async function refreshScannerStatus() {
  try {
    const res = await apiFetch('/api/scanner/status');
    const data = await res.json();
    if (!data || typeof data !== 'object') return;
    const scanners = Array.isArray(data.scanners) ? data.scanners : [];
    const epsonScanAvailable = !!data.epsonScanAvailable;
    const hwCount = document.getElementById('portal-scanner-count');
    const dot = document.getElementById('portal-scanner-dot');
    const dotText = document.getElementById('portal-scanner-dot-text');
    const list = document.getElementById('portal-scanner-device-list');
    const count = scanners.length;
    const isConnected = count > 0;

    if (hwCount) hwCount.textContent = `${count} dispositivo(s)`;

    if (dot && dotText) {
      if (isConnected) {
        dot.style.background = '#27AE60';
        dotText.textContent = `${count} detectado(s)`;
        dotText.style.color = '#27AE60';
      } else {
        dot.style.background = '#E74C3C';
        dotText.textContent = 'Sin escáner conectado · Verifique conexiones';
        dotText.style.color = '#E74C3C';
      }
    }

    const btnScan = document.getElementById('btn-portal-scan');
    if (btnScan) {
      btnScan.disabled = !isConnected;
      btnScan.style.opacity = isConnected ? '1' : '0.45';
      btnScan.style.cursor = isConnected ? 'pointer' : 'not-allowed';
      btnScan.title = isConnected ? 'Escanear un documento' : 'No hay escáner conectado';
    }

    const btnEpsonScan = document.getElementById('btn-portal-epson-scan');
    if (btnEpsonScan) btnEpsonScan.style.display = epsonScanAvailable ? 'inline-flex' : 'none';

    if (!list) return;

    if (!isConnected) {
      list.innerHTML = `
        <div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;border:2px dashed var(--border-color);border-radius:8px;background:var(--bg-secondary);">
          <div style="font-size:28px;margin-bottom:6px;opacity:0.4;">🖨️</div>
          <div style="font-weight:600;color:var(--text-secondary);">Escáner inactivo</div>
          <div style="margin-top:4px;">No se detectaron dispositivos. Verifique conexiones USB o de red.</div>
        </div>`;
      return;
    }

    let html = '';
    scanners.forEach(s => {
      const typeColor = s.type === 'USB' ? '#8E44AD' : '#2980B9';
      const typeBg = s.type === 'USB' ? 'rgba(142,68,173,0.12)' : 'rgba(41,128,185,0.12)';
      const statusColor = s.status === 'Conectado' || s.status === 'Detectado' ? '#27AE60' : '#F39C12';
      html += `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-secondary);border-radius:8px;margin-bottom:6px;border:1px solid var(--border-color);">
        <span style="font-size:20px;">${sanitize(s.icon || '🖨️')}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${sanitize(s.name)}">${sanitize(s.name)}</div>
          <div style="display:flex;gap:6px;margin-top:3px;flex-wrap:wrap;">
            <span style="font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;background:${typeBg};color:${typeColor};">${sanitize(s.type)}</span>
            <span style="font-size:10px;color:${statusColor};font-weight:600;display:flex;align-items:center;gap:3px;">
              <span style="width:6px;height:6px;border-radius:50%;background:${statusColor};display:inline-block;"></span>${sanitize(s.status)}
            </span>
            ${s.ip ? `<span style="font-size:10px;color:var(--text-muted);">📡 ${sanitize(s.ip)}</span>` : ''}
          </div>
        </div></div>`;
    });
    list.innerHTML = html;
  } catch (e) { console.error('Error actualizando estado del escáner:', e); }
}

