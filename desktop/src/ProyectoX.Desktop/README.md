# ProyectoX.Desktop

Host WPF `net8.0-windows`, WebView2 SDK `1.0.2903.40`. Usa el **frontend Vue original** compilado en `desktop/frontend-dist`, no `desktop/ui`. La documentación de despliegue/datos/pruebas está en `desktop/README.md`.

## Piezas

- `App.xaml.cs`: configuración en worker y ventana de inicio, sin bloquear WPF por validar una UNC.
- `DesktopConfiguration.cs`: `config.json` únicamente junto al EXE, raíz absoluta existente, `readOnly`, `operationalRole` opcional (`rrhh` por defecto).
- `MainWindow.cs`: recursos embebidos en `https://proyectox.local`, CSP, navegación/descargas restringidas, mensajes serializados, E/S fuera del Dispatcher, diálogos nativos de archivos/correo y cierre de app.
- `DesktopBridge.cs`: dispatcher `legacyApi`, `uploadBegin`, `uploadChunk`, `uploadFinish`; errores sanitizados y resultado incierto.
- `LegacyApi.cs`: contratos de las pantallas originales y persistencia multi-entidad con revisión/receipts.
- `DocumentApi.cs`: staging por chunks, documentos inmutables, lectura de mappings de PocketBase migrado, ZIP y hashes.
- `StorageBridge.cs`: operaciones del prototipo mínimo previo, conservadas como compatibilidad/tests; no es el transporte de la UI original.
- `HostLog.cs`: metadatos de eventos/tipos de excepción, nunca contenido, rutas o mensajes originales.

Identidad obtenida de Windows, no de contraseñas inventadas. El rol operativo editable selecciona flujo/presentación; las ACL del share son la frontera real, no un login nuevo ni una matriz de autorización endurecida.

## Bridge original

```
{id,operation:'legacyApi',payload:{path,method,body,expectedRevision,operationId}}
{id,ok:true,result:{...respuestaLegacy,__desktop:{revision,readOnly,appliedOperationIds}},error:null}
```

`api()` conserva HTTP en navegador. En desktop usa este contrato, retira metadatos y no hace fallback local. Cada mutación requiere UUID y revisión; recibos se confirman junto con el cambio. Una misma operación recuperada no escribe dos veces.

Para FormData, archivos se envían con begin/chunk/finish; el cuerpo legacy contiene referencias `uploadId`, no bytes inline. 256 KiB/chunk, 50 MiB/archivo, 64 MiB/formulario, 1 MiB/mensaje. No enviar `PreparedDocument` al WebView: el host consume sus bytes mediante diálogos.

Acciones nativas: `documentAction {path,action:'open'|'save'}`, `openMail {url:mailto}`, `closeApplication {}`. Apertura de PDF/DOC/DOCX pide consentimiento y crea una copia temporal de visualización, no un almacén alternativo. Las exportaciones CSV/JSON existentes usan downloads blob del origen confiable y un diálogo de guardado.

Sin servidores, recursos remotos ni datos demo añadidos. Perfil WebView2 normal en `%LOCALAPPDATA%/ProyectoX/WebView2`, sólo preferencias del navegador. Diagnóstico opcional con `PROYECTOX_INSPECT_UI=1` usa perfil separado y CDP loopback; cerrar la instancia al terminar y no dejarlo habilitado en producción.

Compilar el frontend original antes del host mediante `desktop/tools/build.ps1`. Requiere .NET Desktop Runtime 8 y WebView2 Runtime para ejecutar. Los cambios frontend necesitan recompilar el assembly. El host nunca crea la raíz de negocio ni la sustituye por otra ruta.
