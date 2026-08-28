/* exported renderDocumentsTable, renderUnregisteredFiles */
// Módulo DOCUMENTOS del panel administrativo.
// (división de app.js: tabla de consultas, archivos locales sin registrar,
//  modales PDF/edición/registro unificado y acciones sobre documentos)

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
            <span class="filename-secondary">${sizeKB} KB &bull; Subido el ${formatDate(doc.registeredAt)}</span>
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

// MODAL DE VISUALIZACIÓN PDF
window.openPdfModal = async function(filename, folder = 'documents', docId) {
  let doc = null;
  const iframe = document.getElementById('pdf-iframe');
  const ext = (filename || '').split('.').pop().toLowerCase();
  const viewableTypes = ['pdf','jpg','jpeg','png','gif','bmp','tiff','tif','txt'];
  const canViewInline = viewableTypes.includes(ext);
  
  // Restablecer estado de botones deshabilitados
  document.getElementById('btn-update-pdf-status').disabled = false;
  document.getElementById('btn-archive-pdf-direct').disabled = false;

  document.getElementById('btn-toggle-visibility').style.display = 'none';

  async function setIframeSrc(url) {
    // Carga el archivo vía fetch (token por cabecera Authorization) y renderiza
    // desde un Blob URL: el JWT nunca aparece en la URL del iframe ni en logs.
    const iframeEl = iframe;
    if (iframeEl._blobUrl) { URL.revokeObjectURL(iframeEl._blobUrl); iframeEl._blobUrl = null; }
    try {
      const res = await apiFetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      iframeEl._blobUrl = blobUrl;
      if (canViewInline) {
        iframeEl.style.display = 'block';
        iframeEl.src = blobUrl;
      } else {
        iframeEl.style.display = 'none';
        const viewerFrame = iframeEl.parentElement;
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
        downloadMsg.querySelector('a').href = blobUrl;
        downloadMsg.querySelector('a').download = filename;
      }
    } catch (e) {
      console.error('No se pudo cargar el archivo:', e);
      if (iframeEl._blobUrl) { URL.revokeObjectURL(iframeEl._blobUrl); iframeEl._blobUrl = null; }
      iframeEl.style.display = 'block';
      iframeEl.srcdoc = `
        <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text-secondary);font-size:14px;text-align:center;padding:24px;">
          <h3 style="margin:0;">No se pudo cargar el archivo</h3>
          <p style="margin:0;">Compruebe su conexión y vuelva a intentarlo.</p>
        </div>`;
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
    await setIframeSrc(`/api/document-file/${encodeURIComponent(filename)}?folder=scanner`);
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
    await setIframeSrc(`/api/document-file/${encodeURIComponent(filename)}?folder=gmail`);
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
    await setIframeSrc(`/api/document-file/${encodeURIComponent(filename)}`);
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
  document.getElementById('edit-issue-date').value = options.issueDate || new Date().toISOString().substring(0, 10);
  document.getElementById('edit-expiry-date').value = '';
  document.getElementById('edit-status').value = defaultStatuses[mode] || 'Pendiente';
  document.getElementById('edit-description').value = options.description || '';
  document.getElementById('edit-mode-local').value = mode;
  document.getElementById('edit-email-id').value = emailId;
  openModal(modalEditDoc);

  // Análisis automático del documento: sugiere tipo, categoría, funcionario,
  // fecha y descripción. El admin confirma los campos antes de guardar.
  if (mode !== 'false') triggerAnalysis(filename, mode);
}

async function triggerAnalysis(filename, mode) {
  const statusEl = document.getElementById('analyze-status');
  if (!statusEl) return;
  statusEl.innerHTML = '<span class="spin">&#9696;</span> Analizando documento (puede tardar unos segundos)...';
  statusEl.className = 'analyze-status busy';
  statusEl.style.display = 'block';
  try {
    const folder = mode === 'scanner' ? 'scanner' : (mode === 'email' ? 'gmail' : undefined);
    const res = await apiFetch('/api/documents/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, folder })
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.suggestions) {
      statusEl.textContent = (data && data.error) ? data.error : 'No se pudo analizar este documento.';
      statusEl.className = 'analyze-status error';
      return;
    }
    const s = data.suggestions;
    const fillIfEmpty = (id, val) => {
      const el = document.getElementById(id);
      if (el && val && !el.value) el.value = val;
    };
    fillIfEmpty('edit-category', s.categoryId);
    fillIfEmpty('edit-type', s.documentTypeId);
    fillIfEmpty('edit-employee', s.employeeId);
    fillIfEmpty('edit-issue-date', s.issueDate);
    const descEl = document.getElementById('edit-description');
    if (descEl && s.description && descEl.value.trim().length < 5) {
      descEl.value = s.description;
      if (descEl.style) descEl.style.height = 'auto';
    }
    const parts = [s.documentTypeId, s.categoryId];
    if (s.issueDate) parts.push('fecha ' + s.issueDate);
    if (s.employeeId) parts.push('funcionario');
    statusEl.textContent = 'Análisis completado' + (data.ocrUsed ? ' con OCR' : '') + ': ' + parts.join(' · ') + '. Revise y confirme.';
    statusEl.className = 'analyze-status done';
  } catch (err) {
    statusEl.textContent = 'No se pudo analizar el documento.';
    statusEl.className = 'analyze-status error';
  }
}

// Mantener nombres anteriores para compatibilidad
window.openRegisterLocalModal = function(filename) { openRegisterModal(filename, { mode: 'local' }); };
window.openRegisterScannerModal = function(filename) { openRegisterModal(filename, { mode: 'scanner' }); };
window.openRegisterEmailModal = function(filename, emailId) {
  const email = appState.emails?.find(e => e.id === emailId);
  const options = { mode: 'email', emailId };
  if (email) {
    // Auto-llenado desde el correo: empleado sugerido (remitente), fecha de emisión = fecha
    // del correo y descripción con el asunto + remitente + fecha. El admin solo confirma.
    options.suggestedEmployeeId = email.suggestedEmployeeId || '';
    const dateObj = email.date ? new Date(email.date) : null;
    const issueDate = (dateObj && !isNaN(dateObj.getTime())) ? dateObj.toISOString().substring(0, 10) : '';
    if (issueDate) options.issueDate = issueDate;
    const senderLine = email.senderName
      ? `${email.senderName}${email.senderEmail ? ` <${email.senderEmail}>` : ''}`
      : (email.senderEmail || email.sender || '');
    const descParts = [`Asunto: ${email.subject || '(Sin asunto)'}`];
    if (senderLine) descParts.push(`Remitente: ${senderLine}`);
    if (dateObj && !isNaN(dateObj.getTime())) descParts.push(`Fecha del correo: ${formatDate(dateObj)}`);
    options.description = descParts.join('\n');
  }
  openRegisterModal(filename, options);
};

// openModal y closeModal se definen en utils.js

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