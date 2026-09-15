# Despliegue local para el PC del escáner (alcaldía)

El escáner es un equipo físico: **solo funciona cuando este servidor corre en el mismo
Windows donde están los drivers de la multifuncional (EPSON Scan 2 / WIA)**. La versión de
Railway (nube) no tiene escáner y nunca podrá verlo.

La solución es ejecutar **una segunda instancia del servidor en ese PC**, apuntando a la
misma base de datos MongoDB Atlas. Así los PDFs escaneados se guardan en GridFS (la misma
BD de producción) y quedan visibles también en Railway.

## Preparar el PC del escáner (una sola vez)

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
   - `PORT` = `3000`
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
Abra `http://localhost:3000` en ese mismo PC y entre con el usuario administrador.
En la sección **Bandeja de escáner** use los botones "Escanear con WIA" o
"Abrir EPSON Scan 2" según el equipo.

## Notas

- Los archivos escaneados que se registran quedan en GridFS (BD Atlas), igual que en
  producción, y se pueden consultar desde cualquier instancia del sistema.
- La carpeta `bandeja_escaner/` es local a ese PC; ahí quedan los PDFs temporales.
- Para detener el servidor: `Ctrl+C` en la ventana de PowerShell.
- Otros computadores de la red podrían entrar a `http://IP-DEL-PC:3000` mientras el
  servidor esté corriendo (Windows pedirá autorizar el acceso en el firewall).