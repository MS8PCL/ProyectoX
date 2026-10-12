# ProyectoX.Storage

Biblioteca `net8.0`, sin NuGet, servidor, configuración global ni fallback local. El harness de consola también usa únicamente .NET 8.

## Contrato para el host

Namespace `ProyectoX.Storage`:

```csharp
public SharedStore(string root, bool readOnly = false);
public Task<StoreSnapshot> ReadAsync(CancellationToken cancellationToken = default);
public Task<StoreSnapshot> CommitAsync(long expectedRevision, JsonObject data,
    string actor, CancellationToken cancellationToken = default);
public sealed record StoreSnapshot(long Revision, JsonObject Data);
```

Excepciones públicas: `StoreConflictException` (incluye `ExpectedRevision`/`ActualRevision`), `StoreUnavailableException` y `StoreReadOnlyException`. Argumentos inválidos producen excepciones estándar de argumentos; la cancelación produce `OperationCanceledException`. No requiere cambios en el host ni otros proyectos. El host debe referenciar el `.csproj`, usar exactamente estos tipos y proporcionar una carpeta local o UNC **existente**. El constructor valida la ruta; cada operación vuelve a validarla. No se crea ni reemplaza la raíz.

```csharp
var store = new SharedStore(@"\\servidor\recurso\ProyectoX");
var snapshot = await store.ReadAsync(cancellationToken);
var updated = (JsonObject)snapshot.Data.DeepClone();
// Modificar listings, candidates y applications en updated.
var committed = await store.CommitAsync(snapshot.Revision, updated, actor, cancellationToken);
```

Una carpeta nueva y vacía devuelve revisión virtual `0` con tres arrays vacíos; no escribe `state.json` hasta el primer commit. Los documentos persistidos usan revisiones positivas `Int64`. `data` requiere los arrays `listings`, `candidates`, `applications`; permite otros campos. No valida referencias, IDs ni reglas del negocio: eso corresponde al host. Cada commit reemplaza todo `data` y aumenta la revisión exactamente en uno. El almacén clona los datos; no comparte JSON mutable entre lecturas. El host no debe mutar un `JsonObject` concurrentemente mientras lo entrega al almacén.

## Archivos y protocolo

- `state.json`: único documento activo `{ "revision": 1, "data": { ... } }`, todas las entidades en una sola promoción.
- `.write.lock`: archivo persistente, nunca se elimina; `FileStream` con `FileShare.None` coordina escritores **y lectores**. Reintentos cada 40 ms con un presupuesto de 3 segundos (no un límite estricto de una llamada de red bloqueada). No hay bloqueo por timestamps ni eliminación de supuestos locks obsoletos.
- `commit.pending`: `{ "snapshot": { "revision": ..., "data": ... }, "sha256": "HEX..." }`. SHA-256 sobre UTF-8 del snapshot normalizado por `JsonObject.ToJsonString()` de .NET 8; no sobre el texto arbitrariamente indentado. Se rechazan propiedades duplicadas. Es detección de corrupción, **no autenticación**.
- `state.backup.json`: anterior estado, actualizado por `File.Replace` al promover sobre un estado existente. No se restaura automáticamente.
- `.store-<GUID>.tmp`: archivos exclusivos de staging en la misma carpeta; se ignoran los huérfanos, nunca se promueven por intuición.

Bajo el lock: validar estado y recuperar journal, comprobar `expectedRevision`, agregar auditoría, escribir temporal con `WriteThrough` y `Flush(true)`, publicar journal mediante `File.Move` sin overwrite, escribir/flush temporal del nuevo estado y promover con `File.Replace` (o `File.Move` si no existe estado), y eliminar journal. No se usa copy/delete ni fallback cuando el filesystem no soporta replace. El backup conserva una generación.

Lecturas y commits recuperan journals válidos antes de continuar:

1. Journal `actual + 1`: promoverlo.
2. Journal igual a estado y con exactamente el mismo snapshot: sólo eliminar el journal (commit ya promovido).
3. SHA inválido, snapshot distinto a igual revisión, revisión anterior/saltada, estado corrupto o ausencia del estado con un backup: error y conservar los archivos para investigación.

No se reinicializan datos corruptos. Sin estado, backup ni journal se considera una carpeta nueva: no puede distinguirse de un borrado externo de todos los archivos. No hay restauración automática, reset ni protección contra un administrador que borre o altere archivos fuera del protocolo.

## Read-only, errores y cancelación

`readOnly` impide commits y cualquier recuperación, incluso la eliminación de un journal ya promovido. Una lectura con journal lanza `StoreRecoveryRequiredException` (subtipo de `StoreReadOnlyException`) con instrucciones claras. El host la expone como `recovery_required`, no como una prohibición normal de escritura. Para coordinarse requiere abrir `.write.lock` exclusivamente; si ya existe se abre con acceso de lectura, y si falta puede crear **sólo ese archivo de coordinación**. No altera estado, backup ni journal. Una carpeta sin permisos para crear el lock faltante produce unavailable, no una lectura sin coordinación.

Cancelación respetada antes del journal y durante espera de lock. Tras publicar el journal se termina el protocolo sin cancelación, para no abandonar voluntariamente una transacción a medias. Un fallo de E/S después de publicar puede dejar un commit pendiente o ya aplicado: el host debe **leer para resolver el resultado**, no repetir ciegamente la operación. Después de recuperación, un `expectedRevision` viejo genera conflicto. Los hooks internos por instancia sólo existen para el harness, con `InternalsVisibleTo`; no amplían el contrato público.

## Auditoría y privacidad

`data.audit` es reservado y administrado por el almacén. Se conserva del estado anterior y se añade `{revision, actorHash, timestampUtc}`; el contenido de auditoría propuesto por el caller se ignora. El actor en texto nunca se persiste ni se incluye en mensajes. El hash SHA-256 determinista facilita correlación pero **no anonimiza**: identificadores predecibles pueden adivinarse. Usar un identificador opaco y no PII cuando sea posible. No hay auditoría de los valores de entidades, cifrado ni firma. El resto de `data` puede contener PII del negocio y exige ACL, retención y backups apropiados. La auditoría crece sin compactación.

## Seguridad de rutas y límites SMB

Nombres internos fijos (no derivados de IDs ni actor), temporales GUID, creación exclusiva y rechazos de reparse points/junctions/symlinks en raíz, ancestros y entradas utilizadas. Rutas relativas se convierten a absolutas una sola vez. Una UNC se utiliza directamente: nunca se crea un directorio alternativo. Se permiten `.`/`..` en la raíz configurada tras normalizarla, no en nombres internos.

Las comprobaciones por nombre tienen ventanas TOCTOU; no son una sandbox frente a un atacante con permisos para reemplazar rutas durante la operación, hard links ni escritores que ignoran el lock. La carpeta y sus ancestros deben ser de confianza con ACL restringidas. Todos los participantes deben respetar este protocolo.

Se intenta atomicidad de promoción y persistencia con las primitivas de .NET/filesystem, pero **no se prometen garantías de red no probadas**. `FileShare.None`, `File.Replace`, `WriteThrough` y `Flush(true)` dependen del cliente, servidor SMB, cachés, almacenamiento y configuración. No se fsynca la entrada del directorio de forma portable; corte eléctrico, pérdida de conexión, failover, oplocks y errores con resultado desconocido requieren pruebas reales. Un `FileStream` síncrono bloqueado por SMB puede superar los tres segundos y no ser cancelable por el token. No es consenso distribuido ni protección contra split-brain. Shares sin replace soportado fallan explícitamente. Probar permisos, dos máquinas, desconexiones, reinicios y recuperación sobre el SMB destino antes de producción. El harness local no demuestra durabilidad ni comportamiento UNC real.

## Validación

Desde `desktop`:

```sh
dotnet run --project tests/ProyectoX.Storage.Tests/ProyectoX.Storage.Tests.csproj
```

El harness usa sólo directorios temporales únicos, retorna código distinto de cero si falla, y prueba contrato, entidades, conflictos, dos writers (tareas y procesos), revisión monotónica, read-only, raíz inexistente/desaparecida, JSON corrupto, checksum, recuperación en ambas fronteras, bloqueo/cancelación, overflow, auditoría y rutas reparse. No toca almacenes reales ni archivos de otros módulos.
