# Desktop bridge integration harness

Dependency-free .NET 8 console harness. Links the production `DesktopBridge.cs`,
`StorageBridge.cs`, `LegacyApi.cs`, `DocumentApi.cs` and `HostLog.cs`, and references
`ProyectoX.Storage`. Does not load WPF, WebView, or any GUI.

From the repository root:

```sh
dotnet run --project desktop/tests/ProyectoX.DesktopBridge.Tests/ProyectoX.DesktopBridge.Tests.csproj
```

Exit code: `0` for all passing scenarios, `1` for test failures, `2` for unsupported
arguments. Output contains scenario names, assertion labels, error codes, method
names and counts, not request bodies, filesystem paths or business data.

All fixtures use fresh randomly named directories beneath the OS temporary
folder, synthetic identities and dummy document bytes. Each fixture removes its
own files after the test. No production data or migration copies are read.
There is deliberately no `--inspect-state` command; inspection of actual data is
left to the main workflow.

Coverage:

- Original UI `legacyApi` envelopes with string request IDs, parsed JSON bodies,
  `expectedRevision` and separate UUID `operationId`; Windows-provided `rrhh`
  identity from `GET /me`, initial state and listings.
- Full `createListingServer` payload; candidate import with the original text
  fields plus CV and certificate parts. A CV over 1 MiB travels via bounded
  `uploadBegin`/`uploadChunk`/`uploadFinish` requests with uppercase SHA-256.
  The final multipart request has upload references only. Each serialized
  request stays within 1 MiB in both characters and UTF-8 bytes.
- Applications, candidate profile and document metadata reads; direct native
  `bridge.Documents.PrepareExportAsync` returns exact bytes without GUI actions
  or large base64 responses. Import and hire retries are idempotent.
- Full standalone `/enterprise/hire-profiles` payload from the original Vue
  form, seeded synthetic catalogs and manual IT outbox. Public routes and apply
  tokens are explicitly unsupported.
- Synthetic migration-shaped PocketBase state with `candidate_profiles`, distinct
  profile/user IDs, application bindings and `_desktopFiles` pointers into a
  temporary `pocketbase-storage` tree. Bridge listing, CV resolution, direct
  native export, ZIP bytes, read-only export, unchanged state and tamper rejection.
  This validates migrated-state compatibility, not execution of the migration tool.
- Read-only metadata and native exports; legacy mutations, document writes,
  uploads and original `saveEntity` writes are rejected without changing state.
- Two bridge instances read the same revision; a stale write conflicts, replay
  succeeds, and an explicit refresh permits the next write. Requests are invoked
  sequentially: host serialization belongs to `Main` and is not tested here.
- A previously populated root is moved away. Legacy reads, original `getState`
  and writes return `store_unavailable`, never silent empty state or a recreated
  root. Restoring the temporary directory preserves the original data.
