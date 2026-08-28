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
- `database.json`: solo datos de referencia para la primera carga en la base remota.
- `storage/documentos/`: PDFs cargados y ya clasificados.
- `storage/gmail_adjuntos/`: PDFs descargados desde Gmail pendientes de registrar.
- `bandeja_escaner/`: PDFs pendientes de clasificar desde el escáner.
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

Abra `/api/gmail/authorize` para autorizar la cuenta. Después, use la opción de sincronización en la bandeja de correo para descargar PDFs adjuntos a `storage/gmail_adjuntos/` y registrarlos en el sistema. Si el remitente coincide con el correo de un funcionario, se sugiere automáticamente al registrar.

## Operación y mantenimiento

- Realice copias de seguridad periódicas de la base MongoDB y `storage/documentos/`.
  - `npm run backup` crea un `mongodump` comprimido (colecciones + GridFS) en `backups/`
    usando `DATABASE_URL` del `.env` y conserva los 10 más recientes (requiere
    `mongodb-database-tools`, es decir, el comando `mongodump`, en el PATH).
- Comandos de calidad y prueba: `npm test` (pruebas con `node:test`) y `npm run lint` (ESLint).
- Mantenga el acceso al equipo y a las credenciales de Gmail restringido a personal autorizado.
- Verifique que los PDFs se puedan abrir y que sus metadatos correspondan al expediente antes de archivarlos.
- Para actualizar dependencias, pruebe primero en un entorno de desarrollo y ejecute `npm.cmd audit`.
