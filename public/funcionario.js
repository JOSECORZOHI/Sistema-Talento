// ============================================================
//  Portal del Funcionario — funcionario.js (basado en JWT)
//  sanitize, apiFetch, apiFetchWithRetry, showToast, showLoader,
//  hideLoader, openModal, closeModal, getInitials, populateSelect,
//  evaluatePasswordStrength, initTheme, setupThemeToggle,
//  setupDragDrop, openPdfViewer, closePdfViewer se definen en utils.js
// ============================================================

let portalState = {
  employee: null,
  documents: [],
  scannerFiles: [],
  emails: [],
  documentTypes: [],
  categories: []
};

// ============================================================
// VERIFICACIÓN DE AUTENTICACIÓN
// ============================================================
// getToken, getUser, checkAuth, apiFetch, apiFetchWithRetry se definen en utils.js
function checkAuthFuncionario() { return checkAuth('funcionario'); }

// ============================================================
// INICIALIZACIÓN
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // --- CAMBIO FORZADO DE CONTRASEÑA (primer login) ---
  const fcpUser = getUser();
  if (fcpUser && fcpUser.mustChangePassword) {
    const fcpModal = document.getElementById('modal-force-change-password');
    if (fcpModal) {
      fcpModal.classList.add('show');
      document.addEventListener('keydown', function blockEsc(e) { if (e.key === 'Escape') e.stopPropagation(); }, true);
      fcpModal.addEventListener('click', function blockBg(e) { if (e.target === fcpModal) e.stopPropagation(); }, true);
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
          fcpUser.mustChangePassword = false;
          localStorage.setItem('th_user', JSON.stringify(fcpUser));
          fcpModal.classList.remove('show');
          showToast('Contraseña actualizada. Bienvenido al sistema.', 'success');
        } catch (err) { errDiv.textContent = 'Error de conexión.'; errDiv.style.display = 'block'; }
      });
    }
  }
  if (!checkAuthFuncionario()) return;

  const user = getUser();
  portalState.employee = {
    id: user.employeeId,
    name: user.name,
    email: user.email,
    department: user.department
  };

  showPortalApp();
  loadPortalData();
  setTimeout(refreshPortalScannerStatus, 500);
  const portalScannerInterval = setInterval(refreshPortalScannerStatus, 15000);
  window.addEventListener('beforeunload', () => clearInterval(portalScannerInterval));

  // Cerrar sesión
  document.getElementById('btn-portal-logout').addEventListener('click', logout);

  // Formulario de subida
  document.getElementById('form-portal-upload').addEventListener('submit', handlePortalUpload);

  // Área de arrastre (setupDragDrop en utils.js)
  setupDragDrop('portal-drop-area', 'portal-upload-file', 'portal-file-preview');

  // Cerrar modal PDF
  document.getElementById('btn-close-portal-pdf').addEventListener('click', closePortalPdf);
  document.getElementById('portal-modal-pdf').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePortalPdf();
  });

  // Formulario de registro de escáner
  document.getElementById('form-register-scanner').addEventListener('submit', handleRegisterScanner);

  // Botón de escaneo real
  const btnPortalScan = document.getElementById('btn-portal-scan');
  if (btnPortalScan) {
    btnPortalScan.addEventListener('click', async () => {
      if (btnPortalScan.disabled) {
        alert('No hay escáner conectado. Verifique las conexiones USB o de red.');
        return;
      }
      const filenameInput = document.getElementById('input-scan-filename');
      const customName = filenameInput ? filenameInput.value.trim() : '';
      btnPortalScan.disabled = true;
      btnPortalScan.textContent = 'Escaneando...';
      try {
        const res = await apiFetch('/api/scanner/scan', { method: 'POST', body: JSON.stringify({ filename: customName || undefined }), headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        if (res.ok) {
          if (filenameInput) filenameInput.value = '';
          alert('Documento escaneado: ' + data.filename);
          await loadPortalData();
          refreshPortalScannerStatus();
        } else {
          alert(data.error || 'Error al escanear.');
        }
      } catch (e) {
        alert('Error de red al escanear.');
      } finally {
        btnPortalScan.disabled = false;
        btnPortalScan.textContent = 'Escanear Documento';
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
        if (res.ok) {
          alert(data.message || 'EPSON Scan 2 abierto.');
          await loadPortalData();
        } else {
          alert(data.error || 'Error al abrir EPSON Scan 2.');
        }
      } catch (e) {
        alert('Error de red al abrir EPSON Scan 2.');
      } finally {
        btnEpsonScan.disabled = false;
      }
    });
  }

  // Formulario de registro de correo
  document.getElementById('form-register-email').addEventListener('submit', handleRegisterEmailAttachment);

  // Botón de cambiar contraseña
  document.getElementById('btn-change-password').addEventListener('click', () => openModal('modal-change-password'));

  // Formulario de cambiar contraseña
  document.getElementById('form-change-password').addEventListener('submit', handleChangePassword);

  // Alternador de modo oscuro (initTheme y setupThemeToggle se definen en utils.js)
  initTheme('.portal-sun-icon', '.portal-moon-icon', null);
  setupThemeToggle('#btn-theme-toggle', '.portal-sun-icon', '.portal-moon-icon', null);

  // Formulario de solicitud de eliminación
  let submittingDeleteReq = false;
  document.getElementById('form-delete-request')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submittingDeleteReq) return;
    submittingDeleteReq = true;
    const documentId = document.getElementById('delete-req-doc-id').value;
    const reason = document.getElementById('delete-req-reason').value;

    showLoader();
    try {
      const res = await apiFetch('/api/deletion-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId, reason })
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Error al enviar solicitud.'); return; }

      showToast('Solicitud de eliminación enviada. Esperando aprobación del administrador.', 'info');
      closeModal('modal-delete-request');
      await loadPortalData();
    } catch (err) {
      alert('Error de conexión.');
    } finally {
      hideLoader();
      submittingDeleteReq = false;
    }
  });

  // Botón de actualizar escáneres
  document.getElementById('btn-portal-refresh-scanners')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-portal-refresh-scanners');    btn.disabled = true;
    btn.textContent = '🔄 Buscando...';
    try {
      await apiFetch('/api/scanner/refresh', { method: 'POST' });
      await refreshPortalScannerStatus();
    } catch (e) { console.error('Error refrescando escáneres:', e); }
    btn.disabled = false;
    btn.textContent = '🔄 Actualizar lista';
  });
});

function showPortalApp() {
  const emp = portalState.employee;
  if (!emp) return;
  const initials = getInitials(emp.name);
  document.getElementById('portal-avatar').textContent = initials;
  document.getElementById('portal-user-name').textContent = emp.name;
  document.getElementById('portal-user-dept').textContent = emp.department || 'Talento Humano';
  const welcomeName = document.getElementById('portal-welcome-name');
  if (welcomeName) {
    const firstName = (emp.name || '').split(' ')[0];
    welcomeName.textContent = firstName;
  }
}

// ============================================================
// CARGAR DATOS
// ============================================================
async function loadPortalData() {
  try {
    const res = await apiFetchWithRetry('/api/funcionario/init');
    if (!res.ok) throw new Error('Failed to load');
    const data = await res.json();

    portalState.documentTypes = data.config?.documentTypes || [];
    portalState.categories = data.config?.categories || [];
    portalState.documents = data.docs || [];
    portalState.scannerFiles = data.scannerFiles || [];
    portalState.emails = data.emails || [];

    populateSelect('portal-upload-type', portalState.documentTypes);
    populateSelect('portal-upload-category', portalState.categories);
    populateSelect('scanner-reg-type', portalState.documentTypes);
    populateSelect('scanner-reg-category', portalState.categories);
    populateSelect('email-reg-type', portalState.documentTypes);
    populateSelect('email-reg-category', portalState.categories);

    renderPortalDocs();
    renderPortalScannerFiles();
    renderPortalEmailInbox();
  } catch (err) {
    console.error(err);
  }
}

// ============================================================
// RENDERIZAR DOCUMENTOS
// ============================================================
function renderPortalDocs() {
  const grid = document.getElementById('portal-docs-grid');
  const count = document.getElementById('portal-docs-count');
  const docs = portalState.documents || [];
  if (count) count.textContent = `${docs.length} documento${docs.length !== 1 ? 's' : ''}`;

  const totalEl = document.getElementById('stat-total');
  const activosEl = document.getElementById('stat-activos');
  if (totalEl) totalEl.textContent = docs.length;
  if (activosEl) activosEl.textContent = docs.filter(d => d.status !== 'Archivado' && d.status !== 'Rechazado').length;

  if (docs.length === 0) {
    grid.innerHTML = `
      <div class="portal-no-docs" style="grid-column:1/-1;">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <h4>No hay documentos disponibles</h4>
        <p>Suba documentos desde las pestañas "Subir Documento", "Escaner" o "Correo".</p>
      </div>`;
    return;
  }

  const typeMap = {};
  portalState.documentTypes.forEach(t => { typeMap[t.id] = t.name; });
  const catMap = {};
  portalState.categories.forEach(c => { catMap[c.id] = c.name; });

  let html = '';
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const typeName = typeMap[doc.documentTypeId] || doc.documentTypeId;
    const catName = catMap[doc.categoryId] || doc.categoryId;
    const sizeKB = doc.fileSize ? Math.round(doc.fileSize / 1024) : '—';
    const fechaEmision = doc.issueDate ? new Date(doc.issueDate + 'T00:00:00').toLocaleDateString('es-CO') : '—';
    const safeFn = escOnclick(doc.filename);
    const safeId = escOnclick(doc.id);
    html += `<div class="portal-doc-card">
      <div class="portal-doc-card-body">
      <div class="doc-icon">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="#B03A2E" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
      </div>
      <h5 title="${sanitize(doc.filename)}">${sanitize(doc.originalName || doc.filename)}</h5>
      <div class="doc-type">${sanitize(typeName)}</div>
      <div class="doc-meta">${sanitize(catName)} · Emisión: ${fechaEmision} · ${sizeKB} KB</div>
      </div>
      <div class="doc-footer">
        <span class="badge-status ${['pendiente','activo','aprobado','rechazado','archivado'].includes((doc.status || '').toLowerCase()) ? (doc.status || '').toLowerCase() : ''}">${sanitize(doc.status)}</span>
        <div style="display:flex;gap:6px;align-items:center;">
          <button class="btn-ver-doc" onclick="openPortalPdf('${safeFn}')">Ver</button>
          <button class="btn-delete-doc" onclick="openDeleteRequest('${safeId}', '${safeFn}')" title="Solicitar eliminación">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
          </button>
        </div>
      </div></div>`;
  }
  grid.innerHTML = html;
}

// ============================================================
// RENDERIZAR ARCHIVOS DEL ESCÁNER
// ============================================================
function renderPortalScannerFiles() {
  const list = document.getElementById('portal-scanner-list');
  const trayCount = document.getElementById('portal-scanner-tray-count');
  const files = portalState.scannerFiles;
  if (trayCount) trayCount.textContent = `${files.length} archivo${files.length !== 1 ? 's' : ''}`;

  if (files.length === 0) {
    list.innerHTML = `
      <div class="portal-no-docs">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>
          <line x1="7" y1="12" x2="17" y2="12"/>
        </svg>
        <h4>No hay archivos en la bandeja de escáner</h4>
        <p>Cuando un documento sea escaneado, aparecerá aquí para que pueda registrarlo en su expediente.</p>
      </div>`;
    return;
  }

  let html = '';
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const sizeKB = f.fileSize ? Math.round(f.fileSize / 1024) : '—';
    const safeFn = escOnclick(f.filename);
    html += `<div class="portal-item-card">
      <div class="portal-item-icon">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--primary)" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
      </div>
      <div class="portal-item-info">
        <h5 title="${sanitize(f.filename)}">${sanitize(f.filename)}</h5>
        <span>${sizeKB} KB · ${new Date(f.createdAt).toLocaleDateString('es-CO')}</span>
      </div>
      <div class="portal-item-actions">
        <button class="btn-ver-doc" onclick="event.stopPropagation();openPortalPdf('${safeFn}', 'scanner')">Ver</button>
        <button class="btn-register-item" onclick="openRegisterScanner('${safeFn}')">Registrar</button>
      </div></div>`;
  }
  list.innerHTML = html;
}

// ============================================================
// RENDERIZAR BANDEJA DE CORREO
// ============================================================
function renderPortalEmailInbox() {
  const list = document.getElementById('portal-email-list');
  const count = document.getElementById('portal-email-count');
  const emails = portalState.emails || [];
  if (count) count.textContent = `${emails.length} correo${emails.length !== 1 ? 's' : ''}`;

  if (emails.length === 0) {
    list.innerHTML = `
      <div class="portal-no-docs">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
        </svg>
        <h4>No hay correos disponibles</h4>
        <p>Cuando se sincronicen correos con adjuntos PDF, podrán registrarse aquí.</p>
      </div>`;
    return;
  }

  let html = '';
  for (let i = 0; i < emails.length; i++) {
    const email = emails[i];
    const unregisteredAttachments = (email.attachments || []).filter(a => !a.registered);
    if (unregisteredAttachments.length === 0) continue;

    let attachHtml = '';
    for (let j = 0; j < unregisteredAttachments.length; j++) {
      const att = unregisteredAttachments[j];
      const sizeKB = att.sizeBytes ? Math.round(att.sizeBytes / 1024) : '—';
      const safeEmailId = escOnclick(email.id);
      const safeAttFn = escOnclick(att.filename);
      attachHtml += `<div class="portal-item-card" style="margin-top:6px;padding:10px 14px;background:var(--background);">
        <div class="portal-item-icon" style="background:var(--secondary-soft);">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--secondary)" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
          </svg>
        </div>
        <div class="portal-item-info">
          <h5>${sanitize(att.filename)}</h5>
          <span>${sizeKB} KB</span>
        </div>
        <div class="portal-item-actions">
          <button class="btn-register-item" onclick="openRegisterEmail('${safeEmailId}', '${safeAttFn}')">Registrar</button>
        </div></div>`;
    }
    html += `<div class="portal-item-card" style="flex-direction:column;align-items:stretch;gap:0;">
      <div style="display:flex;align-items:center;gap:12px;padding:2px 0;">
        <div class="portal-item-icon" style="background:var(--primary-soft);">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="var(--primary)" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
          </svg>
        </div>
        <div class="portal-item-info">
          <h5>${sanitize(email.subject || '(Sin asunto)')}</h5>
          <span>De: ${sanitize(email.senderName || email.senderEmail)} — ${new Date(email.date).toLocaleDateString('es-CO')}</span>
        </div>
      </div>
      <div style="margin-top:6px;border-top:1px solid var(--border-color);padding-top:6px;">${attachHtml}</div>
    </div>`;
  }
  list.innerHTML = html;
}

// ============================================================
// SUBIR DOCUMENTO
// ============================================================
async function handlePortalUpload(e) {
  e.preventDefault();
  const fileInput = document.getElementById('portal-upload-file');
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Seleccione un archivo para subir.');
    return;
  }

  const btn = document.getElementById('btn-portal-submit-upload');
  btn.disabled = true;
  btn.textContent = 'Enviando...';
  showLoader();

  try {
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('documentTypeId', document.getElementById('portal-upload-type').value);
    formData.append('categoryId', document.getElementById('portal-upload-category').value);
    formData.append('issueDate', document.getElementById('portal-upload-date').value);
    formData.append('description', document.getElementById('portal-upload-desc').value);

    const res = await apiFetch('/api/funcionario/subir-documento', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'No se pudo subir el documento.');
      return;
    }

    showToast('Documento registrado exitosamente.', 'success');
    e.target.reset();
    document.getElementById('portal-file-preview').textContent = 'Ningún archivo seleccionado';
    portalShowTab('mis-docs');
    await loadPortalData();
  } catch (err) {
    alert('Error de conexión. Intente nuevamente.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enviar Documento';
    hideLoader();
  }
}

// ============================================================
// REGISTRAR DOCUMENTO DE ESCÁNER
// ============================================================
window.openRegisterScanner = function(filename) {
  document.getElementById('scanner-reg-filename').value = filename;
  document.getElementById('scanner-reg-filename-display').textContent = filename;
  document.getElementById('scanner-reg-type').value = '';
  document.getElementById('scanner-reg-category').value = '';
  document.getElementById('scanner-reg-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('scanner-reg-desc').value = '';
  openModal('modal-register-scanner');
};

let submittingScannerReg = false;
async function handleRegisterScanner(e) {
  e.preventDefault();
  if (submittingScannerReg) return;
  submittingScannerReg = true;
  const filename = document.getElementById('scanner-reg-filename').value;
  const documentTypeId = document.getElementById('scanner-reg-type').value;
  const categoryId = document.getElementById('scanner-reg-category').value;
  const issueDate = document.getElementById('scanner-reg-date').value;
  const description = document.getElementById('scanner-reg-desc').value;

  showLoader();
  try {
    const res = await apiFetch('/api/funcionario/register-scanner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, documentTypeId, categoryId, issueDate, description, status: 'Pendiente' })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Error al registrar.'); return; }

    showToast('Documento escaneado registrado exitosamente.', 'success');
    closeModal('modal-register-scanner');
    await loadPortalData();
  } catch (err) {
    alert('Error de conexión.');
  } finally {
    hideLoader();
    submittingScannerReg = false;
  }
}

// ============================================================
// REGISTRAR ADJUNTO DE CORREO
// ============================================================
window.openRegisterEmail = function(emailId, filename) {
  document.getElementById('email-reg-emailId').value = emailId;
  document.getElementById('email-reg-filename').value = filename;
  document.getElementById('email-reg-filename-display').textContent = filename;
  document.getElementById('email-reg-type').value = '';
  document.getElementById('email-reg-category').value = '';
  document.getElementById('email-reg-date').value = new Date().toISOString().split('T')[0];
  document.getElementById('email-reg-desc').value = '';
  openModal('modal-register-email');
};

let submittingEmailReg = false;
async function handleRegisterEmailAttachment(e) {
  e.preventDefault();
  if (submittingEmailReg) return;
  submittingEmailReg = true;
  const emailId = document.getElementById('email-reg-emailId').value;
  const filename = document.getElementById('email-reg-filename').value;
  const documentTypeId = document.getElementById('email-reg-type').value;
  const categoryId = document.getElementById('email-reg-category').value;
  const issueDate = document.getElementById('email-reg-date').value;
  const description = document.getElementById('email-reg-desc').value;

  showLoader();
  try {
    const res = await apiFetch('/api/funcionario/register-email-attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailId, filename, documentTypeId, categoryId, issueDate, description, status: 'Pendiente' })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Error al registrar.'); return; }

    showToast('Adjunto de correo registrado exitosamente.', 'success');
    closeModal('modal-register-email');
    await loadPortalData();
  } catch (err) {
    alert('Error de conexión.');
  } finally {
    hideLoader();
    submittingEmailReg = false;
  }
}

// ============================================================
// SOLICITUD DE ELIMINACIÓN
// ============================================================
window.openDeleteRequest = function(docId, filename) {
  document.getElementById('delete-req-doc-id').value = docId;
  document.getElementById('delete-req-filename').textContent = filename;
  document.getElementById('delete-req-reason').value = '';
  loadFuncionarioDeletionRequests();
  openModal('modal-delete-request');
};

async function loadFuncionarioDeletionRequests() {
  const container = document.getElementById('func-deletion-requests-list');
  if (!container) return;
  try {
    const res = await apiFetch('/api/funcionario/deletion-requests');
    if (!res.ok) { container.innerHTML = '<p class="portal-muted">No se pudieron cargar sus solicitudes.</p>'; return; }
    const requests = await res.json();
    if (!requests.length) { container.innerHTML = '<p class="portal-muted">No tiene solicitudes de eliminación pendientes o previas.</p>'; return; }
    container.innerHTML = requests.map(req => {
      const badge = req.status === 'Pendiente' ? 'solicitud-status-pendiente'
        : req.status === 'Aprobada' ? 'solicitud-status-aprobada'
        : 'solicitud-status-rechazada';
      return `<div class="func-req-item"><span class="func-req-file">${sanitize(req.documentFilename)}</span><span class="func-req-status ${badge}">${sanitize(req.status)}</span><span class="func-req-date">${sanitize((req.createdAt || '').slice(0, 10))}</span></div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = '<p class="portal-muted">Error de conexión al cargar solicitudes.</p>';
  }
}

// ============================================================
// CAMBIAR CONTRASEÑA
// ============================================================
let submittingChangePw = false;
async function handleChangePassword(e) {
  e.preventDefault();
  if (submittingChangePw) return;
  submittingChangePw = true;
  const errorDiv = document.getElementById('cp-error');
  errorDiv.style.display = 'none';

  const currentPassword = document.getElementById('cp-current').value;
  const newPassword = document.getElementById('cp-new').value;
  const confirm = document.getElementById('cp-confirm').value;

  if (newPassword !== confirm) {
    errorDiv.textContent = 'Las contraseñas nuevas no coinciden.';
    errorDiv.style.display = 'block';
    submittingChangePw = false;
    return;
  }

  try {
    const res = await apiFetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json();
    if (!res.ok) {
      errorDiv.textContent = data.error || 'Error al cambiar contraseña.';
      errorDiv.style.display = 'block';
      submittingChangePw = false;
      return;
    }

    showToast('Contraseña actualizada exitosamente.', 'success');
    closeModal('modal-change-password');
    document.getElementById('form-change-password').reset();
    if (data.forceReauth) {
      setTimeout(() => logout(), 1200);
    }
  } catch (err) {
    errorDiv.textContent = 'Error de conexión.';
    errorDiv.style.display = 'block';
  } finally {
    submittingChangePw = false;
  }
}

// ============================================================
// ESTADO DEL ESCÁNER
// ============================================================
async function refreshPortalScannerStatus() {
  try {
    const res = await apiFetch('/api/scanner/status');
    const data = await res.json();
    if (!data || typeof data !== 'object') return;
    const dot = document.getElementById('portal-scanner-dot');
    const dotText = document.getElementById('portal-scanner-dot-text');
    const deviceList = document.getElementById('portal-scanner-device-list');
    const scannerCount = document.getElementById('portal-scanner-count');
    if (!dot || !dotText) return;

    const scanners = Array.isArray(data.scanners) ? data.scanners : [];
    const epsonScanAvailable = !!data.epsonScanAvailable;
    const count = scanners.length;
    const usbCount = data.usbCount || 0;
    const netCount = data.networkCount || 0;
    const isConnected = count > 0;

    const btnScan = document.getElementById('btn-portal-scan');
    if (scannerCount) {
      scannerCount.textContent = isConnected
        ? `${count} detectado(s) · ${usbCount} USB · ${netCount} Red`
        : '0 dispositivo(s)';
    }

    if (isConnected) {
      dot.style.background = '#27AE60';
      dotText.textContent = `${count} escáner(es) disponible(s)`;
      dotText.style.color = '#27AE60';
    } else {
      dot.style.background = '#E74C3C';
      dotText.textContent = 'Escáner inactivo — No conectado';
      dotText.style.color = '#E74C3C';
    }

    if (btnScan) {
      btnScan.disabled = !isConnected;
      btnScan.style.opacity = isConnected ? '1' : '0.45';
      btnScan.style.cursor = isConnected ? 'pointer' : 'not-allowed';
      btnScan.title = isConnected ? 'Escanear un documento' : 'No hay escáner conectado';
    }

    const btnEpsonScan = document.getElementById('btn-portal-epson-scan');
    if (btnEpsonScan) btnEpsonScan.style.display = epsonScanAvailable ? 'inline-flex' : 'none';

    if (deviceList) {
      if (!isConnected) {
        deviceList.innerHTML = `
          <div style="text-align:center;padding:20px;color:var(--text-muted);font-size:12px;border:2px dashed var(--border-color);border-radius:10px;background:var(--bg-secondary);">
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 8px;display:block;opacity:0.3;">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>
              <line x1="7" y1="12" x2="17" y2="12"/>
            </svg>
            <div style="font-weight:600;color:var(--text-secondary);margin-bottom:4px;">Escáner inactivo</div>
            <div style="line-height:1.5;">No se detectaron dispositivos. Verifique conexiones USB o de red.</div>
          </div>`;
      } else {
        let html = '';
        scanners.forEach(s => {
          const typeColor = s.type === 'USB' ? '#8E44AD' : '#2980B9';
          const typeBg = s.type === 'USB' ? 'rgba(142,68,173,0.12)' : 'rgba(41,128,185,0.12)';
          const statusColor = s.status === 'Conectado' || s.status === 'Detectado' ? '#27AE60' : '#F39C12';
          html += `<div class="portal-item-card" style="padding:10px 14px;gap:12px;">
            <div class="portal-item-icon" style="background:${typeBg};">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="${typeColor}" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/>
                <line x1="7" y1="12" x2="17" y2="12"/>
              </svg>
            </div>
            <div class="portal-item-info">
              <div style="font-weight:600;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${sanitize(s.name)}">${sanitize(s.name)}</div>
              <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;align-items:center;">
                <span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:4px;background:${typeBg};color:${typeColor};">${sanitize(s.type)}</span>
                <span style="font-size:9px;color:${statusColor};font-weight:600;display:flex;align-items:center;gap:3px;">
                  <span style="width:6px;height:6px;border-radius:50%;background:${statusColor};display:inline-block;"></span>${sanitize(s.status)}
                </span>
                ${s.ip ? `<span style="font-size:9px;color:var(--text-muted);display:flex;align-items:center;gap:3px;">
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0"/>
                  </svg>
                  ${sanitize(s.ip)}</span>` : ''}
              </div>
            </div></div>`;
        });
        deviceList.innerHTML = html;
      }
    }
  } catch (e) { console.error('Error actualizando estado del escáner:', e); }
}

// ============================================================
// VISOR DE PDF (openPdfViewer y closePdfViewer en utils.js)
// ============================================================
window.openPortalPdf = function(filename, folder) {
  document.getElementById('portal-pdf-modal-title').textContent = filename;
  openPdfViewer('portal-pdf-iframe', filename, folder || null);
  document.getElementById('portal-modal-pdf').classList.add('show');
};

function closePortalPdf() {
  closePdfViewer('portal-pdf-iframe', 'portal-modal-pdf');
}

// ============================================================
// PESTAÑAS
// ============================================================
window.portalShowTab = function(tab) {
  document.querySelectorAll('.portal-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.portal-panel').forEach(p => p.classList.remove('active'));
  const tabBtn = document.querySelector(`.portal-tab[data-tab="${tab}"]`);
  if (tabBtn) tabBtn.classList.add('active');
  const panel = document.getElementById('panel-' + tab);
  if (panel) panel.classList.add('active');
};

// ============================================================
// AUXILIARES — showLoader, hideLoader, showToast, openModal,
// closeModal, populateSelect se definen en utils.js
// ============================================================
