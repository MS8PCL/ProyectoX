# Revisión funcional de la versión de escritorio

Rama `claude/tender-knuth-xdychl` (PR #1). Revisión de partida: `ba89516`; la revisión se hizo sobre esa cabecera sin descartar cambios posteriores.

**Entorno: Linux.** Lo que aquí se marca como verificado se ha comprobado con:

- **Pruebas automáticas:** las suites del repositorio.
- **Navegador:** interfaz Vue real en Chromium contra el host real de .NET (`DesktopBridge`, `LegacyApi`, `DocumentApi` y `SharedStore`), a través de un puente `chrome.webview` simulado.
- **Compilación de tipos WPF:** contra los ensamblados de referencia de WindowsDesktop 8.0 y WebView2. Usa los *implicit usings* de un proyecto WPF real (sin `System.IO`); con ellos reproduce el fallo CS0246 de `3d7fe9d`.

Nada de esto equivale a ejecutar WPF/WebView2, a abrir diálogos nativos ni a usar dos equipos sobre SMB: eso sigue pendiente (ver al final).

## Estado inicial (`ba89516`)

| Comprobación | Resultado |
|---|---|
| JS (`verify.ps1`) | 87/87 |
| Storage / Legacy / Documents / DesktopBridge / Application | 21/21 · 27/27 · OK · 5/5 · 19/19 |
| Installer | 23/23 (3 de ellas vuelven sin ejecutar fuera de Windows: `LocalInstallation`, `LocalUnavailable`, `OverlappingDirectories`) |
| Migración PocketBase | OK |
| Tipos WPF (aplicación e instalador) | Compilan |

## Matriz de funciones

Estado: ✅ verificado, incluido en navegador cuando aplica · 🔧 corregido en esta revisión · ⚠️ decisión de negocio pendiente · ⏳ solo verificable en Windows o SMB.

| Función | Entradas y validación en host | Efectos persistidos | Permisos | Auditoría | Errores | Pruebas | Estado |
|---|---|---|---|---|---|---|---|
| Arranque y configuración | `config.json`: ruta absoluta existente, `readOnly` booleano, rol rrhh/it/admin | Ninguno | ACL de Windows | Log del host | Almacén caído: pantalla clara, sin fallback | Application, navegador | ✅ ⏳ WPF |
| Instalador | Ruta local o UNC; destino local nuevo o vacío; carpetas separadas; **sin enlaces ni OneDrive** | Solo la carpeta de instalación y `config.json` | Sin elevación | — | Rechaza sin escribir | Installer 25/25 | 🔧 D4 ⏳ ventana y SMB |
| Identidad y perfil | Personal (`fullName`/`title`/`location`) para rrhh/it/admin; de empresa para `company` | `desktop_profiles` | Propio | Sí | Muestra la razón | Legacy, navegador | ✅ |
| Preferencias (tema, idioma) | Conflicto solo si el mismo usuario guardó después | `desktop_user_state` y `savedRevision` | Propio | Sí | Aviso, sin rechazo sin capturar | StalePreferences, SerializedState | ✅ |
| Ofertas: crear y buscar | kind, título, empresa, lugar | `listings` | Staff | Sí | Motivo del host | Legacy, navegador | ✅ |
| Ofertas: editar y eliminar | Las mismas validaciones; no se borra con candidaturas | `listings` | Staff | Sí | Motivo, la oferta se conserva | desktop.test, Legacy, navegador | 🔧 D3 |
| Ofertas ETT y becario en pipeline e informes | — | — | — | — | — | listingKinds.test, navegador | 🔧 D1 |
| Importar candidato | Nombre, email, fecha de nacimiento **no futura**, carta, CV; tipos y tamaños de archivo | Candidato, candidatura, documentos e importaciones; reimportar reutiliza la candidatura | Staff | **Pseudónimo** | Validación previa, sin escrituras parciales | Documents, navegador | 🔧 V2, A1 |
| Documentos (abrir y ZIP) | Ruta canónica, hash y tamaño | Ninguno | Staff o propietario | — | Error visible, no «(sin CV)» | Documents, `PrepareExportAsync` real | 🔧 D2 ⏳ visor y diálogo |
| Pipeline: etapas y notas | Etapa válida; notas de 2000 caracteres como máximo | `applications` | Staff | Sí | Aviso en conflicto o con el almacén caído | Legacy, PerRecordConcurrency, navegador | ✅ 🔧 D2 |
| Eliminar candidatura | Bloqueada si tiene alta IT | Borra la candidatura y sus importaciones | Staff | Sí | Se retira solo tras la confirmación del host | Legacy, navegador | 🔧 D7 |
| Alta IT con candidatura | Catálogo activo, fecha, centro de coste, responsable, perfil de acceso | `hire_profiles`, outbox y etapa `hired` | Staff | Sí | Mensaje por campo | Legacy, navegador | ✅ ⚠️ B1–B3 |
| Alta IT independiente | Los mismos campos; **una sola solicitud abierta por email** | Candidato, alta y outbox | Staff | Sí | Lista de campos que faltan | Legacy, navegador | 🔧 A2, V3 |
| Outbox y altas pendientes | pending, completed o exported_manually | `integration_outbox` | Staff | Sí | Motivo del host | Legacy, navegador | ✅ |
| Métricas e Inicio | — | — | Staff | — | **Aviso** si no se pueden leer | Navegador | 🔧 D2 |
| Informes y CSV | — | — | Staff | — | Error visible y exportación deshabilitada | Navegador | 🔧 D2 ⏳ diálogo Guardar |
| Auditoría | Paginada completa | `audit_log` sin recortar | Staff | — | Error visible | desktop.test, storage.desktop.test | 🔧 A1 |
| Favoritos | Solo para el rol candidato | — | — | — | — | Navegador | 🔧 D5 |
| Correo nativo | `mailto:` validado | Ninguno | — | — | Confirmación | — | ⏳ cliente de correo |
| Solo lectura | El host rechaza toda escritura | Ninguno | — | — | Motivo visible al publicar | Legacy, navegador | ✅ ⏳ título de la ventana |
| Concurrencia | Revisión global más `_revisions` por registro | — | — | — | Conflicto visible y recarga | Receipts, Concurrency, PerRecordConcurrency; estrés con 2 procesos | ✅ ⏳ SMB |
| Recuperación (`commit.pending`) | Journal con suma de verificación | Promoción o rechazo | Solo escritura | — | `recovery_required` en solo lectura | Storage 21/21 | ✅ ⏳ SMB |

## Defectos corregidos

| ID | Defecto reproducido | Causa | Prueba | Commit |
|---|---|---|---|---|
| D1 | Las ofertas ETT y becario no aparecían en el pipeline ni en Informes: no se podían importar candidatos ni contratar | Filtro `kind === 'empleo'` | `listingKinds.test.js` y navegador | `f7d8919` |
| D2 | Con el almacén ilegible: el pipeline mostraba «crea un anuncio», Informes «Sin datos» con exportación activa (y en auditoría datos locales antiguos), la ficha «(sin CV)» e Inicio cifras desfasadas sin aviso | `catch` que vaciaban los datos | Reproducción en navegador con el almacén caído | `8d2dfb1`, `b27bcba` |
| D3 | No había interfaz para editar ni eliminar ofertas | Funcionalidad del host sin pantalla | `desktop.test.js` y navegador (edición, rechazo por candidaturas, borrado) | `bb83aa0` |
| D4 | El instalador aceptaba carpetas de datos que la aplicación rechaza (enlaces, junctions, OneDrive) | Faltaba la regla de `SharedStore.ValidateRoot` | Installer: inyectada y con un enlace simbólico real | `52a105c` |
| D5 | El botón ☆ Favorito no hacía nada para el personal | `toggleFavorite` solo funciona con el rol candidato | Barrido de botones | `1af2101` |
| D6 | «Copiar perfil» fallaba en silencio (rechazo sin capturar) | Sin `catch` | Barrido de botones | `9376764` |
| D7 | La candidatura desaparecía del tablero antes de que el host confirmara el borrado | Filtrado optimista | Navegador con un borrado rechazado | `b87c97b` |
| A1 | La auditoría de documentos guardaba el SID de Windows en claro y la ruta con identificadores. Sin `timestamp` ni `user`, Auditoría mostraba esas entradas con la hora actual y como «Sistema» | Formato distinto al de LegacyApi | Documents y `storage.desktop.test.js` | `b13324c`, `2108e4c` |
| A2 | Dos altas IT independientes pendientes para el mismo email | Faltaba la comprobación de duplicados | Legacy `StandaloneHire` | `a962df5` |
| V2 | Se aceptaba una fecha de nacimiento futura | Solo se validaba el formato | Documents | `8f98449` |
| V3 | «Crear Alta» incompleto solo mostraba el primer error técnico (`departmentId debe…`) | Sin validación previa en la interfaz | Navegador | `6e71c1a` |
| N1 | Candidatos con solo `fullName` (alta independiente o migrados de PocketBase) aparecían con su email | El nombre se formaba solo con `firstName`/`lastName` | `candidateName.test.js` y navegador | `04bb6b9` |

Las reglas de idempotencia y concurrencia no cambian. Siguen pasando Receipts, Concurrency, SerializedState, PerRecordConcurrency y StalePreferences. Los textos i18n originales no se han tocado (prueba por hash): los nuevos usan claves registradas en `addedExistingSectionKeys`.

## Rendimiento (medido, disco local)

Almacén sintético. Mediana de 12 operaciones.

| Tamaño de `state.json` | Lectura del pipeline | Escritura (PATCH) |
|---|---|---|
| 0,7 MB (200 candidaturas) | 10 ms | 43 ms |
| 1,8 MB (500) | 16 ms | 70 ms |
| 7,1 MB (2000 y 20 000 entradas de auditoría) | 120 ms | 257 ms |

- **Control por registro (`EntityRevisions`):** 12,7 ms por escritura a 7,1 MB, alrededor del 5 %. No compensa optimizarlo.
- **`SharedStore.ReadAsync`:** 68 ms; analiza el JSON dos veces. Probé a construir el nodo sobre el mismo documento: la lectura bajó, pero el coste pasó a las copias y el total no mejoró de forma consistente. **Revertido; no se incluye.**
- **Pendiente sin medir:** el coste en SMB. Cada lectura transfiere el fichero completo; con el crecimiento de la auditoría (unos 600 B por escritura), conviene medirlo en el recurso real.

## Decisiones de negocio pendientes (no implementadas)

| ID | Decisión |
|---|---|
| B1 | Arrastrar una tarjeta a «Contratado» marca la etapa sin crear el alta IT; «Marcar contratado» sí la crea. ¿Debe exigirse el alta para esa etapa? |
| B2 | Sacar de «Contratado» una candidatura con alta IT deja su solicitud en la outbox. ¿Se bloquea, se avisa o se cancela la solicitud? (No hay operación de cancelación.) |
| B3 | Se puede dar de alta una candidatura «Descartado», y con una fecha de incorporación pasada. ¿Se restringe? |
| B4 | El donut «Ofertas por tipo» de Inicio solo distingue Empleo y Freelance; ETT y becario no se cuentan. ¿Se añaden categorías? (Es un cambio de interfaz.) |
| B5 | `state.json` crece con las dos auditorías. ¿Política de archivado? (No se recorta por cumplimiento.) |

## Verificación pendiente

Solo puede hacerse en Windows, con autorización:

- `verify.ps1`, `build.ps1 -Installer` y `test_installer_window.ps1` sobre esta cabecera.
- Recorrido completo de `VERIFICACION_WINDOWS.md`:
  - WPF y WebView2: visor de PDF, diálogo Guardar con espera de más de 30 s, CSV en Excel y correo.
  - Instalación sobre una UNC autorizada.
  - Dos equipos simultáneos.
  - Desconexión de red, ACL y solo lectura.
- Hace falta:
  - Una ruta UNC autorizada para crear una carpeta nueva con datos sintéticos.
  - Acceso a un segundo equipo.
  - Permiso para desconectar la red y para usar un usuario con ACL de solo lectura.

## Recomendación

**No fusionar todavía.** El código y las pruebas automatizadas están en verde en Linux y los defectos encontrados están corregidos. Faltan:

- La verificación funcional en Windows y SMB de este documento.
- Las decisiones B1–B3, que afectan a la consistencia de las altas IT.

Con `VERIFICACION_WINDOWS.md` completo y esas decisiones tomadas, la PR estaría en condiciones de fusionarse.
