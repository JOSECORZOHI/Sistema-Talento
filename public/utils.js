// ============================================================
//  Funciones compartidas — utils.js
//  Usado por admin.html (app.js) y funcionario.html (funcionario.js)
// ============================================================

// --- SEGURIDAD ---
function sanitize(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escOnclick(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\x27')
    .replace(/"/g, '\\x22')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- AUTENTICACIÓN ---
function getToken() { return localStorage.getItem('th_token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('th_user')); } catch { return null; } }

function logout() {
  localStorage.removeItem('th_token');
  localStorage.removeItem('th_user');
  window.location.href = '/';
}

function checkAuth(requiredRole) {
  const token = getToken();
  const user = getUser();
  if (!token || (requiredRole && (!user || user.role !== requiredRole))) {
    window.location.href = '/';
    return false;
  }
  return true;
}

// --- FETCH CON TOKEN ---
async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, headers, signal: controller.signal });
    if (res.status === 401) {
      logout();
      return res;
    }
    if (res.status === 503) {
      throw new Error('503 Base de datos conectándose');
    }
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function apiFetchWithRetry(url, options = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await apiFetch(url, options);
      if (res.ok) return res;
      if (res.status === 503 && i < retries) {
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      if (i < retries) {
        await new Promise(r => setTimeout(r, 500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

// --- TOAST / NOTIFICACIONES ---
function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast-message toast-${type}`;
  toast.innerHTML = `<span>${sanitize(message)}</span><button class="toast-close">&times;</button>`;

  Object.assign(toast.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    backgroundColor: type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : type === 'info' ? 'var(--primary)' : 'var(--warning)',
    color: 'white', padding: '12px 20px', borderRadius: '8px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    display: 'flex', alignItems: 'center', gap: '12px',
    zIndex: '9999', fontSize: '13px', fontWeight: '600',
    opacity: '0', transform: 'translateY(10px)',
    transition: 'opacity 0.3s ease, transform 0.3s ease',
    fontFamily: 'var(--font-body)'
  });

  const closeBtn = toast.querySelector('.toast-close');
  closeBtn.style.cssText = 'background:none;border:none;color:white;font-size:16px;cursor:pointer;';

  document.body.appendChild(toast);

  setTimeout(() => { toast.style.opacity = '1'; toast.style.transform = 'translateY(0)'; }, 10);

  const autoRemove = setTimeout(() => removeToast(toast), 5000);
  closeBtn.addEventListener('click', () => { clearTimeout(autoRemove); removeToast(toast); });
}

function removeToast(toast) {
  toast.style.opacity = '0';
  toast.style.transform = 'translateY(10px)';
  setTimeout(() => toast.remove(), 300);
}

// --- LOADER / INDICADOR DE CARGA ---
function showLoader() {
  let loader = document.getElementById('global-app-loader');
  if (!loader) {
    loader = document.createElement('div');
    loader.id = 'global-app-loader';
    loader.innerHTML = '<div class="spinner"></div>';
    Object.assign(loader.style, {
      position: 'fixed', left: '0', top: '0', width: '100vw', height: '100vh',
      backgroundColor: 'rgba(255, 255, 255, 0.3)', backdropFilter: 'blur(3px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: '99999'
    });
    const spinner = loader.querySelector('.spinner');
    Object.assign(spinner.style, {
      width: '40px', height: '40px', border: '4px solid var(--border-color)',
      borderTopColor: 'var(--primary)', borderRadius: '50%',
      animation: 'spin-loader 0.8s linear infinite'
    });
    if (!document.getElementById('loader-animation-styles')) {
      const styles = document.createElement('style');
      styles.id = 'loader-animation-styles';
      styles.innerHTML = `@keyframes spin-loader { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`;
      document.head.appendChild(styles);
    }
    document.body.appendChild(loader);
  }
  loader.style.display = 'flex';
}

function hideLoader() {
  const loader = document.getElementById('global-app-loader');
  if (loader) loader.style.display = 'none';
}

// --- MODALES ---
function openModal(modal) {
  if (typeof modal === 'string') modal = document.getElementById(modal);
  if (modal) modal.classList.add('show');
}

function closeModal(modal) {
  if (typeof modal === 'string') modal = document.getElementById(modal);
  if (!modal) return;
  modal.classList.remove('show');
  if (modal.id === 'modal-view-pdf') {
    const iframe = modal.querySelector('iframe');
    if (iframe) { iframe.src = ''; iframe.style.display = 'block'; }
    const downloadMsg = iframe?.parentElement?.querySelector('.download-fallback-msg');
    if (downloadMsg) downloadMsg.style.display = 'none';
  }
}

// --- INICIALES ---
function getInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0].charAt(0);
  const second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : parts[0].charAt(1) || '';
  return (first + second).toUpperCase();
}

// Formatea una fecha 'YYYY-MM-DD' sin corrimiento de zona horaria.
function formatIssueDate(value) {
  if (!value) return '—';
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d)).toLocaleDateString('es-CO');
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('es-CO');
}

function populateDropdown(selectId, items, defaultVal, defaultText, keyField = 'id', textField = 'name') {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = '';
  if (defaultText) {
    const opt = document.createElement('option');
    opt.value = defaultVal || '';
    opt.textContent = defaultText;
    select.appendChild(opt);
  }
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item[keyField];
    opt.textContent = keyField === 'id' && selectId.includes('employee') ? `${item[textField]} (C.C. ${item[keyField]})` : item[textField];
    select.appendChild(opt);
  });
}

function populateSelect(selectId, items) {
  populateDropdown(selectId, items, '', '', 'id', 'name');
}

// Guarda anti doble-envío: previene submits duplicados mientras la petición está en curso.
function guardSubmit(form, handler) {
  if (!form) return;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (form.dataset.submitting === '1') return;
    form.dataset.submitting = '1';
    Promise.resolve(handler(e, form)).finally(() => {
      form.dataset.submitting = '0';
    });
  });
}

// --- TEMA / MODO OSCURO ---
function initTheme(sunSelector, moonSelector, textSelector) {
  const savedTheme = localStorage.getItem('theme') || 'light-theme';
  document.body.className = savedTheme;
  updateThemeUI(savedTheme, sunSelector, moonSelector, textSelector);
}

function updateThemeUI(theme, sunSelector, moonSelector, textSelector) {
  const sun = sunSelector ? document.querySelector(sunSelector) : null;
  const moon = moonSelector ? document.querySelector(moonSelector) : null;
  const text = textSelector ? document.querySelector(textSelector) : null;
  if (!sun || !moon) return;
  if (theme === 'dark-theme') {
    if (text) text.textContent = 'Modo Claro';
    sun.style.display = 'none';
    moon.style.display = 'block';
  } else {
    if (text) text.textContent = 'Modo Oscuro';
    sun.style.display = 'block';
    moon.style.display = 'none';
  }
}

function setupThemeToggle(btnSelector, sunSelector, moonSelector, textSelector) {
  document.querySelector(btnSelector)?.addEventListener('click', () => {
    const current = document.body.classList.contains('dark-theme') ? 'dark-theme' : 'light-theme';
    const next = current === 'dark-theme' ? 'light-theme' : 'dark-theme';
    document.body.className = next;
    localStorage.setItem('theme', next);
    updateThemeUI(next, sunSelector, moonSelector, textSelector);
  });
}

// --- EVALUAR FUERZA DE CONTRASEÑA ---
function evaluatePasswordStrength(password) {
  let score = 0;
  if (password.length >= 12) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[a-z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) score++;

  if (password.length === 0) return { level: 'none', text: '', color: '' };
  if (score <= 2) return { level: 'weak', text: 'Débil — Agregue más caracteres, mayúsculas, números y símbolos', color: '#e74c3c' };
  if (score <= 3) return { level: 'medium', text: 'Media — Agregue símbolos y más caracteres para mayor seguridad', color: '#f39c12' };
  return { level: 'strong', text: 'Fuerte — Contraseña segura', color: '#27ae60' };
}

// --- VISOR PDF COMPARTIDO ---
function renderPdfFallback(filename, url) {
  return `
    <svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5">
      <path stroke-linecap="round" stroke-linejoin="round" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
    </svg>
    <h3 style="margin:0;color:var(--text-primary);">${sanitize(filename)}</h3>
    <p style="margin:0;font-size:13px;">Este tipo de archivo no se puede previsualizar en el navegador.</p>
    <a href="${sanitize(url)}" download="${sanitize(filename)}" class="btn btn-primary" style="text-decoration:none;padding:10px 24px;">
      Descargar archivo
    </a>`;
}

function openPdfViewer(iframeId, filename, folder) {
  const iframe = document.getElementById(iframeId);
  if (!iframe) return;
  const ext = (filename || '').split('.').pop().toLowerCase();
  const viewableTypes = ['pdf','jpg','jpeg','png','gif','bmp','tiff','tif','txt'];
  const canViewInline = viewableTypes.includes(ext);
  const url = `/api/document-file/${encodeURIComponent(filename)}${folder ? '?folder=' + folder : ''}`;

  let downloadMsg = iframe.parentElement.querySelector('.download-fallback-msg');
  if (!downloadMsg) {
    downloadMsg = document.createElement('div');
    downloadMsg.className = 'download-fallback-msg';
    downloadMsg.style.cssText = 'display:none;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;text-align:center;color:var(--text-secondary);padding:40px;';
    iframe.parentElement.appendChild(downloadMsg);
  }

  if (canViewInline) {
    iframe.style.display = 'block';
    iframe.src = url;
    downloadMsg.style.display = 'none';
  } else {
    iframe.style.display = 'none';
    downloadMsg.style.display = 'flex';
    downloadMsg.innerHTML = renderPdfFallback(filename, url);
  }
}

function closePdfViewer(iframeId, modalEl) {
  const iframe = document.getElementById(iframeId);
  if (iframe) { iframe.src = ''; iframe.style.display = 'block'; }
  const downloadMsg = iframe?.parentElement?.querySelector('.download-fallback-msg');
  if (downloadMsg) downloadMsg.style.display = 'none';
  if (modalEl) {
    if (typeof modalEl === 'string') modalEl = document.getElementById(modalEl);
    if (modalEl) modalEl.classList.remove('show');
  }
}

// --- DRAG & DROP ---
function setupDragDrop(dropAreaId, fileInputId, previewId) {
  const dropArea = document.getElementById(dropAreaId);
  const fileInput = document.getElementById(fileInputId);
  const preview = document.getElementById(previewId);
  if (!dropArea || !fileInput) return;

  dropArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    if (preview) preview.textContent = fileInput.files.length > 0 ? fileInput.files[0].name : 'Ningún archivo seleccionado';
  });
  ['dragenter','dragover'].forEach(ev => {
    dropArea.addEventListener(ev, e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  });
  ['dragleave','drop'].forEach(ev => {
    dropArea.addEventListener(ev, e => { e.preventDefault(); dropArea.classList.remove('drag-over'); });
  });
  dropArea.addEventListener('drop', e => {
    if (e.dataTransfer.files.length > 0) {
      try {
        const dt = new DataTransfer();
        for (const file of e.dataTransfer.files) dt.items.add(file);
        fileInput.files = dt.files;
      } catch (err) {
        console.warn('Drag & drop file assignment not supported in this browser');
      }
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      if (preview) preview.textContent = e.dataTransfer.files[0].name;
    }
  });
}

// --- BRAND PANEL HTML (Login pages) ---

