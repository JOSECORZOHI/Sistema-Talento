// Analizador local de documentos: extrae texto (PDF/DOCX/TXT/imágenes vía OCR Tesseract)
// y sugiere tipo, categoría, funcionario y fecha de emisión mediante reglas por palabras
// clave. Sin APIs externas: todo corre en el servidor, gratis y sin enviar datos personales.

const path = require('path');
const { pathToFileURL } = require('url');
const mammoth = require('mammoth');
const { createWorker, PSM } = require('tesseract.js');

// --- PDF.js v4 (extracción de capa de texto) + mupdf WASM (rasterizado escaneados),
//     ambos sin dependencias nativas de sistema ---
let pdfjsPromise = null;
const PDFJS_BASE = path.dirname(require.resolve('pdfjs-dist/legacy/build/pdf.mjs'));

function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs')
      .then((mod) => {
        if (mod.GlobalWorkerOptions) {
          mod.GlobalWorkerOptions.workerSrc = pathToFileURL(PDFJS_BASE + '/pdf.worker.mjs').href;
        }
        return mod;
      })
      .catch((e) => { pdfjsPromise = null; throw e; });
  }
  return pdfjsPromise;
}

async function extractPdfText(buffer) {
  const lib = await getPdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
  let text = '';
  try {
    const pageCount = Math.min(doc.numPages, 10);
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      text += (content.items || []).map(i => (i && i.str) || '').join(' ') + '\n';
    }
  } finally {
    try { await doc.destroy(); } catch {}
  }
  return text;
}

async function pdfToPngImages(buffer, maxPages = 2, scale = 2) {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(new Uint8Array(buffer), 'application/pdf');
  const images = [];
  const pageCount = Math.min(doc.countPages(), maxPages);
  try {
    for (let p = 0; p < pageCount; p++) {
      const page = doc.loadPage(p);
      const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
      const png = pixmap.asPNG();
      images.push(Buffer.from(png));
    }
  } finally {
    try { doc.destroy(); } catch {}
  }
  return images;
}

let mupdfPromise = null;
function getMupdf() {
  if (!mupdfPromise) {
    mupdfPromise = import(
      pathToFileURL(path.join(__dirname, 'node_modules', 'mupdf', 'dist', 'mupdf.js')).href
    ).catch((e) => { mupdfPromise = null; throw e; });
  }
  return mupdfPromise;
}

// --- OCR (Tesseract, español) ---
let ocrWorkerPromise = null;
let ocrQueue = Promise.resolve();

function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker('spa', 1, { cacheMethod: 'none' })
      .then(async (worker) => {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
        return worker;
      })
      .catch((e) => {
        ocrWorkerPromise = null;
        throw e;
      });
  }
  return ocrWorkerPromise;
}

// Serializa las llamadas de OCR para no saturar el worker único
function ocrImage(buffer) {
  const task = ocrQueue.then(async () => {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(buffer);
    return (data && data.text) || '';
  });
  ocrQueue = task.catch(() => {});
  return task;
}

// Pre-carga el modelo de Tesseract (spa) en segundo plano al arrancar el servidor:
// crea y memoriza el worker único (lo reutiliza el primer análisis real). Evita
// reconocer texto de muestra, porque una entrada no-imagen dispara una excepción
// interna de tesseract.js imposible de capturar (crash del proceso).
async function warmupOcr() {
  try {
    await getOcrWorker();
    return true;
  } catch (e) {
    console.warn('[OCR] Warmup falló (se reintentará en el primer análisis):', e.message);
    return false;
  }
}

// --- Extracción de texto por tipo de archivo ---
function parseTextContent(buffer) {
  return buffer.toString('latin1').replace(/[^\x20-\x7E\n\r\tÁÉÍÓÚÜÑáéíóúüñ]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function extractText(buffer, filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const extMap = {
    pdf: 'pdf', docx: 'docx', doc: 'doc', txt: 'txt',
    png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', bmp: 'img', tif: 'img', tiff: 'img'
  };
  const kind = extMap[ext] || null;
  if (!kind) return null;

  try {
    if (kind === 'pdf') {
      let text = '';
      try {
        text = await extractPdfText(buffer);
      } catch { text = ''; }
      if (text.trim().length >= 40) return { text, ocrUsed: false };
      // PDF escaneado (imagen): rasterizar y aplicar OCR
      const pages = await pdfToPngImages(buffer);
      let ocrText = '';
      for (const img of pages) {
        try { ocrText += (await ocrImage(img)) + '\n'; } catch {}
      }
      return { text: ocrText.trim(), ocrUsed: true };
    }
    if (kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return { text: (result.value || '').trim(), ocrUsed: false };
    }
    if (kind === 'txt') {
      let text = buffer.toString('utf8');
      if (/[\uFFFD]/.test(text)) text = buffer.toString('latin1');
      return { text: text.trim(), ocrUsed: false };
    }
    if (kind === 'doc') {
      return { text: parseTextContent(buffer), ocrUsed: false };
    }
    if (kind === 'img') {
      const text = await ocrImage(buffer);
      return { text: text.trim(), ocrUsed: true };
    }
  } catch (e) {
    console.error(`[ANALIZADOR] Error extrayendo texto de '${filename}':`, e.message);
  }
  return null;
}

// --- Clasificador por palabras clave (catálogo fijo del sistema) ---
const normalize = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const countHits = (text, keywords) => keywords.reduce((acc, k) => acc + (text.includes(k) ? k.split(' ').length : 0), 0);

const TYPE_RULES = [
  { id: 'hoja-vida', keywords: ['hoja de vida', 'curriculum', 'curriculum vitae', 'resumen profesional', 'perfil profesional', 'experiencia laboral', 'perfil ocupacional'] },
  { id: 'contrato', keywords: ['contrato laboral', 'contrato de trabajo', 'terminacion de contrato', 'clausula', 'acta de firmas', 'contratista', 'contrato'] },
  { id: 'incapacidad', keywords: ['incapacidad medica', 'incapacidad', 'dictamen', 'licencia de enfermedad', 'valoracion de incapacidad'] },
  { id: 'evaluacion', keywords: ['evaluacion de desempeno', 'evaluacion del desempeno', 'evaluacion anual', 'indicador de gestion', 'evaluacion de personal', 'desempeno laboral'] },
  { id: 'certificado', keywords: ['certificado laboral', 'certificacion laboral', 'certificado', 'certificacion', 'constancia laboral', 'constancia'] }
];

const CATEGORY_RULES = [
  { id: 'identificacion', keywords: ['cedula de ciudadania', 'cedula', 'tarjeta de identidad', 'acta de nacimiento', 'libreta militar', 'datos personales', 'registro civil', 'hoja de identidad'] },
  { id: 'vinculacion', keywords: ['certificado laboral', 'certificacion laboral', 'carta laboral', 'constancia laboral', 'nombramiento', 'acta de posesion', 'vinculacion laboral', 'prorroga', 'contrato laboral', 'contrato de trabajo', 'afiliacion al cargo'] },
  { id: 'formacion', keywords: ['titulo profesional', 'universidad', 'diploma', 'estudios', 'curso', 'capacitacion', 'formacion academica', 'experiencia laboral', 'hoja de vida', 'curriculum'] },
  { id: 'novedades', keywords: ['incapacidad', 'vacaciones', 'permiso', 'licencia', 'renuncia', 'retiro', 'novedad laboral', 'suspension'] },
  { id: 'desempeno', keywords: ['evaluacion de desempeno', 'desempeno laboral', 'meritos', 'evaluacion de personal', 'reconocimiento'] },
  { id: 'seguridad-social', keywords: ['seguridad social', 'eps', 'pension', 'arl ', 'cesantias', 'cesantias', 'parafiscales', 'aportes', 'salud ocupacional', 'riesgos laborales'] }
];

function classifyType(text) {
  let best = null;
  let bestScore = 0;
  for (const rule of TYPE_RULES) {
    const score = countHits(text, rule.keywords);
    if (score > bestScore) { bestScore = score; best = rule.id; }
  }
  return best || 'otro';
}

function classifyCategory(text) {
  let best = null;
  let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const score = countHits(text, rule.keywords);
    if (score > bestScore) { bestScore = score; best = rule.id; }
  }
  return best || 'vinculacion';
}

// --- Fechas ---
const MONTHS = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
const monthRx = 'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre';

function extractIssueDate(text) {
  const t = (text || '');
  const patterns = [
    { re: new RegExp('\\b(\\d{1,2})\\s+de\\s+(' + monthRx + ')\\s+de\\s+(\\d{4})\\b', 'i'), map: (m) => `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}` },
    { re: /\b(\d{4})-(\d{2})-(\d{2})\b/, map: (m) => `${m[1]}-${m[2]}-${m[3]}` },
    { re: /\b(\d{2})\/(\d{2})\/(\d{4})\b/, map: (m) => `${m[3]}-${m[2]}-${m[1]}` },
    { re: /\b(\d{2})-(\d{2})-(\d{4})\b/, map: (m) => `${m[3]}-${m[2]}-${m[1]}` }
  ];
  for (const { re, map } of patterns) {
    const m = re.exec(t);
    if (m) {
      const iso = map(m);
      const d = new Date(iso + 'T00:00:00');
      if (!isNaN(d.getTime())) return iso;
    }
  }
  return null;
}

// --- Funcionario por nombre o cédula ---
function extractEmployee(text, employees) {
  if (!employees || !employees.length || !text) return null;
  const normText = normalize(text);
  for (const emp of employees) {
    if (!emp || !emp.id) continue;
    const name = normalize(`${emp.name || ''} ${emp.lastName || ''}`).replace(/\s+/g, ' ').trim();
    if (name && normText.includes(name)) return emp.id;
    const id = normalize(String(emp.identification || emp.cc || emp.dni || '')).replace(/\s+/g, '');
    if (id && normText.includes(id)) return emp.id;
  }
  return null;
}

// --- API pública ---
async function analyzeFile(buffer, filename, options = {}) {
  const extracted = await extractText(buffer, filename);
  if (!extracted || !extracted.text) return null;

  const text = extracted.text;
  const normText = normalize(text);
  const suggestions = {
    documentTypeId: classifyType(normText),
    categoryId: classifyCategory(normText),
    issueDate: extractIssueDate(text),
    employeeId: extractEmployee(text, options.employees),
    description: text.replace(/\s+/g, ' ').trim().substring(0, 300)
  };
  return { suggestions, ocrUsed: extracted.ocrUsed, textLength: text.length };
}

module.exports = { analyzeFile, extractText, warmupOcr };