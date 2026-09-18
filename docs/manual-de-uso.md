# Manual de Uso — Sistema de Gestión Documental

**Oficina de Talento Humano · Alcaldía de Valledupar · Versión 1.0 · Septiembre 2026**

Acceso en producción: `https://sistema-talento-production.up.railway.app`

> La versión imprimible (PDF) de este manual está disponible en el propio sistema:
> **/manual-uso.html**.

---

## 1. Acerca del sistema

El Sistema de Gestión Documental permite a la Oficina de Talento Humano registrar,
clasificar y resguardar los documentos (principalmente PDF) de los funcionarios
municipales, integrando el **escáner local**, el **portal del funcionario** y la
**bandeja de correo institucional (Gmail)**.

Dos portales:

| Portal | Usuario | Finalidad |
|---|---|---|
| Panel de Administración `/admin.html` | Administrador | Registrar funcionarios, administrar y clasificar documentos, consultar, auditar y gestionar eliminaciones. |
| Portal del Funcionario `/funcionario.html` | Funcionario | Consultar su expediente, subir documentos, escanear y revisar su correo. |

Requisitos: navegador Chrome, Edge o Firefox (escritorio). La contraseña es de
mínimo 8 caracteres con mayúscula, minúscula y número.

---

## 2. Inicio de sesión

1. Abra la dirección del sistema.
2. Ingrese **correo institucional** y **contraseña**, y presione **Iniciar sesión**.
3. Si el administrador habilitó 2FA, digite el **código de 6 dígitos** de su
   aplicación de autenticación (Google/Microsoft Authenticator).

### 2.1 Configurar 2FA (administrador)

1. En **Privacidad y acceso seguro** seleccione **Configurar 2FA**.
2. Escanee el **código QR** con la aplicación o pegue el enlace `otpauth`.
3. Confirme el secreto digitando los 6 dígitos.

### 2.2 Olvidé mi contraseña

1. En la pantalla de inicio presione **¿Olvidó su contraseña?**.
2. Escriba su correo y **Restablecer**.
3. Siga el enlace recibido (válido por tiempo limitado) y defina una contraseña nueva.

---

## 3. Panel del Administrador

### 3.1 Dashboard

Resumen con total de documentos, estados, funcionarios, archivos sin registrar,
actividad reciente y eliminaciones pendientes.

### 3.2 Consultas

- **Búsqueda** por nombre del funcionario, cédula o nombre de archivo.
- **Filtros** por tipo de documento, categoría y estado.
- Al abrir un resultado (visor PDF): **ver**, **descargar**, **cambiar estado**
  (Pendiente / En trámite / Archivado), **archivar**, u **ocultar/mostrar** al funcionario.

### 3.3 Registrar y Subir

Bandeja de **archivos sin registrar** (con contador en el menú):

- **Escáner (`bandeja_escaner/`)**: documentos detectados en la carpeta del escáner.
  El sistema **sugiere tipo, categoría, fecha y funcionario** mediante análisis automático.
- **Adjuntos de correo**: archivos llegados como adjuntos de Gmail.
- **Subida manual**: arrastre y suelte o use el botón **Subir**.

### 3.4 Funcionarios

- **Registrar funcionario**: nombre, correo, cédula, cargo y dependencia; se genera la
  clave temporal y se envía el correo de activación.
- **Editar** y **cambiar estado** (activo / inactivo / suspendido).
- **Restablecer contraseña** del funcionario.

### 3.5 Expedientes

Consulte el **expediente completo** por funcionario y realice acciones de visibilidad
y estado sobre cada documento.

### 3.6 Seguimiento

Auditoría de acciones (inicios de sesión, cambios de estado, activaciones de 2FA,
eliminaciones, etc.) con usuario, fecha e IP, para trazabilidad.

### 3.7 Eliminaciones

Solicitudes de eliminación: **Aprobar** elimina el documento; **Rechazar** lo conserva.

### 3.8 Panel de estado del sistema

Desde su perfil acceda al **estado del sistema**: conexión a base de datos, índices,
Gmail, escáner, eventos de seguridad de las últimas 24 horas y errores recientes.

---

## 4. Portal del Funcionario

### 4.1 Mis Documentos

Muestra los documentos de su expediente. **Ver** abre el visor PDF y permite descargar.
Solo se muestran los visibles para el funcionario.

### 4.2 Subir documentación

Arrastre y suelte un archivo (o selecciónelo) y presione **Subir**. Queda pendiente de
clasificación por el administrador.

### 4.3 Escáner

El sistema detecta el escáner conectado y permite digitalizar directamente al portafolio.
Los archivos quedan en **Escáneres detectados**.

### 4.4 Correo

1. **Vincular cuenta**: autorice el acceso a su correo institucional (Google).
2. **Sincronizar**: importa correos y adjuntos (solo lectura).
3. Los adjuntos quedan como documentos sin registrar para su incorporación.

### 4.5 Solicitud de eliminación

Desde sus documentos puede **solicitar eliminar** uno; queda en **Seguimiento** hasta
que el administrador lo apruebe o rechace.

### 4.6 Configuración

- **Cambiar contraseña** (requiere la contraseña actual y una nueva).
- **Datos personales**: nombre y correo de contacto.

---

## 5. Seguridad y privacidad

- Documentos cifrados (AES-256-GCM); sesión en cookie segura y de solo HTTP.
- Contraseñas con hash seguro; datos personales tratados conforme a la Ley 1581 de 2012
  y a las políticas del sitio (`/privacy.html`, `/terms.html`, `/accesibilidad.html`).

---

## 6. Respaldo y continuidad

- Backup automático diario (02:00) con **prueba de restauración**.
- Restauración y procedimientos en `docs/runbooks`.

---

## 7. Problemas frecuentes

| Problema | Solución |
|---|---|
| No recibo el correo de activación | Revise spam y vuelva a solicitar el envío. |
| "Secreto de 2FA inválido" | Genere un QR nuevo en la pestaña 2FA. |
| No veo un documento | Solicite al administrador hacerlo visible. |
| El escáner no apareció | Conecte el escáner, instale el controlador y reabra la pestaña. |
| Error de sincronización de correo | Verifique el permiso de la cuenta vinculada. |
| "Error temporal de base de datos" | Reintente en unos segundos. |
