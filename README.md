# Sistema de Gestión Documental — Talento Humano

Aplicativo web para registrar, clasificar, consultar y hacer seguimiento a los documentos digitales de los funcionarios de una organización.

## Funcionalidades

- Registro de funcionarios y consulta de sus expedientes.
- Carga de archivos PDF, clasificación por tipo y categoría, y metadatos de vigencia.
- Consulta por funcionario, tipo documental, categoría, estado y texto libre.
- Actualización, archivado y eliminación física controlada de documentos.
- Bandeja de escáner para incorporar documentos digitalizados.
- Bandeja de correo con integración opcional a Gmail para PDFs adjuntos.
- Trazabilidad mediante bitácora de auditoría y panel de indicadores.

## Requisitos y ejecución

Requiere Node.js 18 o superior y una instancia MongoDB accesible.

```powershell
npm.cmd install
# Copie .env.example a .env y complete DATABASE_URL y JWT_SECRET.
npm.cmd start
```

Abra `http://localhost:3000`. Para depurar desde VS Code, ejecute primero el servidor y luego use la configuración **Iniciar Chrome para localhost**.

La configuración se lee de `.env` (ver `.env.example`). `JWT_SECRET` es obligatorio; `APP_BASE_URL` debe definirse en producción para que los enlaces de correo no dependan del encabezado Host.

## Estructura de datos y archivos

- Base de datos remota en MongoDB (`DATABASE_URL`): usuarios, funcionarios, catálogos, metadatos de documentos y auditoría.
- Los **archivos** (PDFs cargados, adjuntos de correo y documentos escaneados al registrarse) se almacenan en **GridFS** dentro de MongoDB (`documentos.files`/`documentos.chunks`).
- `database.json`: solo datos de referencia para la primera carga en la base remota.
- `bandeja_escaner/`: carpeta local donde la multifunción (EPSON Scan 2 / WIA) deja los PDFs escaneados pendientes de clasificar. Es la única carpeta local del sistema y solo aplica en una máquina Windows con el escáner conectado.
- `public/`: interfaz web.

El sistema incluye catálogos y usuarios de ejemplo para facilitar la capacitación inicial. Sustitúyalos por los datos institucionales antes del despliegue.

## Acceso por correo electrónico

Los usuarios ingresan con su correo electrónico registrado. El sistema valida que el correo exista en la lista de usuarios autorizados o coincida con el correo de un funcionario registrado.

Opcionalmente, puede restringir el dominio de correo permitido configurando `ALLOWED_EMAIL_DOMAIN` en `.env`.

## Flujo de trabajo

1. Registre al funcionario si aún no existe.
2. Cargue el PDF o selecciónelo desde la bandeja del escáner/correo.
3. Asigne tipo documental, categoría, fecha de expedición y estado.
4. Consulte el expediente y actualice o archive el documento según corresponda.
5. Revise la bitácora para conocer las acciones realizadas.

## Integración opcional con Gmail

Habilite Gmail API en Google Cloud y configure estas variables antes de iniciar el servidor:

```powershell
$env:GMAIL_CLIENT_ID="..."
$env:GMAIL_CLIENT_SECRET="..."
$env:GMAIL_REDIRECT_URI="http://localhost:3000/api/gmail/oauth2callback"
$env:GMAIL_REFRESH_TOKEN="..."
```

Abra `/api/gmail/authorize` para autorizar la cuenta. Después, use la opción de sincronización en la bandeja de correo para descargar PDFs adjuntos. Los adjuntos se guardan en GridFS y quedan pendientes de registrar. Si el remitente coincide con el correo de un funcionario, se sugiere automáticamente al registrar.

## Operación y mantenimiento

- Realice copias de seguridad periódicas de la base MongoDB (incluye los archivos en GridFS).
  - `npm run backup` crea un `mongodump` comprimido (colecciones + GridFS) en `backups/`
    usando `DATABASE_URL` del `.env` y conserva los 10 más recientes (requiere
    `mongodb-database-tools`, es decir, el comando `mongodump`, en el PATH).
- Comandos de calidad y prueba: `npm test` (pruebas con `node:test`) y `npm run lint` (ESLint).
- Mantenga el acceso al equipo y a las credenciales de Gmail restringido a personal autorizado.
- Verifique que los PDFs se puedan abrir y que sus metadatos correspondan al expediente antes de archivarlos.
- Para actualizar dependencias, pruebe primero en un entorno de desarrollo y ejecute `npm.cmd audit`.

## Cumplimiento legal y estándares

El sistema incorpora medidas de protección de datos personales, seguridad y accesibilidad:

- **Protección de datos (Ley 1581/2012)**: el registro de funcionarios exige confirmar el
  consentimiento del titular (se guarda la fecha, cuenta e IP). Al eliminar un funcionario se
  ejecuta la supresión total de sus datos personales (documentos, correos, tokens, solicitudes),
  y los registros de auditoría/seguridad se anonimizan (`[ELIMINADO]`) conforme al derecho de
  supresión (art. 8, lit. f).
- **Aviso de privacidad y almacenamiento**: las páginas de `privacy.html`, `terms.html` y
  `accesibilidad.html` están enlazadas desde el ingreso, el panel de administración y el portal
  del funcionario. Antes de guardar datos en `localStorage`, se solicita el consentimiento del
  usuario mediante un banner. El aviso de privacidad cumple el art. 9 de la Ley 1581/2012
  (responsable, finalidad, tipos de datos, carácter facultativo de los datos sensibles,
  derechos del titular y canal de contacto).
- **Cifrado en reposo de datos sensibles**: los documentos que contienen datos sensibles (salud y
  seguridad social: tipos `incapacidad` y categorías `seguridad-social`, `novedades`,
  `identificacion`) se cifran transparentemente con **AES-256-GCM** antes de guardarse en GridFS y
  se descifran al leerse. La clave se define en `DOC_ENC_KEY` (base64 de 32 bytes); si no se
  configura, se deriva de `JWT_SECRET` (fallback menos robusto, ver `.env.example`).
- **Retención documental**: los documentos archivados vencen y se purgan automáticamente según
  `DOC_RETENTION_DAYS` (por defecto 3650 días) al arrancar y diariamente.
- **Seguridad (OWASP)**: helmet con Content-Security-Policy por *nonce* (sin `'unsafe-inline'`
  en `script-src`), verificación de certificado TLS en SMTP por defecto, y *allowlist* estricta
  del nombre de archivo del escáner. La contraseña temporal **no** se expone por la API salvo que
  se habilite explícitamente con `ALLOW_TEMP_PASSWORD_RESPONSE=true`. Las vulnerabilidades
  conocidas de `qs` se corrigen mediante un `override` a una versión parcheada (`^6.16.0`) sin
  migrar a Express 5; `npm audit` reporta **0 vulnerabilidades**.
- **Accesibilidad (WCAG 2.1 AA)**: enlace "Saltar al contenido", gestión de foco en modales
  (trap, `Esc` y retorno de foco), anuncio de toasts con `aria-live`, etiquetas en campos sin
  `<label>`, contraste de texto corregido y soporte de `prefers-reduced-motion`.

### Gestión de secretos (acción del operador)

Estas tareas no son de código y quedan a cargo del administrador de la plataforma:

1. Rotar periódicamente `JWT_SECRET`, `SMTP_PASS`, `GMAIL_CLIENT_SECRET` y `DOC_ENC_KEY`.
   Para `DOC_ENC_KEY` (cifrado en reposo): rote durante una ventana de mantenimiento y
   prevea descifrar/recifrar los documentos existentes con la nueva clave, no abandone la
   anterior hasta haber migrado todos los archivos.
2. Regenerar el `GMAIL_REFRESH_TOKEN` revocándolo en Google Cloud y reautorizando en
   `/api/gmail/authorize`.
3. En Railway, fijar estas variables en el panel **Variables** (no en `.env`).
4. Acotar los permisos del archivo `.env` al usuario del servicio.

### Inscripción en el RNBD (Registro Nacional de Bases de Datos — acción del operador)

Conforme al art. 25 de la Ley 1581/2012 y el Decreto 1377/2013, el tratamiento de datos
personales que realiza la entidad debe inscribirse en el **Registro Nacional de Bases de Datos
(RNBD)** administrado por la Superintendencia de Industria y Comercio (SIC). Esta es una gestión
administrativa formal (no de código). Datos básicos de la base de datos a registrar:

- **Responsable**: Alcaldía de Valledupar — Oficina de Talento Humano.
- **Nombre de la base de datos**: Sistema de Gestión Documental de Talento Humano.
- **Finalidad**: gestión, custodia y trazabilidad de los expedientes documentales y de personal de
  los funcionarios (ver `public/privacy.html`).
- **Tipos de datos**: identificación, laborales/nómina, documentos del expediente digital, datos
  sensibles de salud y seguridad social (tratados con autorización facultativa) y datos de
  acceso/auditoría.
- **Medidas de seguridad**: cifrado en reposo (AES-256-GCM) de documentos sensibles, autenticación,
  HTTPS y registros de auditoría.

> Inscríbase en el portal de la SIC (RNBD) y mantenga actualizada la política de tratamiento de
> datos personales; consérvela a disposición de los titulares. La información de contacto del
> responsable figura en `public/privacy.html`.

Véase `.env.example` para el detalle completo de variables y documentación.
