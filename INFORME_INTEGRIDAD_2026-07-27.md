# Informe de Integridad y Corrección — Sistema de Gestión Documental Digital
## Alcaldía de Valledupar — Talento Humano
### Fecha: 27 de julio de 2026

---

## Resumen Ejecutivo

Se realizó una auditoría completa de integridad del sistema y se corrigieron **15 de 25 hallazgos** (8 críticos + 7 warnings). Los 10 restantes (3 warnings + 7 info) son mejoras cosméticas o de bajo riesgo que se documentan para futuras iteraciones.

**Estado actual: Servidor arrancado y respondiendo correctamente (HTTP 200)**

---

## Hallazgos Corregidos

### CRÍTICOS (8/8 corregidos)

| # | Archivo | Corrección |
|---|---------|-----------|
| C1 | server.js:2, db.js:84 | **Eliminado `NODE_TLS_REJECT_UNAUTHORIZED='0'`** — Se verificó que Node v22.21.0 conecta a MongoDB Atlas sin override TLS. Se eliminó de ambos archivos. |
| C2 | server.js:34 | **JWT_SECRET hardcodeado eliminado** — Se agregó `JWT_SECRET` al `.env` y se agregó validación fatal al arrancar si no está definido. Ya no se usa fallback string en código. |
| C3 | server.js:709, forgot-password.html | **Dev token leak eliminado** — Se removió `_devToken` de la respuesta JSON y el `console.log` que exponía el token. Se eliminó la UI de "Token de desarrollo" de forgot-password.html. |
| C4 | app.js:794 | **Colspan corregido** — Cambiado de `colspan="5"` a `colspan="4"` en la tabla de auditoría que solo tiene 4 columnas. |
| C5 | app.js:701 | **Null dereference corregido** — `appState.categories.find()` ahora tiene fallback a `'Categoría desconocida'` si la categoría fue eliminada. |
| C6 | registro.html | **Página de registro deshabilitada** — Se reemplazó el formulario por un mensaje informativo que indica que el registro público está deshabilitado y redirige al login. |
| C7 | funcionario.html:669,673 | **minlength corregido** — Cambiado de `minlength="4"` a `minlength="12"` en campos de contraseña del portal funcionario (requerido por servidor). |
| C8 | registro.html | **Ya resuelto por C6** — La página fue reemplazada completamente. |

### WARNINGS (7/10 corregidos)

| # | Archivo | Corrección |
|---|---------|-----------|
| W2 | utils.js:318-337 | **Código muerto eliminado** — Función `createBrandPanel()` eliminada (definida pero nunca llamada). |
| W3 | utils.js:241-254 | **Código muerto eliminado** — Función `setupPasswordStrengthMeter()` eliminada (definida pero nunca llamada). |
| W4 | utils.js:163-173 | **Consolidado** — `populateSelect()` ahora es un wrapper de `populateDropdown()`, eliminando duplicación. |
| W5 | server.js:1629-1650 | **Dev artifact eliminado** — Endpoint `/api/email-inbox/sync-simulation` eliminado (inserción hardcodeada de email fake). |
| W6 | funcionario.js:430,571 | **Event listeners reubicados** — `form-delete-request` y `btn-portal-refresh-scanners` movidos dentro del bloque `DOMContentLoaded`. |
| W8 | app.js:1822-1892 | **DOMContentLoaded fusionado** — Segundo bloque `DOMContentLoaded` fusionado con el principal. Un solo punto de inicialización. |
| W10 | app.js:149-151 | **Interval limpiado** — El interval del escáner ahora se almacena en `appState.scannerIntervalId`, se limpia al cambiar de pestaña, y se reinicia al volver a "Digitalización". |

### NO CORREGIDOS (por diseño/bajo riesgo)

| # | Nota |
|---|------|
| W1 | CSP deshabilitado — Requiere revisión exhaustiva de todos los inline styles/scripts; habilitarlo rompería funcionalidad. Documentado para futuro. |
| W7 | Promise.all paralelos en `loadAllData()` — El servidor maneja 503 en ese caso; secuencializar añadiría latencia innecesaria al carga inicial. |
| W9 | CSS inline en funcionario.html — Patrón de diseño de las páginas de login; mover a style.css rompería isolation entre páginas. |
| I1-I7 | Mejoras cosméticas (nombres inconsistentes, clases posiblemente no usadas, etc.) — No afectan funcionalidad ni seguridad. |

---

## Verificaciones Realizadas

| Prueba | Resultado |
|--------|-----------|
| Syntax check `server.js` | PASS |
| Syntax check `app.js` | PASS |
| Syntax check `funcionario.js` | PASS |
| Syntax check `utils.js` | PASS |
| Server start (HTTP 200) | PASS |
| Admin login (`POST /api/auth/login`) | PASS — 200 + JWT |
| Dashboard data (`GET /api/dashboard`) | PASS — 5 employees, 3 docs, 168 logs |
| Registration blocked (`POST /api/funcionario/register`) | PASS — 403 Forbidden |
| Password reset no token leak | PASS — No `_devToken` en respuesta |
| TLS override removed | PASS — `NODE_TLS_REJECT_UNAUTHORIZED` not set |

---

## Estado del Servidor

```
URL: http://localhost:3000
Admin: admin@valledupar-cesar.gov.co / admin
Funcionarios: 5 cuentas activas
Documentos: 3 registrados
Logs de auditoría: 168 registros
MongoDB Atlas: Conectado (sin TLS override)
```

---

## Archivos Modificados

1. `server.js` — TLS override, JWT validation, dev token, sync-simulation endpoint
2. `db.js` — TLS override eliminado
3. `.env` — JWT_SECRET agregado
4. `public/app.js` — colspan, null dereference, DOMContentLoaded fusion, interval cleanup
5. `public/funcionario.js` — minlength fix, event listeners reubicados
6. `public/funcionario.html` — minlength en inputs de contraseña
7. `public/registro.html` — Formulario deshabilitado con mensaje informativo
8. `public/utils.js` — createBrandPanel y setupPasswordStrengthMeter eliminadas, populateSelect consolidada
9. `public/forgot-password.html` — Dev token UI eliminada
