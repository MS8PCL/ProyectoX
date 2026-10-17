# Candidatos manuales y archivos por oferta

## Uso en la aplicación Windows

Desde la ficha de una oferta, pulsar **Añadir candidato**. También se puede usar **Proceso de selección → oferta → Importar**. Ambos accesos abren el mismo formulario, asociado a la oferta elegida.

**Todos los datos personales y adjuntos son opcionales:** nombre, apellidos, correo, fecha de nacimiento, carta, CV, certificados y archivos de interés. Se puede crear una candidatura vacía, o proporcionar solamente archivos. Los valores informados deben tener formato válido y respetar los límites de longitud.

- Se admiten PDF, Word y otros formatos, conservando su nombre original en la metadata y en las exportaciones.
- **50 MiB por archivo y 64 MiB por formulario**, hasta 128 partes multipart incluyendo los cinco campos de texto.
- CV: como máximo uno; certificados y archivos de interés: selección múltiple.
- Sin nombre se muestra una etiqueta de ausencia, no una identidad inventada. La carpeta usa `Sin nombre` más el identificador del candidato.
- Sin correo no se fusionan candidatos desconocidos. Con un correo ya existente se reutiliza el candidato; los campos vacíos no borran sus datos. Si ya estaba vinculado a la oferta, se añaden los nuevos adjuntos a esa candidatura, sin duplicar la tarjeta ni reiniciar su etapa.
- Un doble clic no repite el envío. En un lote con fallo parcial, las filas confirmadas no vuelven a importarse al reintentar.

## Carpetas visibles en el Explorador

Los archivos nuevos de una importación se guardan dentro de la **carpeta de datos elegida en config.json**, local o UNC; nunca en una carpeta alternativa automática ni necesariamente junto al EXE:

```text
<raíz de datos>/
  Candidaturas/
    Nombre del puesto -- identificador de oferta/
      Nombre del candidato -- identificador de candidato/
        Ficheros de interes/
          identificador de documento -- nombre del archivo.pdf
          identificador de documento -- certificado.docx
          identificador de documento -- otro adjunto.xlsx
```

Los identificadores completos evitan colisiones entre puestos, personas y archivos con el mismo nombre. Se sanea el nombre físico para Windows y se recortan etiquetas largas, sin cambiar el nombre original almacenado en la metadata. Si faltan nombre o apellidos, se usa la parte disponible; si faltan ambos, `Sin nombre`.

No se crean carpetas de documentos cuando no hay archivos. Los directorios existentes de documentos antiguos y sus referencias siguen funcionando: **no hay migración ni renombrado automático**. Si cambia un nombre, no se renombran rutas ya guardadas; los documentos posteriores pueden usar la etiqueta nueva con el mismo identificador.

Los archivos son la copia autoritativa que usa la aplicación: no hay una segunda copia `.bin` para estos documentos. **No mover, renombrar, modificar ni borrar manualmente archivos o carpetas gestionados por la aplicación**; las lecturas verifican tamaño y SHA-256 y rechazan archivos alterados. Las exportaciones ZIP siguen incluyendo los documentos y `manifest.json`.

El motor admite rutas completas de hasta 1024 caracteres con componentes limitados. Aunque .NET 8 permite rutas largas, otras herramientas de Windows pueden tener límites menores: conviene elegir una raíz local/UNC corta.

## Seguridad y compatibilidad

- La importación no ejecuta adjuntos. Programas, scripts y formatos fuera de la lista de apertura solo pueden guardarse/exportarse desde la aplicación; no se lanzan mediante **Abrir**.
- PDF, Word, texto, CSV, imágenes comunes y Office sin extensiones de macros requieren la confirmación nativa antes de abrirse. La extensión no garantiza contenido inocuo: usar protección antimalware y revisar los archivos.
- Se mantienen los controles de permisos, solo lectura, hash, tamaño, paths canónicos y rechazo de enlaces/junctions.
- No cambia la revisión global, el control de conflictos por registro, la idempotencia ni la auditoría.
- El instalador rechaza paquetes que incluyan la carpeta privada `Candidaturas`; esa carpeta también está excluida de Git.
- Esta ampliación corresponde al **host Windows**. El navegador conserva el contrato anterior del servicio PocketBase: campos completos, CV y formatos PDF/Word. No se modifican esquemas, semillas ni datos del backend web.

## Validación realizada

- Pruebas del formulario: opcionales, archivos reales, formatos, límites, nombres originales, doble clic, reintento parcial y apertura desde la oferta sin repetición por polling.
- Hash de los textos originales i18n conservado; claves nuevas ES/EN registradas en su prueba.
- Pruebas del host: importación vacía, datos parciales, no mezclar correos vacíos, no borrar datos existentes, adjuntos variados, carpetas, nombres duplicados/Unicode, formatos, chunks, ZIP, integridad, reparse points, rutas largas y compatibilidad con binarios antiguos.
- `verify.ps1` completo en Windows y generación del instalador con validación del paquete real correctos.

No se ha certificado este recorrido sobre el recurso SMB definitivo ni con dos equipos reales; siguen pendientes las comprobaciones de `VERIFICACION_WINDOWS.md`.
