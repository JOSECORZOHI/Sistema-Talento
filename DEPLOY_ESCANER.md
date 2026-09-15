# Despliegue local por funcionario — PCs con escáner

El escáner es un equipo físico: **solo funciona cuando este servidor corre en el mismo
Windows donde están los drivers de la multifuncional (EPSON Scan 2 / WIA)**. La versión de
Railway (nube) no tiene escáner y nunca podrá verlo.

Con **varios funcionarios** separados y con escáneres posiblemente distintos (EPSON DS-530,
otras multifuncionales, etc.), cada funcionario usa una **instancia local propia** en su PC,
apuntando a la misma base MongoDB Atlas. Así:

- Cada PC reconoce su propio escáner (WIA detecta el dispositivo conectado a *esa* máquina).
- La bandeja de escáner está **etiquetada por funcionario**: los PDFs que escanea A solo los
  ve y registra A; admin ve todo (bandeja global).
- Al registrar, el sistema fuerza `employeeId` = el funcionario autenticado, así que los
  documentos nunca se mezclan.

## Archivos de este despliegue

- `.env`: configuración de esa instancia (misma BD, mismo `JWT_SECRET` y `DOC_ENC_KEY`).
- `bandeja_escaner/`: carpeta local de ese PC donde queda el PDF pendiente de registrar.
- `iniciar-escanner.ps1`: script que valida Node, instala dependencias si falta y levanta
  el servidor en `http://localhost:PORT` (por defecto `3000`).

## Preparar el PC de un funcionario (una sola vez por PC)

1. **Instalar Node.js 18 o superior** (LTS) desde https://nodejs.org — marcar también
   "Add to PATH" durante la instalación.
2. **Descargar el código**: abrir PowerShell y ejecutar
   ```powershell
   git clone https://github.com/JOSECORZOHI/Sistema-Talento.git
   cd Sistema-Talento
   ```
3. **Crear el archivo `.env`**: copiar `.env.example` a `.env` y completar con los
   mismos valores de producción que tiene Railway. Los imprescindibles son:
   - `DATABASE_URL` = cadena de conexión de MongoDB Atlas (idéntica a producción;
     el PC necesita acceso de red a Atlas).
   - `DATABASE_NAME` = `talento_humano` (mismo valor).
   - `JWT_SECRET` = el mismo secreto que usa Railway (importante: los inicios de
     sesión por ambos lados deben usar el mismo secreto).
   - `DOC_ENC_KEY` = **el mismo valor de producción**, para poder descifrar los
     documentos sensibles ya guardados. Si difiere, el servidor no arranca en
     producción, pero aquí no descifrará bien los PDFs.
   - `PORT` = `3000` (o uno distinto por PC si comparten la misma red).
   - `APP_BASE_URL` = en blanco (uso local) o `http://localhost:3000`.
   - SMTP/Gmail: se pueden dejar vacíos (la sincronización de correo se hace en
     Railway; el SMTP solo falta si se quieren enviar correos desde este PC).
4. **Instalar dependencias**:
   ```powershell
   npm install
   ```

## Poner a escanear (cada vez)

```powershell
npm start
```
Abra `http://localhost:3000` en ese mismo PC y entre con el usuario del funcionario.
En la pestaña **Escáner** use los botones "Escanear Documento" (WIA, una hoja) o
"Abrir EPSON Scan 2" (ADF para varias hojas) según el equipo.

## Aislamiento (cómo lo garantiza el sistema)

- El botón "Escanear Documento" (WIA) guarda el PDF en GridFS con la etiqueta
  `ownerEmployeeId` del funcionario autenticado. Solo ese funcionario lo ve en su bandeja.
- Los PDFs que deja EPSON Scan 2 en `bandeja_escaner/` de ese PC solo los ve quien usa ese PC.
- El registro por funcionario fuerza el `employeeId` propio: no se puede registrar un
  archivo de otro funcionario ni asignarlo a otra persona.
- Admin (Railway o su propio PC local) ve y puede registrar la **bandeja global** de todos.

## Notas

- Los archivos escaneados que se registran quedan en GridFS (BD Atlas), igual que en
  producción, y se pueden consultar desde cualquier instancia del sistema.
- Para detener el servidor: `Ctrl+C` en la ventana de PowerShell.
- Otros computadores de la red podrían entrar a `http://IP-DEL-PC:PORT` mientras el
  servidor esté corriendo (Windows pedirá autorizar el acceso en el firewall). Si esa
  PC va a atender a más de un funcionario, usaría la bandeja global de esa instancia.