# Despliegue local por funcionario — PCs con escáner (Linux y Windows)

El escáner es un equipo físico: **solo funciona cuando este servidor corre en el mismo
equipo donde está configurado el escáner**. La versión de Railway (nube) no tiene
escáner y nunca podrá verlo.

- **Linux**: detección y escaneo vía SANE (`scanimage`), programa gráfico Simple Scan.
- **Windows**: detección WIA/PnP vía PowerShell, escaneo directo WIA o programa
  EPSON Scan 2.

Con **varios funcionarios** separados y con escáneres posiblemente distintos, cada
funcionario usa una **instancia local propia** en su PC, apuntando a la misma base
MongoDB Atlas. Así:

- Cada PC reconoce su propio escáner (el de *esa* máquina).
- La bandeja de escáner está **etiquetada por funcionario**: los PDFs que escanea A solo los
  ve y registra A; admin ve todo (bandeja global).
- Al registrar, el sistema fuerza `employeeId` = el funcionario autenticado, así que los
  documentos nunca se mezclan.

## Archivos de este despliegue

- `.env`: configuración de esa instancia (misma BD, mismo `JWT_SECRET` y `DOC_ENC_KEY`).
- `bandeja_escaner/`: carpeta local de ese PC donde queda el PDF pendiente de registrar.
- Arranque: `iniciar-escanner.sh` (Linux) o `iniciar-escanner.ps1` (Windows). Ambos
  validan Node, instalan dependencias si faltan y levantan el servidor en
  `http://localhost:PORT` (por defecto `3000`).

## Preparar el PC (una sola vez por PC)

`.env` común a ambos sistemas (misma BD, mismo `JWT_SECRET` y `DOC_ENC_KEY` que
producción/Railway; `DATABASE_NAME=talento_humano`; `PORT=3000`;
`APP_BASE_URL` en blanco o `http://localhost:3000`; SMTP/Gmail opcionales):

### Linux

1. **Instalar Node.js 20 o superior** y verificar con `node --version`.
2. **Instalar SANE y las herramientas de escaneo**:
   ```bash
   sudo apt install sane-utils simple-scan     # Debian/Ubuntu
   # Fedora: sudo dnf install sane-backends simple-scan
   # Arch/CachyOS: sudo pacman -S sane simple-scan
   scanimage -L   # debe listar el escáner; si no aparece, revise USB/red y drivers
   ```
   Para multifuncionales EPSON que necesiten su driver, instale además el paquete
   `imagescan`/`epsonscan2` del fabricante si `scanimage -L` no la detecta.
3. **Descargar el código**:
   ```bash
   git clone https://github.com/JOSECORZOHI/Sistema-Talento.git
   cd Sistema-Talento
   ```
4. Crear el `.env` (ver arriba) e instalar dependencias con `npm install`.

### Windows

1. **Instalar Node.js 20 o superior** (LTS) desde https://nodejs.org — marcar
   "Add to PATH" durante la instalación.
2. **Descargar el código**: abrir PowerShell y ejecutar
   ```powershell
   git clone https://github.com/JOSECORZOHI/Sistema-Talento.git
   cd Sistema-Talento
   ```
3. Crear el `.env` (ver arriba) e instalar dependencias con `npm install`.

## Poner a escanear (cada vez)

```bash
./iniciar-escanner.sh   # Linux
```
```powershell
.\iniciar-escanner.ps1  # Windows
# o en ambos: npm start
```
Abra `http://localhost:3000` en ese mismo PC y entre con el usuario del funcionario.
En la pestaña **Escáner**:
- **Linux**: botón "Escanear Documento" (SANE directo, una hoja a 200 dpi) o el botón
  del programa de escaneo (p. ej. Simple Scan: escanee y guarde el PDF en `bandeja_escaner/`).
- **Windows**: botón "Escanear Documento" (WIA, una hoja) o "Abrir EPSON Scan 2"
  (ADF para varias hojas) según el equipo.

## Aislamiento (cómo lo garantiza el sistema)

- El botón "Escanear Documento" guarda el PDF en GridFS con la etiqueta
  `ownerEmployeeId` del funcionario autenticado. Solo ese funcionario lo ve en su bandeja.
- Los PDFs que deja el programa de escaneo en `bandeja_escaner/` se adoptan al primer
  avistamiento por el funcionario que abre su bandeja (el admin ve la bandeja global).
- El registro por funcionario fuerza el `employeeId` propio: no se puede registrar un
  archivo de otro funcionario ni asignarlo a otra persona.
- Admin (Railway o su propio PC local) ve y puede registrar la **bandeja global** de todos.

## Notas

- Los archivos escaneados que se registran quedan en GridFS (BD Atlas), igual que en
  producción, y se pueden consultar desde cualquier instancia del sistema.
- Para detener el servidor: `Ctrl+C` en la terminal.
- Otros computadores de la red podrían entrar a `http://IP-DEL-PC:PORT` mientras el
  servidor esté corriendo (abra el puerto en el firewall: `sudo ufw allow 3000/tcp`
  en Linux; Windows pedirá autorizar el acceso). Si esa PC va a atender a más de un
  funcionario, usaría la bandeja global de esa instancia.
- El backup automático se programa con `npm run backup:cron` (Linux, cron) o
  `npm run backup:task` (Windows, Tarea Programada, ejecutar PowerShell como
  Administrador).
