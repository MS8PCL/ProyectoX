using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ProyectoX.Desktop;
using ProyectoX.Storage;

internal static class ImportedDocumentsTests
{
    public static async Task RunAsync(string temporaryParent)
    {
        var root = Path.Combine(temporaryParent, "imported-fixture");
        var folder = Path.Combine(root, "pocketbase-storage", "imports_storage_id", "import001");
        Directory.CreateDirectory(folder);
        var bytes = Encoding.UTF8.GetBytes("%PDF imported original\0\xff");
        var original = Path.Combine(folder, "opaque_cv.pdf");
        await File.WriteAllBytesAsync(original, bytes);
        var store = new SharedStore(root);
        var initial = await store.ReadAsync();
        initial.Data["listings"]!.AsArray().Add(new JsonObject { ["id"] = "listing001", ["ownerUserId"] = "company001" });
        initial.Data["candidates"]!.AsArray().Add(new JsonObject { ["id"] = "profile001", ["userId"] = "user001", ["email"] = "old@example.test" });
        initial.Data["applications"]!.AsArray().Add(new JsonObject { ["id"] = "application001", ["candidateUserId"] = "profile001", ["listingId"] = "listing001" });
        initial.Data["applications"]!.AsArray().Add(new JsonObject { ["id"] = "application002", ["candidateUserId"] = "profile001", ["listingId"] = "listing002" });
        var import = new JsonObject
        {
            ["id"] = "import001", ["collectionId"] = "imports_storage_id", ["userId"] = "user001",
            ["applicationId"] = "application001", ["kind"] = "cv", ["file"] = "opaque_cv.pdf", ["created"] = "2025-01-01",
            // Raw strings must never influence the selected file.
            ["storagePath"] = "C:/external/secret.pdf", ["url"] = "https://external.test/secret.pdf",
            ["_desktopFiles"] = new JsonObject { ["file"] = new JsonArray(Entry("import001", "opaque_cv.pdf", bytes)) }
        };
        initial.Data["profile_imports"] = new JsonArray(import);
        await store.CommitAsync(0, initial.Data, "fixture");
        var baseline = (await store.ReadAsync()).Data;
        var staff = new DesktopIdentity("staff", "", "rrhh", "Staff");
        var api = new DocumentApi(store, root, false, staff);
        const string docPath = "/interno/applications/application001/documents/import001";
        var listed = await api.HandleAsync(new JsonObject { ["path"] = "/interno/applications/application001/documents" }, default);
        Check(listed["items"]!.AsArray().Count == 1 && listed["items"]![0]!["docType"]!.GetValue<string>() == "cv", "PB import listed without kind=document");
        Check(!(await store.ReadAsync()).Data.ContainsKey("documents"), "imported reads require no documents array");
        var opened = await api.PrepareExportAsync(docPath, default);
        Check(opened.Bytes.SequenceEqual(bytes) && opened.FileName == "opaque_cv.pdf" && opened.Mime == "application/pdf", "PB native open");
        var descriptor = await api.HandleAsync(new JsonObject { ["path"] = docPath }, default);
        Check(descriptor["path"]!.GetValue<string>() == "/documents/import001", "descriptor uses PB record id");
        Check((await api.PrepareExportAsync("/documents/import001", default)).Bytes.SequenceEqual(bytes), "direct PB document path");
        var cv = await api.HandleAsync(new JsonObject { ["path"] = "/company/candidates/profile001/cv" }, default);
        Check(cv["url"]!.GetValue<string>() == "/documents/import001", "PB cv url shape");
        foreach (var zipPath in new[] { "/interno/applications/application001/export.zip", "/interno/listings/listing001/export.zip" })
        {
            var exported = await api.PrepareExportAsync(zipPath, default);
            using var zip = new ZipArchive(new MemoryStream(exported.Bytes));
            var document = zip.GetEntry("documents/import001/opaque_cv.pdf") ?? throw new Exception("Imported document missing in zip");
            using var content = new MemoryStream(); await document.Open().CopyToAsync(content);
            Check(content.ToArray().SequenceEqual(bytes), "PB zip verified bytes");
        }
        var readOnly = new DocumentApi(new SharedStore(root, true), root, true, staff);
        Check((await readOnly.PrepareExportAsync(docPath, default)).Bytes.SequenceEqual(bytes), "PB read-only open");
        var owner = new DocumentApi(store, root, false, new DesktopIdentity("user001", "", "candidato", "Owner"));
        Check((await owner.PrepareExportAsync("/documents/import001", default)).Bytes.SequenceEqual(bytes), "PB owner access");
        var outsider = new DocumentApi(store, root, false, new DesktopIdentity("outsider", "", "candidato", "Other"));
        await Reject(() => outsider.PrepareExportAsync("/documents/import001", default), "forbidden");
        await Reject(() => api.PrepareExportAsync("/interno/applications/application002/documents/import001", default), "forbidden");
        var otherDocs = await api.HandleAsync(new JsonObject { ["path"] = "/interno/applications/application002/documents" }, default);
        Check(otherDocs["items"]!.AsArray().Count == 0, "explicit app binding never leaks to sibling application");

        // Candidate-only imports are shared with related applications, supporting both
        // PB user IDs and canonical candidate profile IDs without equating unrelated IDs.
        foreach (var reference in new[] { "user001", "profile001" })
        {
            await WithMutationAsync(store, baseline, data =>
            {
                var row = Import(data); row["applicationId"] = ""; row["userId"] = reference;
            }, async () =>
            {
                Check((await api.HandleAsync(new JsonObject { ["path"] = "/interno/applications/application001/documents" }, default))["items"]!.AsArray().Count == 1, "candidate fallback listed");
                Check((await api.PrepareExportAsync(docPath, default)).Bytes.SequenceEqual(bytes), "candidate fallback open");
                using var zip = new ZipArchive(new MemoryStream((await api.PrepareExportAsync("/interno/applications/application001/export.zip", default)).Bytes));
                Check(zip.GetEntry("documents/import001/opaque_cv.pdf") is not null, "candidate fallback zip");
            });
        }
        await WithMutationAsync(store, baseline, data =>
        {
            var row = Import(data); row.Remove("userId"); row.Remove("applicationId"); row["candidateUserId"] = "profile001";
        }, async () => Check((await api.PrepareExportAsync(docPath, default)).Bytes.SequenceEqual(bytes), "explicit candidateUserId relationship"));
        await WithMutationAsync(store, baseline, data => Import(data)["userId"] = "unrelated", async () =>
        {
            await Reject(() => api.PrepareExportAsync(docPath, default), "forbidden");
            Check((await api.HandleAsync(new JsonObject { ["path"] = "/interno/applications/application001/documents" }, default))["items"]!.AsArray().Count == 0, "mismatched candidate not listed");
        });

        foreach (var path in new[]
        {
            "../secret.pdf", "/pocketbase-storage/imports_storage_id/import001/opaque_cv.pdf", "C:/secret.pdf",
            "documents/imports_storage_id/import001/opaque_cv.pdf", "pocketbase-storage/../import001/opaque_cv.pdf",
            "pocketbase-storage/imports_storage_id/import001/../opaque_cv.pdf", "pocketbase-storage/imports_storage_id/import001/%2e%2e",
            "pocketbase-storage/imports_storage_id/import001/opaque%2fcv.pdf", "pocketbase-storage/imports_storage_id/import001/opaque%5ccv.pdf",
            "pocketbase-storage\\imports_storage_id\\import001\\opaque_cv.pdf", "pocketbase-storage/imports_storage_id/import002/opaque_cv.pdf",
            "pocketbase-storage/other/import001/opaque_cv.pdf", "pocketbase-storage/imports_storage_id/import001/opaque_cv.pdf:stream"
        })
            await WithMutationAsync(store, baseline, data => Mapping(data)["relativePath"] = path,
                () => Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request"));
        await WithMutationAsync(store, baseline, data => Mapping(data)["sha256"] = new string('0', 64), async () =>
        {
            await Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request");
            await Reject(() => api.PrepareExportAsync("/interno/applications/application001/export.zip", default), "invalid_request");
        });
        await WithMutationAsync(store, baseline, data => Mapping(data)["size"] = bytes.Length + 1,
            () => Reject(() => api.PrepareExportAsync(docPath, default), "store_unavailable"));
        await WithMutationAsync(store, baseline, data => Mapping(data)["size"] = DocumentApi.MaxFileBytes + 1,
            () => Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request"));
        await WithMutationAsync(store, baseline, data => Mapping(data)["sha256"] = "unknown",
            () => Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request"));
        await WithMutationAsync(store, baseline, data => Mapping(data)["fileName"] = "different.pdf",
            () => Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request"));
        await WithMutationAsync(store, baseline, data => Import(data).Remove("_desktopFiles"), async () =>
        {
            await Reject(() => api.PrepareExportAsync(docPath, default), "unsupported_operation");
            await Reject(() => api.PrepareExportAsync("/interno/applications/application001/export.zip", default), "unsupported_operation");
        });
        await WithMutationAsync(store, baseline, data => Import(data)["_desktopFiles"] = new JsonObject { ["attachments"] = new JsonArray(Mapping(data).DeepClone()) },
            () => Reject(() => api.PrepareExportAsync(docPath, default), "unsupported_operation"));
        await WithMutationAsync(store, baseline, data => ((JsonObject)Import(data)["_desktopFiles"]!)["file"] = new JsonArray(),
            () => Reject(() => api.PrepareExportAsync(docPath, default), "unsupported_operation"));

        await WithMutationAsync(store, baseline, data => Mapping(data).Remove("sha256"),
                    () => Reject(() => api.PrepareExportAsync(docPath, default), "unsupported_operation"));
                await WithMutationAsync(store, baseline, data => Mapping(data)["storagePath"] = "C:/external/secret.pdf",
                    () => Reject(() => api.PrepareExportAsync(docPath, default), "unsupported_operation"));
                var changedBytes = (byte[])bytes.Clone(); changedBytes[0] ^= 1;
                await File.WriteAllBytesAsync(original, changedBytes);
                try
                {
                    await Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request");
                    await Reject(() => api.PrepareExportAsync("/interno/applications/application001/export.zip", default), "invalid_request");
                }
                finally { await File.WriteAllBytesAsync(original, bytes); }

                // 'files' is a supported schema alias, including PB's raw JSON-string arrays.
        foreach (var encoded in new[] { false, true })
        {
            await WithMutationAsync(store, baseline, data =>
            {
                var row = Import(data); row.Remove("file"); row["files"] = encoded ? JsonValue.Create("[\"opaque_cv.pdf\"]") : new JsonArray("opaque_cv.pdf");
                var mapping = (JsonObject)row["_desktopFiles"]!; mapping["files"] = mapping["file"]!.DeepClone(); mapping.Remove("file");
            }, async () => Check((await api.PrepareExportAsync(docPath, default)).Bytes.SequenceEqual(bytes), "files alias exact mapping"));
        }
        var secondBytes = Encoding.UTF8.GetBytes("%PDF second imported file");
        await File.WriteAllBytesAsync(Path.Combine(folder, "second.pdf"), secondBytes);
        await WithMutationAsync(store, baseline, data =>
        {
            var row = Import(data); row["file"] = new JsonArray("opaque_cv.pdf", "second.pdf");
            ((JsonArray)row["_desktopFiles"]!["file"]!).Add(Entry("import001", "second.pdf", secondBytes));
        }, async () =>
        {
            await Reject(() => api.PrepareExportAsync(docPath, default), "unsupported_operation");
            using var zip = new ZipArchive(new MemoryStream((await api.PrepareExportAsync("/interno/applications/application001/export.zip", default)).Bytes));
            Check(zip.Entries.Count == 3 && zip.GetEntry("documents/import001/second.pdf") is not null, "zip includes all mapped files");
        });

        // A real junction/symlink at each directory ancestor must be rejected before reading.
        foreach (var directory in new[] { Path.Combine(root, "pocketbase-storage"), Path.GetDirectoryName(folder)!, folder })
        {
            var moved = directory + "-original";
            Directory.Move(directory, moved);
            try
            {
                await CreateDirectoryLinkAsync(directory, moved);
                await Reject(() => api.PrepareExportAsync(docPath, default), "store_unavailable");
                await Reject(() => api.PrepareExportAsync("/interno/applications/application001/export.zip", default), "store_unavailable");
            }
            finally
            {
                if (Directory.Exists(directory)) Directory.Delete(directory);
                Directory.Move(moved, directory);
            }
        }
        // A later local write must retain imported records and original byte paths exactly.
        var beforeWrite = await store.ReadAsync();
        var request = new JsonObject
        {
            ["path"] = "/interno/listings/listing001/import_candidate", ["method"] = "POST", ["expectedRevision"] = beforeWrite.Revision,
            ["operationId"] = Guid.NewGuid().ToString("D"), ["body"] = new JsonObject { ["parts"] = new JsonArray(
                Field("firstName", "Updated"), Field("lastName", "Person"), Field("email", "old@example.test"),
                Field("birthDate", "1990-01-01"), Field("coverLetter", "Local import"),
                new JsonObject { ["name"] = "cv", ["fileName"] = "new.pdf", ["mime"] = "application/pdf", ["size"] = bytes.Length, ["base64"] = Convert.ToBase64String(bytes) }) }
        };
        await api.HandleAsync(request, default);
        var afterWrite = await store.ReadAsync();
        Check(JsonNode.DeepEquals(Import(afterWrite.Data), Import(baseline)), "new write preserves imported metadata");
        Check((await File.ReadAllBytesAsync(original)).SequenceEqual(bytes), "new write preserves original PB bytes");
        Check(afterWrite.Data["documents"]!.AsArray().Count == 1 && Guid.TryParse(afterWrite.Data["documents"]![0]!["id"]!.GetValue<string>(), out _), "new documents still use UUID storage");
        Check((await api.PrepareExportAsync(docPath, default)).Bytes.SequenceEqual(bytes), "PB open after local write");
        Console.WriteLine("PASS: imported PB documents, verified mappings, relations, paths, hashes, ZIP, reparse ancestors and originals");
    }

    private static async Task WithMutationAsync(SharedStore store, JsonObject baseline, Action<JsonObject> mutate, Func<Task> test)
    {
        var before = await store.ReadAsync(); var changed = (JsonObject)baseline.DeepClone(); mutate(changed);
        await store.CommitAsync(before.Revision, changed, "mutation-test");
        try { await test(); }
        finally { var current = await store.ReadAsync(); await store.CommitAsync(current.Revision, baseline, "restore-fixture"); }
    }
    private static async Task CreateDirectoryLinkAsync(string link, string target)
    {
        if (!OperatingSystem.IsWindows()) { Directory.CreateSymbolicLink(link, target); return; }
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        using var process = System.Diagnostics.Process.Start(start) ?? throw new Exception("Cannot create junction fixture");
        await process.WaitForExitAsync(); Check(process.ExitCode == 0, "create imported temp junction");
    }
    private static JsonObject Entry(string id, string name, byte[] bytes) => new()
    {
        ["fileName"] = name, ["relativePath"] = $"pocketbase-storage/imports_storage_id/{id}/{name}",
        ["size"] = bytes.Length, ["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant()
    };
    private static JsonObject Import(JsonObject data) => (JsonObject)data["profile_imports"]![0]!;
    private static JsonObject Mapping(JsonObject data) => (JsonObject)Import(data)["_desktopFiles"]!["file"]![0]!;
    private static JsonObject Field(string name, string value) => new() { ["name"] = name, ["value"] = value };
    private static void Check(bool condition, string message) { if (!condition) throw new Exception("FAIL: " + message); }
    private static async Task Reject(Func<Task> action, string code)
    {
        try { await action(); }
        catch (LegacyApiException ex) when (ex.Code == code) { return; }
        throw new Exception("Expected " + code);
    }
}
