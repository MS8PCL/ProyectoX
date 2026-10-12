# Resultados de la verificación Windows de la PR #1

## Alcance y entorno

Revisión inicial: `3c4d54e8b4d82262bb2548110033a12beb0255d7`, rama `claude/tender-knuth-xdychl`. Se leyó la descripción de la PR y se usó un clon independiente, sin modificar el checkout anterior.

- Windows 11 Pro, versión 10.0.26200, compilación 26200.
- .NET SDK 8.0.425; Node.js v24.13.0.
- WebView2 Runtime instalado: 154.0.4258.62 (registro de EdgeUpdate). No se ha ejecutado la aplicación para confirmar el runtime utilizado por el proceso.
- No se han usado datos reales, creado una instalación permanente o sobre SMB ni publicado configuración, binarios o rutas internas. Las pruebas del instalador usan temporales propios y datos sintéticos.

## 1. Compilación y pruebas

- [x] `npm --prefix frontend ci`: completado. Advierte de 15 vulnerabilidades (1 baja, 4 moderadas y 10 altas) y de la deprecación de `lucide-vue-next`. No se ejecutó una actualización automática de dependencias ni se ha analizado su explotabilidad.
- [x] `powershell -ExecutionPolicy Bypass -File .\desktop\tools\verify.ps1`: completado después de corregir el fallo descrito abajo. Incluye las pruebas JavaScript, almacenamiento, aplicación y recursos embebidos, LegacyApi, documentos, puente y migración. Compilación WPF real correcta, sin errores ni advertencias del compilador. La última ejecución completa fue posterior al contenido definitivo de la corrección.
- [x] `powershell -ExecutionPolicy Bypass -File .\desktop\tools\build.ps1 -Publish`: completado después de la corrección. Vite muestra un aviso de tamaño de chunks; no impide la compilación. Publicación win-x64 framework-dependent realizada, no instalada ni ejecutada.

## Fallo reproducido y corregido

Commit: `3d7fe9d` — Corrige el import de StreamReader en WPF.

La primera ejecución de `verify.ps1` falló al compilar el host real con CS0246 en `LegacyApi.cs`: faltaba el import `System.IO` para `StreamReader`. CS1579 era un error derivado. Los proyectos de pruebas net8.0 aportaban ese import implícitamente y ocultaban el problema del proyecto WPF.

Cambio mínimo: añadir `using System.IO;`. Prueba añadida: `desktop/tests/test_windows_build.ps1`, integrada en `verify.ps1`, que compila el proyecto WPF real. Se ejecutó antes del cambio y falló con los mismos errores; después pasó y se repitió la verificación completa. No se modificaron la concurrencia, preferencias, auditorías, semillas ni los textos i18n.

## Instalador con selección de UNC

Se añadió un [asistente Windows](INSTALADOR.md) por petición del propietario. Incluye .NET 8 y solicita una UNC existente, solo lectura y rol operativo, sin escribir en el recurso ni sobrescribir instalaciones.

- [x] Generación del EXE único self-contained mediante `build.ps1 -Installer`.
- [x] Motor: 18/18 pruebas sintéticas correctas; integrado en `verify.ps1`.
- [x] Extracción y configuración del ZIP distribuible real en un temporal sintético: 19/19 pruebas incluyendo el paquete; no representa una prueba SMB.
- [x] Ventana real del EXE: campos, solo lectura por defecto, rechazo de ruta local, detección de WebView2 y rechazo de UNC sintética inaccesible sin instalación ni fallback.
- [ ] Instalación efectiva con una UNC autorizada, acceso del menú Inicio y arranque de la aplicación instalada: pendiente.

Estas comprobaciones no aprueban las casillas del recorrido funcional ni las de dos equipos.

## 2. Instalación de prueba — pendiente

No se detectaron conexiones ni mapeos SMB mediante `Get-SmbConnection` y `Get-SmbMapping`. Esto no demuestra que el recurso no exista: falta identificar una ruta autorizada y disponer de acceso al segundo equipo.

- [ ] Crear una carpeta nueva y vacía en el recurso SMB real: pendiente de ruta y autorización.
- [ ] Copiar la publicación a A y B y configurar el mismo destino con `readOnly: false`: pendiente.
- [ ] Configurar un tercer equipo o B después con `readOnly: true`: pendiente.

No se sustituyó esta instalación por almacenamiento local ni se consideraron dos procesos locales como dos equipos.

## 3. Recorrido en el equipo A — no ejecutado

Todas las casillas siguientes están pendientes de la instalación exigida; no son fallos observados ni aprobaciones.

- [ ] Arranque, bienvenida y título «Proyecto X»: pendiente.
- [ ] Perfil y confirmación «Perfil guardado»: pendiente.
- [ ] Publicar oferta y encontrarla en Buscar: pendiente.
- [ ] Importar candidato con CV PDF y certificado, confirmación y segundo clic inocuo: pendiente.
- [ ] Abrir CV con confirmación en el visor PDF de Windows: pendiente.
- [ ] ZIP de candidatura y de oferta mediante Guardar, esperar más de 30 segundos, comprobar manifest y CV: pendiente.
- [ ] Correo con confirmación y cliente nativo: pendiente.
- [ ] Notas y movimientos de tarjetas: pendiente.
- [ ] Contratación, Alta IT con catálogos, datos completos y finalización: pendiente.
- [ ] Alta IT independiente: pendiente.
- [ ] Exportación CSV mediante Guardar y apertura en Excel: pendiente.
- [ ] Auditoría de las acciones: pendiente.
- [ ] Tema e idioma: pendiente.
- [ ] Eliminar candidatura sin alta: pendiente.

## 4. Dos equipos simultáneos — no ejecutado

- [ ] A mueve X y B escribe nota en Y sin errores: pendiente.
- [ ] Edición simultánea de la misma nota, conflicto visible y recuperación: pendiente.
- [ ] Cambio de tema de B mientras A trabaja: pendiente.
- [ ] Diálogo Guardar abierto en A mientras B sigue trabajando: pendiente.

Las pruebas automatizadas de concurrencia no certifican estos recorridos sobre SMB real.

## 5. Red y permisos — no ejecutado

- [ ] Desconexión real de A, aviso de almacenamiento, reconexión y datos intactos: pendiente.
- [ ] Equipo en solo lectura, título y rechazo de publicación: pendiente.
- [ ] Usuario con ACL sin escritura no puede guardar: pendiente.
- [ ] Ausencia de `commit.pending` tras cerrar todas las aplicaciones: pendiente.

## Conclusión

**No fusionar todavía.** La compilación, publicación y verificación automatizada en Windows están en verde, pero faltan la ejecución WPF/WebView2, los diálogos nativos y todas las pruebas del recurso SMB con dos equipos reales.

Se necesita la ruta UNC de un recurso autorizado para crear una carpeta nueva de datos sintéticos y acceso al segundo equipo o colaboración de un operador. No desconectar la red ni cambiar ACL de recursos existentes sin autorización.

No se ha publicado el comentario final de aprobación en la PR: la instrucción exige hacerlo cuando todo esté en verde. No se ha fusionado la PR ni enviado cambios a `main`.
