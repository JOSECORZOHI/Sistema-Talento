// Módulo ESCÁNER & CORREO del panel administrativo.
// (división de app.js: ingesta por escáner local y correo Gmail)

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
        <span style="font-size:11px;color:var(--text-muted);">${sizeKB} KB &bull; ${formatDate(f.createdAt)}</span>
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
        <span class="email-date-sm">${formatDate(email.date)}</span>
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
  document.getElementById('email-detail-date').textContent = formatDate(email.date, { dateStyle: 'medium', timeStyle: 'short' });
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