# VALIDACIÓN JURÍDICA DE LA CONFIGURACIÓN DE RETENCIÓN DOCUMENTAL
## Sistema de Gestión Documental — Talento Humano · Alcaldía de Valledupar

**Versión del documento:** 1.0
**Fecha:** septiembre de 2026
**Marco normativo de referencia:** Ley 594 de 2000, Acuerdo 002 de 2006 (AGN),
Ley 1581 de 2012 y Decreto 1377 de 2013.

---

## 1. Objeto

El presente documento analiza la coherencia jurídica de la política de **retención documental**
implementada en el Sistema de Gestión Documental de la Oficina de Talento Humano, con el fin de
ser revisado y suscrito por el profesional del derecho y/o el Comité de Archivo de la entidad.

La revisión se limita a la **configuración vigente del sistema**, no suple el deber de la entidad
de contar con una **Tabla de Retención Documental (TRD)** aprobada conforme al Acuerdo 002 de 2006
del Archivo General de la Nación.

---

## 2. Configuración implementada en el sistema

| Criterio | Valor implementado | Base en el código |
| --- | --- | --- |
| Periodo de retención por defecto | **3650 días (10 años)** | `DOC_RETENTION_DAYS` (default 3650) |
| Documentos sujetos a retención | Con estado **`Archivado`** o **`Eliminado`** | `runDocumentRetention()` |
| Criterio de vencimiento | `registeredAt` anterior al corte (hoy − retención) | `runDocumentRetention()` |
| Frecuencia de ejecución | Al arrancar del servicio y **diariamente** | `setInterval`, 24&nbsp;h |
| Naturaleza de la purga | Borrado definitivo del documento y su archivo físico (GridFS) | `deleteDocAndPhysicalFile()` |

El valor por defecto es **configurable** mediante la variable de entorno `DOC_RETENTION_DAYS`
(ver `.env.example`), por lo que la entidad puede alinear el plazo al que resulte de la TRD.
El cómputo se realiza a partir de `registeredAt` (fecha de registro del documento en el sistema),
no de la fecha de creación documental.

---

## 3. Análisis jurídico

### 3.1. Ley 594 de 2000 (Ley General de Archivos)
Establece la obligación de conservar los documentos conforme a las **tablas de retención
documental** y sus valores primarios y secundarios. La existencia de un plazo de retención
contrastado con la desvinculación del servicio o el archivo de los documentos es un instrumento
válido de gestión documental, siempre que responda a la TRD de la entidad.

### 3.2. Acuerdo 002 de 2006 (AGN)
Determina que las series y subseries documentales y sus respectivos **períodos de retención** se
fijan en la TRD, la cual debe ser **aprobada por el Comité de Archivo** de la entidad. El sistema
debe operar en concordancia con ese instrumento.

**Punto de atención:** el plazo predeterminado de 10 años es una referencia genérica. La entidad
deberá ajustar `DOC_RETENTION_DAYS` al plazo que fije la TRD para la serie documental de personal
y procesos que aloja el sistema, verificando que **no se purguen documentos antes de cumplir su
valor secundario** (histórico/administrativo) ni se conserven más allá de lo permitido.

### 3.3. Ley 1581 de 2012 y Decreto 1377 de 2013 (Protección de datos personales)
- **Art. 9 y 9-1 del Decreto 1377/2013:** los datos personales deben conservarse **el tiempo
  necesario** para cumplir la finalidad del tratamiento; una vez cumplida, deben suprimirse,
  salvo norma que exija conservarlos.
- La retención de documentos que contienen datos personales **no puede superar** el plazo
  necesario ni vulnerar el derecho de **supresión** (art. 8, lit. f, Ley 1581/2012).
- Por tanto, la política de retención del sistema debe ser **el límite máximo** de conservación y,
  a la vez, garantizar que se ejecute la **supresión** una vez vencida la finalidad.

**Conclusión preliminar:** la configuración es **jurídicamente coherente** en tanto la purga
automática busca no conservar indefinidamente documentos archivados o eliminados. Su implementación
debe sujetarse a la TRD vigente.

---

## 4. Recomendaciones para la entidad

1. **Armonizar el plazo**: definir `DOC_RETENTION_DAYS` conforme a la **TRD aprobada** por el
   Comité de Archivo para la serie correspondiente. No dejar el valor por defecto si la TRD
   señala uno distinto.
2. **Verificar la supresión**: confirmar que la purga de documentos que contienen **datos
   sensibles** (salud, seguridad social) cumple con la finalidad y los derechos del titular, dado
   el carácter facultativo y el tratamiento reforzado aplicado.
3. **Conciliación con la supresión total**: al eliminar un funcionario se suprime la totalidad de
   sus datos (art. 8, lit. f, Ley 1581/2012); la retención documental no debe impedir ese
   derecho cuando ya no exista finalidad que lo justifique.
4. **Contar con la TRD formalizada**: suscribir la TRD y obtener el concepto del profesional del
   derecho / Comité de Archivo, conservando la evidencia para fines de auditoría y de la SIC.
5. **Registrar las evidencias**: guardar la TRD, el acta de aprobación del Comité de Archivo y el
   presente documento firmado como soporte de la gestión documental.

---

## 5. Datos de la revisión jurídica (para completar y firmar)

- **Nombre del profesional del derecho / responsable de archivo:**
- **Cargo:**
- **Entidad:**
- **Fecha de la revisión:**
- **Concepto:**  (Favorable / Con observaciones / Desfavorable)

**Observaciones adicionales:**

<br>

**Firma:** ____________________________

---

*Este documento es un instrumento de apoyo. No constituye por sí mismo la formalización de la TRD ni
el cumplimiento integral de los deberes exigidos por la Ley 594 de 2000 y la Ley 1581 de 2012.*