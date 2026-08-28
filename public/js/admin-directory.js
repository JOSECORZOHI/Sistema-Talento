/* exported renderEmployeesTable, renderEmployeeDirectory, selectEmployeeForFolder */
// Módulo DIRECTORIO / EXPEDIENTES del panel administrativo.
// (división de app.js: renderizados de funcionarios y hojas de vida)

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