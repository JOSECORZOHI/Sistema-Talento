/* exported sanitize, escOnclick, getToken, getUser, logout, checkAuth, apiFetch, apiFetchWithRetry, showToast, removeToast, showLoader, hideLoader, openModal, closeModal, attachModalBackdropClose, getInitials, formatIssueDate, formatDate, populateDropdown, populateSelect, guardSubmit, initTheme, updateThemeUI, setupThemeToggle, evaluatePasswordStrength, bindPasswordStrengthMeter, openPdfViewer, closePdfViewer, setupDragDrop, getStorageConsent, grantStorageConsent, declineStorageConsent, maybeShowStorageConsentBanner, storageWritesAllowed */
// ============================================================
//  Funciones compartidas — utils.js
//  Usado por admin.html (app.js) y funcionario.html (funcionario.js)
// ============================================================

// --- ACCESIBILIDAD ---
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('svg').forEach(svg => {
    if (svg.hasAttribute('role') || svg.getAttribute('aria-hidden') === 'true') return;
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  });
  // Cerrar modales al hacer clic en el fondo (backdrop) — mejora de accesibilidad.
  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    attachModalBackdropClose(modal);
  });
});

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
    .replace(/['"\r\n\t\u2028\u2029]/g, (ch) => {
      if (ch === "'") return '\\x27';
      if (ch === '"') return '\\x22';
      return '';
    })
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// --- CONSENTIMIENTO DE ALMACENAMIENTO (Lucha 1581 / GDPR) ---
// Este sitio guarda datos de sesión y preferencias en el almacenamiento local
// del navegador. Se solicita autorización antes de escribir dichos datos.
function getStorageConsent() {
  try { return localStorage.getItem('th_data_consent') === 'accepted'; }
  catch { return false; }
}

function grantStorageConsent() {
  try { localStorage.setItem('th_data_consent', 'accepted'); } catch (e) { /* noop */ }
  hideStorageConsentBanner();
}

function declineStorageConsent() {
  hideStorageConsentBanner();
  try { localStorage.removeItem('th_data_consent'); } catch (e) { /* noop */ }
}

function hideStorageConsentBanner() {
  const banner = document.getElementById('storage-consent-banner');
  if (banner) banner.remove();
}

function maybeShowStorageConsentBanner() {
  if (getStorageConsent()) return;
  if (document.getElementById('storage-consent-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'storage-consent-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Aviso de privacidad y almacenamiento en el navegador');
  Object.assign(banner.style, {
    position: 'fixed', left: '16px', right: '16px', bottom: '16px', zIndex: '999999',
    background: '#fff', color: '#333', border: '1px solid #d6dde5', borderRadius: '12px',
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)', padding: '18px 22px',
    fontFamily: 'var(--font-body)', maxWidth: '720px', margin: '0 auto'
  });
  banner.innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:220px;">
        <strong style="font-size:14px;color:#1A5276;">Aviso de privacidad y almacenamiento</strong>
        <p style="margin:6px 0 0;font-size:12.5px;line-height:1.5;color:#555;">
          Este sistema guarda sus datos de sesión y preferencias en el almacenamiento local de su
          navegador. Sus datos personales se tratan conforme a la
          <a href="/privacy.html" target="_blank" rel="noopener" style="color:#1A5276;">Política de Privacidad</a>
          y la Ley 1581 de 2012.
        </p>
      </div>
      <div style="display:flex;gap:10px;align-items:center;">
        <button id="storage-consent-accept" class="btn btn-primary" style="padding:8px 18px;">Aceptar</button>
        <button id="storage-consent-decline" class="btn btn-secondary" style="padding:8px 18px;">Rechazar</button>
      </div>
    </div>`;
  document.body.appendChild(banner);
  document.getElementById('storage-consent-accept').addEventListener('click', grantStorageConsent);
  document.getElementById('storage-consent-decline').addEventListener('click', declineStorageConsent);
}

// helper: devuelve true si se puede escribir en almacenamiento local
function storageWritesAllowed() {
  return getStorageConsent();
}

// --- AUTENTICACIÓN ---
function getToken() { try { return localStorage.getItem('th_token'); } catch { return null; } }
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
    // 503 (BD temporalmente no disponible) se devuelve como respuesta normal;
    // cada llamador decide si reintenta (apiFetchWithRetry) o muestra el error.
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
  // Accesibilidad WCAG 2.1: los toasts se anuncian a lectores de pantalla.
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

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

  // Evitar acumular toasts ilimitados: si hay demasiados, remover los más antiguos
  const existingToasts = document.querySelectorAll('.toast-message');
  if (existingToasts.length >= 6) {
    for (let i = 0; i < existingToasts.length - 5; i++) existingToasts[i].remove();
  }

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

// --- MODALES (con gestión de foco WCAG 2.1: focus trap, Escape y retorno de foco) ---
function getFocusableElements(container) {
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea, input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), iframe'
  )).filter(el => el.offsetParent !== null || el === document.activeElement);
}

function focusFirstInModal(modal) {
  const items = getFocusableElements(modal);
  if (items.length > 0) items[0].focus();
  else modal.setAttribute('tabindex', '-1'), modal.focus();
}

function releaseModalFocus(modal) {
  const handler = modal._escapeHandler;
  if (handler) {
    document.removeEventListener('keydown', handler, true);
    modal._escapeHandler = null;
  }
  modal.dataset.trapReady = '0';
}

function openModal(modal) {
  if (typeof modal === 'string') modal = document.getElementById(modal);
  if (!modal) return;
  if (modal.dataset.modalOpen === '1') return;
  modal.dataset.modalOpen = '1';
  modal.classList.add('show');

  // Recordar el elemento que tenía el foco para devolverlo al cerrar.
  if (!modal._lastFocused) {
    modal._lastFocused = document.activeElement || document.body;
  }

  if (modal.dataset.trapReady !== '1') {
    modal.dataset.trapReady = '1';
    if (!modal._escapeHandler) {
      modal._escapeHandler = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          const cancelBtn = modal.querySelector('.btn-close, .btn-close-modal, [data-close]');
          if (cancelBtn) {
            cancelBtn.click();
          } else {
            closeModal(modal);
          }
        }
        // Focus trap: mantiene el foco dentro del modal (Tab/Shift+Tab)
        if (e.key === 'Tab') {
          const items = getFocusableElements(modal);
          if (items.length === 0) return;
          const first = items[0];
          const last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      };
      document.addEventListener('keydown', modal._escapeHandler, true);
    }
  }

  requestAnimationFrame(() => focusFirstInModal(modal));
}

function closeModal(modal) {
  if (typeof modal === 'string') modal = document.getElementById(modal);
  if (!modal) return;
  modal.classList.remove('show');
  modal.dataset.modalOpen = '0';
  if (modal.id === 'modal-view-pdf') {
    const iframe = modal.querySelector('iframe');
    if (iframe) { iframe.src = ''; iframe.style.display = 'block'; }
    const downloadMsg = iframe?.parentElement?.querySelector('.download-fallback-msg');
    if (downloadMsg) downloadMsg.style.display = 'none';
  }
  releaseModalFocus(modal);
  // Devolver el foco al elemento que abrió el modal (cuando el modal sigue en el DOM).
  if (document.body.contains(modal) && modal._lastFocused) {
    const prev = modal._lastFocused;
    modal._lastFocused = null;
    if (document.body.contains(prev) && prev.focus) prev.focus();
  }
}

// Cierra el modal si el usuario hace clic en el fondo oscuro (backdrop).
function attachModalBackdropClose(modalEl) {
  const modal = typeof modalEl === 'string' ? document.getElementById(modalEl) : modalEl;
  if (!modal) return;
  modal.addEventListener('click', function onClick(ev) {
    if (ev.target === modal) closeModal(modal);
  });
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

// Formatea una fecha ISO/timestamp de forma segura; devuelve '—' si es inválida.
function formatDate(value, opts, fallback = '—') {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return fallback;
  return opts && opts.timeStyle ? parsed.toLocaleString('es-CO', opts) : parsed.toLocaleDateString('es-CO', opts);
}

function populateDropdown(selectId, items, defaultVal, defaultText, keyField = 'id', textField = 'name') {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = '';
  if (!Array.isArray(items)) return;
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
  const btn = document.querySelector(btnSelector);
  if (!btn) return;
  if (btn.dataset.themeToggleReady === '1') return;
  btn.dataset.themeToggleReady = '1';
  btn.addEventListener('click', () => {
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

// Enlaza la barra de fortaleza de contraseña a un input (usado en activate.html y forgot-password.html).
function bindPasswordStrengthMeter(inputId, barId, textId) {
  const input = document.getElementById(inputId);
  const bar = document.getElementById(barId);
  const text = document.getElementById(textId);
  if (!input || !bar || !text) return;
  input.addEventListener('input', () => {
    const result = evaluatePasswordStrength(input.value);
    bar.className = 'strength-bar';
    if (result.level !== 'none') bar.classList.add(result.level);
    text.textContent = result.text;
    text.style.color = result.color;
  });
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

async function openPdfViewer(iframeId, filename, folder) {
  const iframe = document.getElementById(iframeId);
  if (!iframe) return;
  const ext = (filename || '').split('.').pop().toLowerCase();
  const viewableTypes = ['pdf','jpg','jpeg','png','gif','bmp','tiff','tif','txt'];
  const canViewInline = viewableTypes.includes(ext);
  // URL sin token: la autenticación viaja por cabecera Authorization (apiFetch).
  let url = `/api/document-file/${encodeURIComponent(filename)}`;
  const params = new URLSearchParams();
  if (folder) params.set('folder', folder);
  const qs = params.toString();
  if (qs) url += '?' + qs;

  let downloadMsg = iframe.parentElement.querySelector('.download-fallback-msg');
  if (!downloadMsg) {
    downloadMsg = document.createElement('div');
    downloadMsg.className = 'download-fallback-msg';
    downloadMsg.style.cssText = 'display:none;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;text-align:center;color:var(--text-secondary);padding:40px;';
    iframe.parentElement.appendChild(downloadMsg);
  }

  // Revocar Blob URL anterior si la hay
  if (iframe._blobUrl) { URL.revokeObjectURL(iframe._blobUrl); iframe._blobUrl = null; }

  try {
    const res = await apiFetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    iframe._blobUrl = blobUrl;

    if (canViewInline) {
      iframe.style.display = 'block';
      iframe.src = blobUrl;
      downloadMsg.style.display = 'none';
    } else {
      iframe.style.display = 'none';
      downloadMsg.style.display = 'flex';
      downloadMsg.innerHTML = renderPdfFallback(filename, blobUrl);
    }
  } catch (e) {
    console.error('No se pudo cargar el archivo:', e);
    if (iframe._blobUrl) { URL.revokeObjectURL(iframe._blobUrl); iframe._blobUrl = null; }
    iframe.style.display = 'block';
    iframe.srcdoc = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:12px;color:var(--text-secondary);font-size:14px;text-align:center;padding:24px;">
        <h3 style="margin:0;">No se pudo cargar el archivo</h3>
        <p style="margin:0;">Compruebe su conexión y vuelva a intentarlo.</p>
      </div>`;
  }
}

function closePdfViewer(iframeId, modalEl) {
  const iframe = document.getElementById(iframeId);
  if (iframe) {
    if (iframe._blobUrl) { URL.revokeObjectURL(iframe._blobUrl); iframe._blobUrl = null; }
    iframe.removeAttribute('src');
    iframe.src = '';
    iframe.style.display = 'block';
  }
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
  if (dropArea.dataset.dragDropReady === '1') return;
  dropArea.dataset.dragDropReady = '1';

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

// --- TIMEOUT POR INACTIVIDAD ---
(function initInactivityTimeout() {
  const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos
  let timer = null;
  let warningTimer = null;
  let warningEl = null;

  function resetTimer() {
    clearTimeout(timer);
    clearTimeout(warningTimer);
    removeWarning();
    timer = setTimeout(showWarning, TIMEOUT_MS);
  }

  function showWarning() {
    if (warningEl) return;
    warningEl = document.createElement('div');
    warningEl.id = 'inactivity-warning';
    warningEl.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:99998;" id="inactivity-backdrop"></div>
      <div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;border-radius:12px;padding:32px 36px;z-index:99999;box-shadow:0 12px 40px rgba(0,0,0,0.25);text-align:center;max-width:400px;width:90%;">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#f39c12" stroke-width="2" style="margin-bottom:12px;">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        <h3 style="margin:0 0 8px;color:#333;font-size:18px;">Sesión por expirar</h3>
        <p style="margin:0 0 20px;color:#666;font-size:14px;">Su sesión se cerrará en <strong id="inactivity-countdown">30</strong> segundos por inactividad.</p>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button class="btn btn-secondary" id="inactivity-stay" style="padding:10px 24px;">Continuar</button>
          <button class="btn btn-primary" id="inactivity-logout" style="padding:10px 24px;">Cerrar sesión</button>
        </div>
      </div>`;
    document.body.appendChild(warningEl);

    let remaining = 30;
    const countdownEl = document.getElementById('inactivity-countdown');
    const countdownInterval = setInterval(() => {
      remaining--;
      if (countdownEl) countdownEl.textContent = remaining;
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        logout();
      }
    }, 1000);

    document.getElementById('inactivity-stay').addEventListener('click', () => {
      clearInterval(countdownInterval);
      resetTimer();
    });
    document.getElementById('inactivity-logout').addEventListener('click', () => {
      clearInterval(countdownInterval);
      logout();
    });
  }

  function removeWarning() {
    if (warningEl) { warningEl.remove(); warningEl = null; }
  }

  function isLoggedIn() {
    return !!getToken();
  }

  ['mousemove', 'keydown', 'scroll', 'touchstart', 'click'].forEach(event => {
    document.addEventListener(event, () => {
      if (isLoggedIn()) resetTimer();
    }, { passive: true });
  });

  if (isLoggedIn()) resetTimer();
})();

