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

  // Panel de estado del sistema (BD, índices, Gmail, seguridad)
  fetchSystemStatus().then(renderSystemStatus);
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


// showToast, removeToast, showLoader, hideLoader se definen en utils.js


