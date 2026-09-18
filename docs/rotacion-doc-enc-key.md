# Runbook: Rotación de la clave de cifrado (`DOC_ENC_KEY`)

La clave `DOC_ENC_KEY` cifra el contenido de los documentos guardados en GridFS
(revisado durante la auditoría de seguridad). Si se cambia sin reencifrar, los
documentos existentes quedarán ilegibles. Este runbook describe la rotación
segura en producción.

> Realizar preferentemente en horario de baja actividad. La reencripción
> es un proceso en lotes que puede tardar según el volumen de documentos.

## 1. Preparación

1. Acceder al proyecto: `railway link`.
2. Confirmar el estado de producción antes de empezar:
   ```powershell
   railway run curl -s https://sistema-talento-production.up.railway.app/api/health
   ```
   Debe responder `200`.

## 2. Respaldo de seguridad

1. Backup completo de la base y de GridFS con verificación incluida:
   ```powershell
   npm run backup
   ```
2. Comprobar que el `counts.json` del backup coincide con los conteos actuales:
   ```powershell
   npm run backup:verify
   ```
3. Anotar la fecha/hora y la colección de documentos. No sobrescribir este
   respaldo durante la rotación (conservarlo como punto de restauración).

## 3. Reencifrar con la clave nueva (dos fases)

El script `scripts/reencrypt-gridfs.js` reencifra los documentos a un prefijo
temporal y, al terminar, renombra los archivos. Así una interrupción a mitad
no deja documentos a medio descifrar bajo el nombre final.

1. Generar la clave nueva:
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. Ejecutar la reencripción con la clave nueva:
   ```powershell
   setx DOC_ENC_KEY "<clave_nueva_hex>"   # solo terminal local; la final va en Railway
   npm run reencrypt
   ```
3. Si el proceso falla a mitad, se puede reintentar: los archivos temporales se
   reencifran de nuevo y los ya terminados quedan intactos.

## 4. Publicar la clave nueva en producción

1. En Railway, Service Variables: guardar primero la clave **actual** si no está
   documentada (por si hay que revertir), y luego fijar `DOC_ENC_KEY` a la clave
   nueva.
2. Reiniciar el despliegue (Deploy → Restart o `railway up --restart`).
3. Verificar:
   ```powershell
   railway run curl -s https://sistema-talento-production.up.railway.app/api/health
   railway deployment list
   ```
4. Probar la descarga real de un documento en la aplicación (no solo el health
   check): el health no valida la clave de GridFS.

## 5. Confirmación final

- `/api/health` responde 200.
- `/api/system/status` muestra `database.connected: true` y sin errores
  recientes en `errors.recent`.
- Se descarga correctamente al menos un documento subido antes de la rotación
  (valida que la nueva clave lee los archivos renombrados).

## 6. Rollback (si algo falla)

1. Restaurar `DOC_ENC_KEY` anterior en Railway y reiniciar.
2. Si la reencripción dejó archivos a medio renombrar y los documentos no se
  leen, restaurar desde el backup tomado en el paso 2:
   ```powershell
   npm run backup:verify   # verificar la integridad del respaldo elegido
   mongorestore --nsFrom "th_restore_*.*" --nsTo "<db>.*" <carpeta_del_dump>
   ```

## Notas

- `DOC_ENC_KEY` debe tener 64 caracteres hexadecimales (32 bytes).
- El cambio de `DOC_ENC_KEY` NO invalida sesiones ni contraseñas: solo afecta al
  contenido cifrado de documentos en GridFS.
- Se recomienda rotar la clave al menos una vez al año o tras una fuga de
  credenciales/backup.