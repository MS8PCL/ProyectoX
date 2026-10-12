# Application contract integration harness

Dependency-free `net8.0` console harness. Compiles the real Desktop
`StorageBridge.cs` and `HostLog.cs` as linked files and references Storage.
`HostLog` uses only `System.Diagnostics`; no WPF stub is needed. Neither the
Desktop project nor its executable is built or started.

From the repository root, run with a 120-second external timeout:

```sh
dotnet run --project desktop/tests/ProyectoX.Application.Tests/ProyectoX.Application.Tests.csproj --property:UseArtifactsOutput=true --property:ArtifactsPath="G:/Proyecto X/repo/proyecto-x-definitivo/desktop/tests/ProyectoX.Application.Tests/artifacts"
```

Replace the absolute repository prefix if the checkout moves. Keep both global
properties: they redirect the referenced Storage project's build and restore
outputs into this harness too. `Directory.Build.props` also makes `dotnet run`
resolve the harness executable in that artifacts directory.

Each test has an isolated temporary store, a 20-second cancellation deadline,
and cleanup on disposal. Exit code is 0 only when all tests pass; otherwise 1.
Requests and responses exercise the serialized JSON contract, with real
`SharedStore` reads and commits, not mocks.

Coverage: empty state; CRUD for all three collections; persisted revisions and
host timestamps; reference integrity; every supported stage and invalid stages;
bridge and storage read-only modes; stale saves/deletes without changing state
or persisted bytes; unsupported operations/collections; forged timestamps;
malformed requests; sanitized storage failures without resetting corruption;
and three rounds of eight concurrent writers using independent stores, checking
one winner per revision and preservation of previous commits.

Every mutation requires `payload.operationId`, a UUID string in hyphenated form.
Helpers generate a fresh UUID for each new mutation; retries keep the original
UUID and content. The fingerprint covers operation, collection and entity/id,
with sorted JSON object keys, excluding `expectedRevision`. UUID casing is
normalized. Receipts are SHA256 strings in `data._operations` and are committed
atomically with the mutation; they do not store request bodies or PII.

The state contract is `{ revision, data, readOnly, appliedOperationIds }`, where
`appliedOperationIds` contains the persisted receipt keys. Replays return the
current state, even after reopening or subsequent mutations, without another
commit or timestamp update. Reusing an UUID for different content returns
`invalid_request`; stale new operations still return `conflict`.

Additional coverage: missing/invalid UUIDs; stale creation replay after reopening
and JSON property reordering; mismatched entity/collection/operation/delete id;
update replay after entity deletion; repeated stale deletion; receipt contents
and exact SHA256; eight parallel callers with the same operation yielding one
entity, revision, receipt and audit entry; and a real pending journal in
read-only mode returning `recovery_required` without changing any files,
followed by writable recovery. Replay tests compare all store files byte-for-byte.

The recovery mapping requires Storage's `StoreRecoveryRequiredException` subtype
of `StoreReadOnlyException`, thrown for pending journals in read-only mode.
Ordinary write denial continues to map to `read_only`.
