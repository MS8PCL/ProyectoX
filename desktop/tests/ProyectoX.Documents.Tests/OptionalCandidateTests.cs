using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using ProyectoX.Desktop;
using ProyectoX.Storage;

internal static class OptionalCandidateTests
{
    public static async Task RunAsync(string parent)
    {
        await RunLongPathsAsync(parent);
        var root = Path.Combine(parent, "optional"); Directory.CreateDirectory(root);
        var store = new SharedStore(root);
        var api = new DocumentApi(store, root, false, new DesktopIdentity("staff", "", "rrhh", "Staff"));
        var seed = await store.ReadAsync();
        seed.Data["listings"]!.AsArray().Add(new JsonObject { ["id"] = "listing", ["title"] = "CON / Investigación: clínica ✨", ["ownerUserId"] = "company" });
        await store.CommitAsync(0, seed.Data, "seed");
        async Task<JsonObject> Import(params JsonObject[] parts) => await api.HandleAsync(new JsonObject
        {
            ["path"] = "/interno/listings/listing/import_candidate", ["method"] = "POST", ["operationId"] = Guid.NewGuid().ToString("D"),
            ["expectedRevision"] = (await store.ReadAsync()).Revision, ["body"] = new JsonObject { ["parts"] = new JsonArray(parts.Cast<JsonNode?>().ToArray()) }
        }, default);
        var empty = await Import();
        var blank = await Import(Field("firstName", ""), Field("lastName", ""), Field("email", ""), Field("birthDate", ""), Field("coverLetter", ""));
        Check(S(empty, "candidateProfileId") != S(blank, "candidateProfileId"), "empty emails never merge");
        var state = (await store.ReadAsync()).Data;
        Check(state["candidates"]!.AsArray().All(c => string.IsNullOrEmpty(c?["email"]?.GetValue<string>()) && string.IsNullOrEmpty(c?["fullName"]?.GetValue<string>())), "no invented personal data");
        Check(!Directory.Exists(Path.Combine(root, "Candidaturas")), "no files means no document directories");
        var person = await Import(Field("firstName", "María"), Field("lastName", "Muñoz 李"), Field("email", "PERSON@example.test"), Field("birthDate", "1990-01-01"), Field("coverLetter", "Carta"));
        var again = await Import(Field("firstName", ""), Field("lastName", ""), Field("email", "person@example.test"), Field("birthDate", ""), Field("coverLetter", ""));
        Check(S(person, "candidateProfileId") == S(again, "candidateProfileId") && S(person, "applicationId") == S(again, "applicationId"), "email reuses person and application");
        state = (await store.ReadAsync()).Data;
        var candidate = state["candidates"]!.AsArray().Single(c => c?["id"]?.GetValue<string>() == S(person, "candidateProfileId"))!;
        var app = state["applications"]!.AsArray().Single(a => a?["id"]?.GetValue<string>() == S(person, "applicationId"))!;
        Check(candidate["firstName"]!.GetValue<string>() == "María" && candidate["fullName"]!.GetValue<string>() == "María Muñoz 李" && app["birthDate"]!.GetValue<string>() == "1990-01-01" && app["coverLetter"]!.GetValue<string>() == "Carta", "empty imports preserve existing fields");
        foreach (var bad in new[] { Field("email", "invalid"), Field("firstName", new string('x', 81)), Field("lastName", new string('x', 121)), Field("coverLetter", new string('x', 5001)), Field("birthDate", "not-a-date") })
            await Reject(() => Import(bad), "invalid_request");
        await Reject(() => Import(FilePart("cv", "a.pdf"), FilePart("cv", "b.pdf")), "invalid_request");
        await Reject(() => Import(FilePart("unknown", "a.pdf")), "invalid_request");
        await Reject(() => Import(FilePart("attachments", "a.pdf", "image/png")), "invalid_request");
        var attached = await Import(Field("email", "person@example.test"), FilePart("cv", "Currículum 李.pdf", ""), FilePart("attachments", "Currículum 李.pdf"), FilePart("attachments", "run.exe", "application/x-msdownload"), FilePart("certificates", "tabla.xlsx", ""));
        var unnamed = await Import(FilePart("attachments", "unknown.custom", ""));
        state = (await store.ReadAsync()).Data;
        var documents = state["documents"]!.AsArray().OfType<JsonObject>().ToArray();
        Check(documents.Length == 5, "cv certificates attachments multivalued");
        foreach (var doc in documents)
        {
            var relative = S(doc, "relativePath"); var segments = relative.Split('/');
            Check(segments.Length == 5 && segments[0] == "Candidaturas" && segments[3] == "Ficheros de interes" && segments[4].StartsWith(S(doc, "id") + " -- ", StringComparison.Ordinal), "canonical hierarchy and document id");
            Check(segments[1].EndsWith(" -- listing", StringComparison.Ordinal) && segments[2].Contains(" -- ", StringComparison.Ordinal), "unambiguous entity ids");
            Check(File.Exists(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar))), "authoritative file exists");
            var file = await api.PrepareExportAsync("/documents/" + S(doc, "id"), default);
            Check(file.Bytes.SequenceEqual(Encoding.UTF8.GetBytes("fixture")) && file.FileName == S(doc, "fileName"), "original filename and exact bytes");
            if (S(doc, "fileName") == "unknown.custom") Check(segments[2].StartsWith("Sin nombre -- ", StringComparison.Ordinal), "unnamed candidate folder");
            if (S(doc, "fileName") == "run.exe") Check(file.Mime == "application/octet-stream", "generic mime sanitized");
            if (S(doc, "fileName").EndsWith(".pdf", StringComparison.Ordinal)) Check(file.Mime == "application/pdf", "known PDF not confused with generic attachment");
        }
        Check(!Directory.Exists(Path.Combine(root, "documents")), "no redundant bin copies");
        Check(Directory.GetFiles(Path.Combine(root, "Candidaturas"), "*", SearchOption.AllDirectories).Length == documents.Length, "one authoritative file per document");
        using (var zip = new ZipArchive(new MemoryStream((await api.PrepareExportAsync("/interno/listings/listing/export.zip", default)).Bytes)))
            Check(zip.Entries.Count == 6, "duplicate names retain distinct document ids in ZIP");
        // Duplicate references to one document must not duplicate its ZIP entry.
        var before = await store.ReadAsync();
        var copy = (JsonObject)before.Data["profile_imports"]![0]!.DeepClone(); copy["id"] = Guid.NewGuid().ToString("D"); before.Data["profile_imports"]!.AsArray().Add(copy);
        await store.CommitAsync(before.Revision, before.Data, "duplicate-reference");
        using (var zip = new ZipArchive(new MemoryStream((await api.PrepareExportAsync("/interno/listings/listing/export.zip", default)).Bytes))) Check(zip.Entries.Count == 6, "ZIP dedup by document id");
        // Mutations are restored between tests; both single reads and ZIP exports verify metadata.
        var baseline = (await store.ReadAsync()).Data;
        var first = documents[0]; var docPath = "/documents/" + S(first, "id");
        async Task Mutation(string key, JsonNode value, string code)
        {
            var current = await store.ReadAsync(); var changed = (JsonObject)baseline.DeepClone(); changed["documents"]![0]![key] = value;
            await store.CommitAsync(current.Revision, changed, "mutation");
            try { await Reject(() => api.PrepareExportAsync(docPath, default), code); await Reject(() => api.PrepareExportAsync("/interno/listings/listing/export.zip", default), code); }
            finally { current = await store.ReadAsync(); await store.CommitAsync(current.Revision, baseline, "restore"); }
        }
        foreach (var path in new[] { "../evil", S(first, "relativePath").Replace("Candidaturas/", "documents/"), S(first, "relativePath").Replace("Ficheros de interes", ".."), S(first, "relativePath").Replace(S(first, "id"), Guid.NewGuid().ToString("D")), S(first, "relativePath") + "/extra", S(first, "relativePath").Replace("/", "\\"), S(first, "relativePath").Replace("Ficheros de interes", "%2e%2e") }) await Mutation("relativePath", JsonValue.Create(path)!, "invalid_request");
        await Mutation("sha256", JsonValue.Create(new string('0', 64))!, "invalid_request");
        await Mutation("size", JsonValue.Create(999)!, "store_unavailable");
        var physical = Path.Combine(root, S(first, "relativePath").Replace('/', Path.DirectorySeparatorChar));
        await System.IO.File.WriteAllBytesAsync(physical, Encoding.UTF8.GetBytes("changed"));
        await Reject(() => api.PrepareExportAsync(docPath, default), "invalid_request");
        await System.IO.File.WriteAllBytesAsync(physical, Encoding.UTF8.GetBytes("fixture"));
        var segmentsToLink = S(first, "relativePath").Split('/');
        for (var depth = 1; depth <= 4; depth++)
        {
            var directory = Path.Combine(root, Path.Combine(segmentsToLink.Take(depth).ToArray())); var moved = directory + "-original";
            Directory.Move(directory, moved);
            try
            {
                if (OperatingSystem.IsWindows())
                {
                    using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{directory}\" \"{moved}\"") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true })!;
                    await process.WaitForExitAsync(); Check(process.ExitCode == 0, "junction fixture");
                }
                else Directory.CreateSymbolicLink(directory, moved);
                await Reject(() => api.PrepareExportAsync(docPath, default), "store_unavailable");
                await Reject(() => api.PrepareExportAsync("/interno/listings/listing/export.zip", default), "store_unavailable");
                await Reject(() => Import(Field("email", "person@example.test"), FilePart("attachments", "blocked.txt")), "store_unavailable");
            }
            finally { if (Directory.Exists(directory)) Directory.Delete(directory); Directory.Move(moved, directory); }
        }
        // Reflection keeps the initial fail-before run compilable before the public helper exists.
        var canOpen = typeof(DocumentApi).GetMethod("CanOpenNatively", new[] { typeof(string) }) ?? throw new Exception("Missing native-open helper");
        foreach (var extension in new[] { "pdf", "doc", "docx", "txt", "csv", "png", "jpg", "jpeg", "gif", "bmp", "xlsx", "xls", "ppt", "pptx" }) Check((bool)canOpen.Invoke(null, new object[] { "Résumé." + extension.ToUpperInvariant() })!, "native allowlist " + extension);
        foreach (var name in new[] { "a.exe", "a.cmd", "a.ps1", "a.js", "a.html", "a.svg", "a.docm", "a.xlsm", "a.pptm", "a.lnk", "a.pdf.exe", "../a.pdf", "CON.pdf", "a.pdf ", "a.pdf:stream", "" }) Check(!(bool)canOpen.Invoke(null, new object[] { name })!, "native deny " + name);
        // Empty browser File.type must work through begin/chunk/finish and a multipart
        // reference retaining that empty type, for known and arbitrary extensions alike.
        foreach (var name in new[] { "chunk.docx", "chunk.custom" })
        {
            var bytes = Encoding.UTF8.GetBytes("fixture"); var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes));
            var begin = await api.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = name, ["mime"] = "", ["size"] = bytes.Length }, default);
            var uploadId = begin["uploadId"]!.GetValue<string>();
            await api.HandleUploadAsync("uploadChunk", new JsonObject { ["uploadId"] = uploadId, ["offset"] = 0, ["base64"] = Convert.ToBase64String(bytes), ["sha256"] = hash }, default);
            var part = await api.HandleUploadAsync("uploadFinish", new JsonObject { ["uploadId"] = uploadId, ["sha256"] = hash }, default);
            part["name"] = "attachments"; part["mime"] = "";
            await Import(part);
        }
        foreach (var name in new[] { "../evil.pdf", "CON.pdf", "LPT¹.pdf", "bad:stream", "trailing.pdf.", "bad\\name.pdf" }) await Reject(() => Import(FilePart("attachments", name)), "invalid_request");
        await Reject(() => Import(FilePart("attachments", "bad.custom", "application/octet-stream\r\nX-Evil: yes")), "invalid_request");
        await Reject(() => Import(new JsonObject { ["name"] = "attachments", ["fileName"] = "oversized.bin", ["mime"] = "", ["size"] = DocumentApi.MaxFileBytes + 1, ["base64"] = "AA==" }), "invalid_request");
        var beforeTotal = await store.ReadAsync();
        await Reject(() => Import(new JsonObject { ["name"] = "attachments", ["fileName"] = "a.bin", ["size"] = DocumentApi.MaxFileBytes, ["uploadId"] = "unknown" }, new JsonObject { ["name"] = "attachments", ["fileName"] = "b.bin", ["size"] = 15 * 1024 * 1024, ["uploadId"] = "unknown" }), "invalid_request");
        Check((await store.ReadAsync()).Revision == beforeTotal.Revision, "total limit rejected before commit");
        // Profile uploads keep the old authoritative documents/<id>.bin layout readable.
        var legacyResult = await api.HandleAsync(new JsonObject
        {
            ["path"] = "/profile/imports/file", ["method"] = "POST", ["operationId"] = Guid.NewGuid().ToString("D"), ["expectedRevision"] = (await store.ReadAsync()).Revision,
            ["body"] = new JsonObject { ["parts"] = new JsonArray(Field("docType", "other"), FilePart("file", "legacy.txt", "text/plain; charset=utf-8")) }
        }, default);
        var legacyId = legacyResult["item"]!["documentId"]!.GetValue<string>();
        Check(File.Exists(Path.Combine(root, "documents", legacyId + ".bin")), "legacy bin compatibility");
        Check((await api.PrepareExportAsync("/documents/" + legacyId, default)).Bytes.SequenceEqual(Encoding.UTF8.GetBytes("fixture")), "legacy verified read");
        // Long Windows-unsafe labels and long original filenames are sanitized/truncated,
        // while the metadata retains the original Unicode name and full opaque IDs.
        var longSeed = await store.ReadAsync(); longSeed.Data["listings"]![0]!["title"] = "NUL " + new string('x', 200) + ":/\\?*";
        await store.CommitAsync(longSeed.Revision, longSeed.Data, "long-title");
        var longName = new string('é', 200) + " 李.doc";
        var longResult = await Import(Field("firstName", new string('名', 80)), Field("lastName", new string('姓', 120)), FilePart("attachments", longName));
        var longState = (await store.ReadAsync()).Data;
        var longDoc = longState["documents"]!.AsArray().OfType<JsonObject>().Last(); var longPath = Path.Combine(root, S(longDoc, "relativePath").Replace('/', Path.DirectorySeparatorChar));
        Check(longPath.Length <= 1024 && File.Exists(longPath) && S(longDoc, "fileName") == longName, "long-path budget and original Unicode metadata");
                var longSegments = S(longDoc, "relativePath").Split('/');
                Check(longSegments.All(s => s.Length <= 240) && longSegments[1].Split(" -- ")[0].Length == 48 && longSegments[2].Split(" -- ")[0].Length == 48 && longSegments[4].Split(" -- ")[1].Length == 120, "descriptive labels and original filename have independent truncation limits");
        Check((await api.PrepareExportAsync("/documents/" + S(longDoc, "id"), default)).FileName == longName, "long original name survives export");
        // The same uncertain-commit protocol must retain the single organized file,
        // with no postcommit projection, move, copy, or second file on replay.
        var beforeUncertain = await store.ReadAsync();
        var diskBefore = Directory.GetFiles(Path.Combine(root, "Candidaturas"), "*", SearchOption.AllDirectories).ToHashSet(StringComparer.Ordinal);
        var uncertainRequest = new JsonObject
        {
            ["path"] = "/interno/listings/listing/import_candidate", ["method"] = "POST", ["operationId"] = Guid.NewGuid().ToString("D"), ["expectedRevision"] = beforeUncertain.Revision,
            ["body"] = new JsonObject { ["parts"] = new JsonArray(FilePart("attachments", "uncertain.bin")) }
        };
        var publishedBeforeCommit = false;
        store.FailureHook = stage =>
        {
            if (stage != CommitStage.JournalPublished) return;
            var added = Directory.GetFiles(Path.Combine(root, "Candidaturas"), "*", SearchOption.AllDirectories).Where(p => !diskBefore.Contains(p)).ToArray();
            publishedBeforeCommit = added.Length == 1 && System.IO.File.ReadAllBytes(added[0]).SequenceEqual(Encoding.UTF8.GetBytes("fixture"));
            throw new IOException("Injected organized uncertain commit");
        };
        try { await api.HandleAsync(uncertainRequest, default); throw new Exception("Expected uncertain commit"); }
        catch (StoreUnavailableException) { }
        finally { store.FailureHook = null; }
        Check(publishedBeforeCommit, "single authoritative organized file is durable before commit");
        var recovered = await store.ReadAsync();
        var replay = await api.HandleAsync(uncertainRequest, default);
        Check((await store.ReadAsync()).Revision == recovered.Revision && Directory.GetFiles(Path.Combine(root, "Candidaturas"), "*", SearchOption.AllDirectories).Length == diskBefore.Count + 1, "organized uncertain replay adds no copy or commit");
        var recoveredImport = recovered.Data["profile_imports"]!.AsArray().OfType<JsonObject>().Single(i => i["applicationId"]?.GetValue<string>() == S(replay, "applicationId"));
        Check((await api.PrepareExportAsync(S(recoveredImport, "url"), default)).Bytes.SequenceEqual(Encoding.UTF8.GetBytes("fixture")), "organized recovered read");
        Console.WriteLine("PASS: optional candidates, preservation, attachment hierarchy, MIME/chunks, duplicate Unicode names, ZIP, integrity, reparse, native-open allowlist, long paths, legacy bins and precommit recovery");
    }
    private static async Task RunLongPathsAsync(string parent)
    {
        // Valid Windows components, realistic deep data root and full real-world GUIDs.
        static string DeepRoot(string parentPath, string label, int length)
        {
            var path = Path.GetFullPath(Path.Combine(parentPath, label));
            while (path.Length < length)
                path = length - path.Length == 1 ? path + "r" : Path.Combine(path, new string('r', Math.Min(100, length - path.Length - 1)));
            Directory.CreateDirectory(path);
            return path;
        }
        foreach (var excessive in new[] { false, true })
        {
            var root = DeepRoot(parent, excessive ? "excessive" : "realistic", excessive ? 1000 : 320);
            var store = new SharedStore(root);
            var api = new DocumentApi(store, root, false, new DesktopIdentity("staff", "", "rrhh", "Staff"));
            var listingId = Guid.NewGuid().ToString("D"); var candidateId = Guid.NewGuid().ToString("D");
            var seed = await store.ReadAsync();
            seed.Data["listings"]!.AsArray().Add(new JsonObject { ["id"] = listingId, ["ownerUserId"] = "company", ["title"] = new string('P', 100) });
            seed.Data["candidates"]!.AsArray().Add(new JsonObject { ["id"] = candidateId, ["email"] = "long@example.test", ["firstName"] = new string('名', 80), ["lastName"] = new string('姓', 120) });
            await store.CommitAsync(seed.Revision, seed.Data, "long-path-seed");
            var before = await store.ReadAsync();
            var original = new string('é', 200) + ".pdf";
            var request = new JsonObject
            {
                ["path"] = $"/interno/listings/{listingId}/import_candidate", ["method"] = "POST", ["operationId"] = Guid.NewGuid().ToString("D"), ["expectedRevision"] = before.Revision,
                ["body"] = new JsonObject { ["parts"] = new JsonArray(Field("email", "long@example.test"), FilePart("cv", original)) }
            };
            if (excessive)
            {
                await Reject(() => api.HandleAsync(request, default), "invalid_request");
                Check((await store.ReadAsync()).Revision == before.Revision && !Directory.Exists(Path.Combine(root, "Candidaturas")), "only excessive total paths rejected before publishing");
                continue;
            }
            var result = await api.HandleAsync(request, default);
            Check(S(result, "candidateProfileId") == candidateId, "long root keeps full candidate GUID");
            var after = await store.ReadAsync(); var doc = (JsonObject)after.Data["documents"]![0]!;
            var relative = S(doc, "relativePath"); var segments = relative.Split('/');
            var physical = Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar));
            Check(physical.Length > 260 && physical.Length <= 1024 && File.Exists(physical), "normal Windows long path published");
            Check(segments.Length == 5 && segments.All(s => s.Length <= 240) && segments[1].EndsWith(" -- " + listingId, StringComparison.Ordinal) && segments[2].EndsWith(" -- " + candidateId, StringComparison.Ordinal), "full GUIDs and bounded canonical components");
            Check(!relative.Contains('\\') && !relative.Contains('?') && !relative.StartsWith('/'), "metadata has no extended-path prefix");
            var readOnly = new DocumentApi(new SharedStore(root, true), root, true, new DesktopIdentity("staff", "", "rrhh", "Staff"));
            Check((await readOnly.PrepareExportAsync("/documents/" + S(doc, "id"), default)).FileName == original, "read-only long-path verified read");
            using var zip = new ZipArchive(new MemoryStream((await readOnly.PrepareExportAsync($"/interno/listings/{listingId}/export.zip", default)).Bytes));
            Check(zip.GetEntry("documents/" + S(doc, "id") + "/" + original) is not null, "long-path ZIP keeps original filename");
            // A canonical five-component path must also enforce the total bound on reads.
            var oversizedRoot = DeepRoot(parent, "oversized-read", 1000);
            var oversizedApi = new DocumentApi(store, oversizedRoot, true, new DesktopIdentity("staff", "", "rrhh", "Staff"));
            await Reject(() => oversizedApi.PrepareExportAsync("/documents/" + S(doc, "id"), default), "invalid_request");
            await Reject(() => oversizedApi.PrepareExportAsync($"/interno/listings/{listingId}/export.zip", default), "invalid_request");
        }
    }
    private static string S(JsonObject value, string key) => value[key]!.GetValue<string>();
    private static JsonObject Field(string name, string value) => new() { ["name"] = name, ["value"] = value };
    private static JsonObject FilePart(string field, string name, string mime = "application/octet-stream") => new() { ["name"] = field, ["fileName"] = name, ["mime"] = mime, ["size"] = 7, ["base64"] = Convert.ToBase64String(Encoding.UTF8.GetBytes("fixture")) };
    private static void Check(bool condition, string message) { if (!condition) throw new Exception("FAIL: " + message); }
    private static async Task Reject(Func<Task> action, string code) { try { await action(); } catch (LegacyApiException ex) when (ex.Code == code) { return; } throw new Exception("Expected " + code); }
}
