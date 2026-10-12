# Proyecto X — frontend original en Windows

## Qué ejecuta ahora

El EXE usa **`frontend/` original**, con su diseño, componentes, navegación, temas y páginas. El prototipo mínimo anterior no forma parte del entregable actual: **no se compila ni se empaqueta**. No se ha sustituido el ATS por una mini SPA.

- WPF .NET 8 + WebView2 como host.
- Build Vue original en modo `desktop`, generado en `desktop/frontend-dist` e incorporado como recursos del assembly.
- Router hash dentro de WebView2; en navegador se mantiene el modo web existente.
- `api()` y `apiForm()` hablan con C# a través del bridge, sin HTTP ni procesos Hono/PocketBase/Redis.
- `LegacyApi` adapta los contratos existentes a JSON compartido: ofertas, perfiles, candidaturas/etapas/notas, catálogos, métricas, altas IT, outbox manual, auditoría, notificaciones y preferencias por identidad.
- Si el almacén no tiene departamentos ni puestos (instalación nueva sin migración), el host sirve los catálogos oficiales de `backend/src/seeds`, embebidos tal cual, y los guarda en la primera escritura. Nunca sustituye un catálogo existente.
- Las preferencias propias (`/state`, `/settings`) no fallan porque otro usuario haya guardado algo; solo entran en conflicto con un guardado más reciente del mismo usuario.
- `DocumentApi` admite CV/certificados, importación interna, lectura nativa y ZIP. Uploads por chunks de 256 KiB, con SHA256; 50 MiB por archivo y 64 MiB por formulario.
- El worker PDF.js se empaqueta con la versión instalada; no requiere un CDN.
- Se conservan colores y layout; se completaron textos faltantes que mostraban claves como `onboarding.welcome`.

No se inventan usuarios PocketBase ni contraseñas. El host usa SID/nombre Windows. `operationalRole` selecciona la función interna (`rrhh`, `it`, `admin`) y es editable en config: **no es una frontera de seguridad**. Las ACL Windows del recurso compartido son esenciales; un usuario con escritura directa puede alterar archivos fuera de la app. Auditoría no está firmada. Las asociaciones con usuarios PocketBase antiguos solo se hacen mediante mappings explícitos, nunca infiriendo email/nombre.

## Ejecutable y configuración

Publicación **Release `win-x64`, framework-dependent**:

```
desktop/artifacts/release/ProyectoX.Desktop.exe
```

Para la versión portable, distribuir toda la carpeta; requiere .NET Desktop Runtime 8 y Microsoft Edge WebView2 Runtime. También hay un [instalador con selección de datos locales o UNC](INSTALADOR.md), generado con `tools/build.ps1 -Installer`, que incluye .NET 8 y guarda la configuración elegida junto al EXE. Ambos entregables requieren WebView2 Runtime y todavía no están firmados. Modificar Vue no cambia un EXE ya construido: recompilar y publicar.

Se lee únicamente `config.json` junto al EXE, no la configuración de la raíz del repositorio ni del directorio de trabajo. Campos:

```json
{
  "networkRoot": "\\\\EQUIPO\\RECURSO\\ProyectoX",
  "readOnly": false,
  "operationalRole": "rrhh"
}
```

La UNC anterior es un ejemplo, no un destino autorizado. La raíz debe existir. No se crea una copia local alternativa si falla la red. `config.example.json` tiene una ruta vacía deliberada. `readOnly` no reemplaza ACL; para lectura coordinada requiere que `.write.lock` exista o permisos para crearlo.

**El repositorio no incluye configuración de ejecución ni datos.** Cada instalación debe elegir expresamente una carpeta de pruebas o una ruta compartida. El instalador solicita una carpeta de datos existente, local o UNC, independiente de la carpeta de instalación y crea la configuración junto al EXE; en la versión portable se crea manualmente. Las configuraciones locales y entregables privados están excluidos de Git.

## Migración sin tocar el origen

El migrador exporta una fuente PocketBase seleccionada explícitamente a una carpeta nueva y vacía. No combina backups ni sobrescribe instalaciones. `migration-manifest.json` permite comprobar cantidades y hashes, incluido el SHA256 del DB antes y después y el indicador `sourceUnchanged`. Ese manifest y los datos resultantes son privados y no se incluyen en el repositorio.

En el destino, `state.json` confirma todas las colecciones conjuntamente; archivos antiguos verificados están en `pocketbase-storage`, y los nuevos en `documents` con nombres opacos. Las lecturas verifican tamaño/hash de documentos. Los datos originales `pb_data` no se usan como JSON ni reciben escrituras de la nueva app.

No publicar configs locales, datos JSON, CV, manifest con nombres de archivos, screenshots de negocio, backups ni entregables privados.

## Protocolo y reintentos

`ProyectoX.Storage` mantiene revisión monótona, lock exclusivo, journal `commit.pending` con SHA256, promoción y backup de una generación. Todos los clientes deben respetar el protocolo. No utilizar SQLite/PocketBase directamente sobre una unidad de red ni sustituir SMB por sincronización OneDrive.

La aplicación detecta conflicto en vez de sobrescribir una revisión antigua. Los receipts se confirman junto con la mutación. Dentro de la sesión del renderer, reintentar explícitamente una operación incierta idéntica reutiliza el UUID, también para multipart reconstruido con archivos idénticos. La caché temporal es solo memoria, hasta 128 pendientes, y no guarda bytes de archivos ni usa localStorage. No hay retry automático. **Recargar/cerrar el renderer pierde esa caché**: actualizar y revisar antes de recrear una operación. Los receipts duraderos siguen en el almacén, pero no implican deduplicación global de cualquier formulario nuevo.

Un journal pendiente en read-only devuelve `recovery_required`: un cliente escribible debe recuperar el almacén. No borrar journal manualmente. El backup anterior no sustituye backups externos versionados. E/S SMB se ejecuta fuera del hilo WPF; un timeout JS no cancela necesariamente una llamada de red nativa ni demuestra que una escritura no ocurrió.

## Compilar y verificar

Desde `desktop`, PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\verify.ps1
powershell -ExecutionPolicy Bypass -File .\tools\build.ps1 -Publish
```

SDK .NET 8, Python 3, Node compatible con Vite 7 y dependencias existentes de `frontend/node_modules`. Si faltan, `npm ci` en `frontend`, no en la raíz con workspaces sin declarar.

`verify.ps1` ejecuta tests JS del transporte, multipart, estado e i18n; harnesses de storage, contratos, API legacy, documentos y bridge; pruebas Python del migrador; compila el frontend original y comprueba bytes de todos los recursos embebidos sin lanzar GUI. Las pruebas usan datos sintéticos en carpetas temporales.

El migrador no abre SQLite sobre el original: copia DB/WAL a una zona privada, verifica fingerprints y obtiene un snapshot allí. Requiere PocketBase detenido. Destino existente y vacío, sin overlap con origen. `state.json` se publica al final; faltantes, corrupción o destinos con contenido abortan sin sobrescribir.

```powershell
python .\tools\migrate-pocketbase.py --source RUTA_PB_DATA --dry-run
python .\tools\migrate-pocketbase.py --source RUTA_PB_DATA --destination RUTA_NUEVA_VACIA
```

Las rutas del ejemplo deben sustituirse expresamente; el migrador no elige entre varias fuentes ambiguas.

## Inspección real de WebView2

Para una comprobación de lectura sobre la configuración seleccionada:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\launch-inspection.ps1
node .\tools\inspect-original-ui.mjs
```

`PROYECTOX_INSPECT_UI=1` usa un perfil de navegador de diagnóstico separado y CDP loopback en 9224. **No usar este modo para el arranque habitual.** El inspector verifica sidebar original, navegación por ocho páginas, errores de runtime/recursos y captura screenshot privado en `desktop/artifacts/ui-original.png`. Completa el tutorial solo en ese perfil (preferencia local, no datos de negocio). Cierra únicamente esa instancia al terminar. Ante interrupción, cerrar manualmente la instancia de diagnóstico.

Se ha comprobado la UI real en WebView2 y revisado una captura. Esta comprobación de navegación no sustituye pruebas de edición concurrente, flujos completos de contratación ni validación SMB desde dos equipos.

## Límites que no se ocultan

- Enlaces públicos y portal de candidatos requieren un servicio externo; desktop devuelve `unsupported_local`, no una URL ficticia. Usar importación interna.
- Outbox/OTRS es manual; no aprovisiona IAM ni crea tickets remotos automáticamente. Mocks no son integraciones.
- Endpoints de workflow/preview que no estaban conectados a las pantallas actuales siguen explícitamente no implementados en C#.
- Algunos cálculos/reportes y funciones heredadas de la UI requieren revisión adicional; recuperar las pantallas no certifica cada función previa. Dashboard desktop usa métricas reales, sin tendencias demo ni tiempo fijo.
- Falta la ruta UNC definitiva, prueba SMB con dos equipos, desconexiones/reinicios, ACL y backups/retención, validación del instalador sobre el SMB real, firma y política de versiones compatibles.
