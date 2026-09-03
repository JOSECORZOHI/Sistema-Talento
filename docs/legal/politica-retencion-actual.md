# Política de retención documental — estado actual y discrepancia

**Documento informativo.** No modifica comportamiento: describe la configuración vigente del
sistema y una discrepancia detectada entre la lógica de purga y el catálogo legacy de retención.

---

## 1. Cómo funciona la retención en producción (comportamiento real)

- **Variable:** `DOC_RETENTION_DAYS` (en días). **Valor por defecto: 3650 (10 años)**.
- **Proceso:** `runDocumentRetention()` recorre al arranque y luego cada 24 h todas las
  colecciones (`users`, `employees`, `documents`, `auditLogs`, `securityLogs`) y **elimina física y
  definitivamente** los registros cuyo campo `registeredAt` sea anterior a `hoy − retención` y cuyo
  `status` sea **`Archivado`** o **`Eliminado`** (`server.js:3695` en adelante).
- **Vinculado al cumplimiento:** Ley 594/2000 (gestión documental) y Ley 1581/2012 (derecho al
  olvido / supresión). La purga de datos en estado Archivado o Eliminado materializa la supresión.

> El periodo de retención aplicado es **global** (un solo valor `DOC_RETENTION_DAYS`) y se cuenta
> desde `registeredAt`. No distingue entre tipos de documento ni series documentales.

## 2. Discrepancia detectada con el catálogo legacy (`database.json`)

El archivo `database.json` (semilla de referencia del modelo anterior, **no** se usa como fuente
de verdad en producción) sugiere una retención **por tipo de documento** en años:

| Tipo de documento (`id`) | `retentionYears` (legacy) |
| --- | --- |
| `hoja-vida` | 80 años |
| `contrato` | 20 años |
| `certificado` | 10 años |
| `incapacidad` | 10 años |
| `evaluacion` | 10 años |
| `otro` | 5 años |

**No hay ningún código en producción que lea estos `retentionYears`.** La purga real usa solo
`DOC_RETENTION_DAYS` global. Por tanto hay una divergencia conceptual:
- El catálogo legacy sugiere que la hoja de vida conserva 80 años y "otro" 5 años.
- La lógica real retiene todo 10 años por defecto, sin distinguir.

## 3. Implicación operativa

- La retención actual es **más corta que la TRD sugerida** para series de larga duración (hoja de
  vida: 10 vs. 80 años; contrato: 10 vs. 20 años). Si la TRD oficial exige plazos mayores, la
  purga **borraría documentos que deberían conservarse**.
- A la inversa, para "otro documento" (5 años legacy) el sistema actual retiene más (10 años), lo
  cual retiene datos personales por más tiempo del estrictamente necesario (cuestión de
  minimización, art. 4 lit. g Ley 1581).

## 4. Recomendaciones (NO ejecutadas — pendiente decisión del operador)

1. **Alinear el periodo**: el gestor documental debe definir `DOC_RETENTION_DAYS` conforme a la
   **TRD oficial aprobada** por la entidad (documento `validacion-retencion-documental.md`).
2. **Evaluar si se requiere retención diferencial por serie**: si la TRD impone plazos distintos
   por tipo de documento, conviene evolucionar de `DOC_RETENTION_DAYS` (global) a una retención por
   tipo (los `retentionYears` de `database.json` son un punto de partida), refinada a serie/serie.
3. **Revisar `status` sujeto a purga**: hoy se purgan `Archivado` y `Eliminado`. Confirmar que esa
   semántica coincide con la TRD (no borrar accidentamente documentos con valor jurídico vigente).

**Estado:** documento informativo. Ningún cambio de código se ha aplicado.