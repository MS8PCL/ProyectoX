# Proyecto X

Aplicación ATS interna para selección de personal y coordinación de altas RR. HH. → IT. La versión de escritorio conserva la interfaz Vue original dentro de un host WPF/WebView2 y utiliza archivos compartidos, sin servidores de aplicación ni de base de datos.

## Arquitectura

- **Host Windows:** WPF sobre .NET 8 y WebView2.
- **Interfaz:** Vue 3, Pinia, Vue Router, Tailwind y Chart.js. Recursos embebidos al compilar.
- **Lógica local:** casos de uso .NET y adaptador de los contratos originales.
- **Persistencia:** JSON y documentos en una carpeta local de pruebas o ruta UNC compartida, con bloqueo exclusivo, revisiones, journal y recuperación.
- **Identidad:** Windows. Los permisos reales dependen de las ACL del recurso compartido.

No se necesitan Hono, PocketBase, Redis ni Node durante la ejecución de escritorio. `backend/` e `infra/` conservan el código web previo; no son el arranque de la aplicación de escritorio.

## Preparar y compilar

Requisitos de desarrollo: Windows, SDK .NET 8, Node compatible con Vite 7, npm y Python 3 para las pruebas del migrador.

Desde la raíz, PowerShell:

```powershell
npm --prefix frontend ci
powershell -ExecutionPolicy Bypass -File .\desktop\tools\verify.ps1
powershell -ExecutionPolicy Bypass -File .\desktop\tools\build.ps1 -Publish
```

La publicación Release `win-x64` se genera en `desktop/artifacts/release`. Copiar toda la carpeta. Para ejecutar hacen falta .NET Desktop Runtime 8 y Microsoft Edge WebView2 Runtime.

**Cambiar el frontend no actualiza un EXE existente:** volver a compilar/publicar.

## Configuración

El repositorio contiene código, pruebas y un ejemplo vacío, **no datos, credenciales, ejecutables ni configuración privada**. Crear `config.json` junto al EXE y elegir expresamente una carpeta existente:

```json
{
  "networkRoot": "\\\\EQUIPO\\RECURSO\\ProyectoX",
  "readOnly": false,
  "operationalRole": "rrhh"
}
```

La ruta es ilustrativa. Para una primera prueba usar una carpeta nueva y vacía, separada de los originales. Si la ruta falla, la aplicación no guarda en una copia local alternativa. `operationalRole` selecciona el flujo interno; no sustituye permisos Windows ni constituye autenticación fuerte.

## Funcionalidades y alcance

Interfaz original: ofertas, búsqueda, pipeline, candidatos/documentos, métricas, altas IT, catálogos, outbox manual, auditoría e informes. Se han adaptado las operaciones principales al almacenamiento local/compartido. La navegación recuperada no certifica todos los flujos heredados.

- Los enlaces públicos de recepción de candidatos no funcionan sin un servicio externo; utilizar importación interna.
- La outbox es manual: no provisiona accesos ni crea tickets remotos automáticamente.
- Las rutas de workflow/preview todavía no implementadas responden con un error explícito.
- Validar en dos equipos sobre el SMB de destino, incluyendo conflictos, desconexiones, recuperación, ACL y backups antes de uso real.
- No colocar SQLite/PocketBase directamente sobre una unidad compartida ni usar OneDrive como sustituto de SMB.

## Estructura

```
frontend/       Interfaz original y transporte web/escritorio
desktop/src/    Host Windows, contratos locales y persistencia
desktop/tests/  Pruebas de almacenamiento, API, documentos y migración
desktop/tools/  Compilación, verificación e importación verificada
backend/        Backend web anterior
infra/          Configuración del despliegue web anterior
```

Instrucciones completas, garantías y límites: [desktop/README.md](desktop/README.md).
