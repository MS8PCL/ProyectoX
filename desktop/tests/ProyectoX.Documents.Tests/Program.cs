using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ProyectoX.Desktop;
using ProyectoX.Storage;

var root = Path.Combine(Path.GetTempPath(), "px-doc-tests-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(root);
try
{
    var store = new SharedStore(root);
    var staff = new DesktopIdentity("windows-staff", "staff@example.test", "rrhh", "Staff");
    var api = new DocumentApi(store, root, false, staff);
    var snapshot = await store.ReadAsync();
    snapshot.Data["listings"]!.AsArray().Add(new JsonObject { ["id"] = "listing", ["ownerUserId"] = "company" });
    snapshot.Data["candidate_profiles"] = new JsonArray(new JsonObject { ["id"] = "original-id", ["userId"] = "different-user-id", ["email"] = "person@example.test", ["custom"] = "preserved" });
    await store.CommitAsync(0, snapshot.Data, "seed");
    Check(DocumentApi.SupportsPath("/api/interno/applications/a/documents/b"), "dispatch api prefix");
    Check(!DocumentApi.SupportsPath("/profile/imports-evil"), "exact dispatch");
    foreach (var path in new[] { "//evil/documents/a", "/documents/../a", "/documents/%2e%2e", "/documents/%252e", "/documents/a%2fb", "/documents/a\\b", "/documents/%xx" })
        await Reject(() => Task.FromResult(DocumentApi.SupportsPath(path)), "invalid_request");

    var bytes = Encoding.UTF8.GetBytes("%PDF-1.7 test document");
    var begin = await api.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "cv.pdf", ["mime"] = "application/pdf", ["size"] = bytes.Length }, default);
    var id = begin["uploadId"]!.GetValue<string>();
    var chunk = new JsonObject { ["uploadId"] = id, ["offset"] = 0, ["base64"] = Convert.ToBase64String(bytes), ["sha256"] = Hash(bytes) };
    var incomplete = new JsonObject { ["uploadId"] = id, ["sha256"] = Hash(bytes) };
    await Reject(() => api.HandleUploadAsync("uploadFinish", incomplete, default), "invalid_request");
    var bad = (JsonObject)chunk.DeepClone(); bad["sha256"] = new string('0', 64);
    await Reject(() => api.HandleUploadAsync("uploadChunk", bad, default), "invalid_request");
    await api.HandleUploadAsync("uploadChunk", chunk, default);
    await api.HandleUploadAsync("uploadChunk", chunk, default);
    var finished = await api.HandleUploadAsync("uploadFinish", incomplete, default);
    await api.HandleUploadAsync("uploadFinish", incomplete, default);
    Check(!File.Exists(Path.Combine(root, "documents", id + ".bin")), "staging never published");
    var filePart = (JsonObject)finished.DeepClone(); filePart["name"] = "cv";
    var body = new JsonObject { ["parts"] = new JsonArray(
        Field("firstName", "Test"), Field("lastName", "Person"), Field("email", "person@example.test"),
        Field("birthDate", "1990-01-02"), Field("coverLetter", "Letter"), filePart) };
    var request = Request("/interno/listings/listing/import_candidate", body, 1);
    var result = await api.HandleAsync(request, default);
    Check(result["candidateProfileId"]!.GetValue<string>() == "original-id", "profile id, not user id");
    var audit = (await store.ReadAsync()).Data["audit_log"]!.AsArray().OfType<JsonObject>().Last();
    Check(audit["actorUserId"]!.GetValue<string>() == Hash(Encoding.UTF8.GetBytes(staff.Id)), "audit pseudonymises the Windows identity like LegacyApi");
    Check(!audit.ToJsonString().Contains(staff.Id, StringComparison.Ordinal), "no raw Windows identity in the audit");
    Check(audit["action"]!.GetValue<string>() == "POST /interno/listings/:id/import_candidate", "normalised audit route");
    Check(audit["timestamp"]?.GetValue<string>() == audit["at"]!.GetValue<string>() && audit["user"]!.GetValue<string>() == staff.DisplayName, "audit page fields present");
    Check(audit["entity"]!.GetValue<string>() == "/interno/listings/:id/import_candidate" && audit["actorType"]!.GetValue<string>() == "windows", "entity and actor type");
    var appId = result["applicationId"]!.GetValue<string>();
    var after = await store.ReadAsync();
    Check(after.Revision == 2 && after.Data["applications"]!.AsArray().Count == 1, "atomic commit");
    Check(after.Data["candidates"]![0]!["custom"]!.GetValue<string>() == "preserved", "alias fields preserved");
    var replay = await api.HandleAsync(request, default);
    Check(JsonNode.DeepEquals(result, replay) && (await store.ReadAsync()).Revision == 2, "idempotent consumed upload replay");
    var altered = (JsonObject)request.DeepClone(); altered["path"] = "/interno/listings/other/import_candidate";
    await Reject(() => api.HandleAsync(altered, default), "invalid_request");
    var docs = await api.HandleAsync(new JsonObject { ["path"] = $"/interno/applications/{appId}/documents" }, default);
    var doc = docs["items"]![0]!;
    var docPath = $"/interno/applications/{appId}/documents/{doc["id"]!.GetValue<string>()}";
    var prepared = await api.PrepareExportAsync(docPath, default);
    Check(prepared.Bytes.SequenceEqual(bytes) && prepared.FileName == "cv.pdf", "native export bytes");
    var cv = await api.HandleAsync(new JsonObject { ["path"] = "/company/candidates/original-id/cv" }, default);
    Check(cv["url"]!.GetValue<string>().StartsWith("/documents/"), "legacy cv url shape");
    var descriptor = await api.HandleAsync(new JsonObject { ["path"] = docPath }, default);
    Check(descriptor["nativeActionRequired"]!.GetValue<bool>() && !descriptor.ContainsKey("base64"), "no huge bridge reads");
    var zipFile = await api.PrepareExportAsync($"/interno/listings/listing/export.zip", default);
    using (var zip = new ZipArchive(new MemoryStream(zipFile.Bytes)))
        Check(zip.Entries.Count == 2 && zip.GetEntry("manifest.json") is not null, "zip manifest and document");
    var readOnly = new DocumentApi(new SharedStore(root, true), root, true, staff);
    Check((await readOnly.PrepareExportAsync(docPath, default)).Bytes.SequenceEqual(bytes), "read only export");
    await Reject(() => readOnly.HandleAsync(request, default), "read_only");
    await Reject(() => readOnly.HandleUploadAsync("uploadBegin", new JsonObject(), default), "read_only");
    var outsider = new DocumentApi(store, root, false, new DesktopIdentity("outsider", "", "candidato", ""));
    await Reject(() => outsider.PrepareExportAsync(cv["url"]!.GetValue<string>(), default), "forbidden");
    await Reject(() => api.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "../bad.pdf", ["mime"] = "application/pdf", ["size"] = 1 }, default), "invalid_request");
    await Reject(() => api.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "bad.pdf", ["mime"] = "application/pdf", ["size"] = DocumentApi.MaxFileBytes + 1 }, default), "invalid_request");
    await Reject(() => api.HandleAsync(Request("/profile/imports/file", new JsonObject(), 0), default), "conflict");
    var linkRequest = Request("/profile/imports/link", new JsonObject { ["kind"] = "portfolio", ["url"] = "https://example.test/portfolio" }, 2);
    var link = await api.HandleAsync(linkRequest, default);
    Check(link["item"]!["url"]!.GetValue<string>().StartsWith("https://"), "link stored without network");
    var linkReplay = await api.HandleAsync(linkRequest, default);
    Check(JsonNode.DeepEquals(link, linkReplay), "link replay");
    await Reject(() => api.HandleAsync(Request("/profile/imports/link", new JsonObject { ["kind"] = "portfolio", ["url"] = "file:///secret" }, 3), default), "invalid_request");
    var large = new byte[DocumentApi.MaxChunkBytes + 1];
    var next = await api.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "large.pdf", ["mime"] = "application/pdf", ["size"] = large.Length }, default);
    await Reject(() => api.HandleUploadAsync("uploadChunk", new JsonObject { ["uploadId"] = next["uploadId"]!.DeepClone(), ["offset"] = 0, ["base64"] = Convert.ToBase64String(large), ["sha256"] = Hash(large) }, default), "invalid_request");
    var otherHost = new DocumentApi(store, root, false, staff);
    await Reject(() => otherHost.HandleUploadAsync("uploadFinish", new JsonObject { ["uploadId"] = next["uploadId"]!.DeepClone(), ["sha256"] = Hash(large) }, default), "invalid_request");
    // Exercise a real upload larger than the inline bridge budget.
        var bigBytes = new byte[768 * 1024 + 1]; RandomNumberGenerator.Fill(bigBytes);
        var bigBegin = await api.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "big.pdf", ["mime"] = "application/pdf", ["size"] = bigBytes.Length }, default);
        var bigId = bigBegin["uploadId"]!.GetValue<string>();
        for (var offset = 0; offset < bigBytes.Length; offset += DocumentApi.MaxChunkBytes)
        {
            var block = bigBytes.AsSpan(offset, Math.Min(DocumentApi.MaxChunkBytes, bigBytes.Length - offset)).ToArray();
            await api.HandleUploadAsync("uploadChunk", new JsonObject { ["uploadId"] = bigId, ["offset"] = offset, ["base64"] = Convert.ToBase64String(block), ["sha256"] = Hash(block) }, default);
        }
        var bigPart = await api.HandleUploadAsync("uploadFinish", new JsonObject { ["uploadId"] = bigId, ["sha256"] = Hash(bigBytes) }, default);
        bigPart["name"] = "file";
        var bigResult = await api.HandleAsync(Request("/profile/imports/file", new JsonObject { ["parts"] = new JsonArray(Field("docType", "cv"), bigPart) }, 3), default);
        var bigPath = bigResult["item"]!["url"]!.GetValue<string>();
        Check((await api.PrepareExportAsync(bigPath, default)).Bytes.SequenceEqual(bigBytes), "large chunk upload exact bytes");
        var quotaHost = new DocumentApi(store, root, false, staff);
        await quotaHost.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "quota.pdf", ["mime"] = "application/pdf", ["size"] = DocumentApi.MaxFileBytes }, default);
        await Reject(() => quotaHost.HandleUploadAsync("uploadBegin", new JsonObject { ["fileName"] = "quota2.pdf", ["mime"] = "application/pdf", ["size"] = 15 * 1024 * 1024 }, default), "invalid_request");
        var beforeInvalid = await store.ReadAsync();
        var badBody = (JsonObject)body.DeepClone(); badBody["parts"]!.AsArray().RemoveAt(0);
        await Reject(() => api.HandleAsync(Request("/interno/listings/listing/import_candidate", badBody, beforeInvalid.Revision), default), "invalid_request");
        Check((await store.ReadAsync()).Revision == beforeInvalid.Revision, "validation never publishes partial references");
        var unborn = new JsonObject { ["parts"] = new JsonArray(Field("firstName", "Futura"), Field("lastName", "Persona"), Field("email", "futura@example.test"),
            Field("birthDate", DateTime.UtcNow.AddYears(1).ToString("yyyy-MM-dd")), Field("coverLetter", "Carta"),
            new JsonObject { ["name"] = "cv", ["fileName"] = "cv.pdf", ["mime"] = "application/pdf", ["size"] = bytes.Length, ["base64"] = Convert.ToBase64String(bytes) }) };
        await Reject(() => api.HandleAsync(Request("/interno/listings/listing/import_candidate", unborn, beforeInvalid.Revision), default), "invalid_request");
        Check((await store.ReadAsync()).Revision == beforeInvalid.Revision, "a future birth date is rejected without writes");
        await Reject(() => api.HandleUploadAsync("uploadChunk", new JsonObject { ["uploadId"] = next["uploadId"]!.DeepClone(), ["offset"] = long.MaxValue, ["base64"] = Convert.ToBase64String(bytes), ["sha256"] = Hash(bytes) }, default), "invalid_request");
        // Inject an uncertain durable commit. Recovery must keep the published document
        // and replay its receipt rather than creating another reference or deleting it.
        var uncertainBody = new JsonObject { ["parts"] = new JsonArray(Field("docType", "other"), new JsonObject { ["name"] = "file", ["fileName"] = "uncertain.pdf", ["mime"] = "application/pdf", ["size"] = bytes.Length, ["base64"] = Convert.ToBase64String(bytes) }) };
        var uncertainRequest = Request("/profile/imports/file", uncertainBody, beforeInvalid.Revision);
        store.FailureHook = stage => { if (stage == CommitStage.JournalPublished) throw new IOException("Injected uncertain commit"); };
        try { await api.HandleAsync(uncertainRequest, default); throw new Exception("Expected uncertain commit failure"); }
        catch (StoreUnavailableException) { }
        finally { store.FailureHook = null; }
        var recovered = await store.ReadAsync();
        var recoveredResult = await api.HandleAsync(uncertainRequest, default);
        Check((await store.ReadAsync()).Revision == recovered.Revision, "uncertain commit replay without second write");
        Check((await api.PrepareExportAsync(recoveredResult["item"]!["url"]!.GetValue<string>(), default)).Bytes.SequenceEqual(bytes), "uncertain commit document retained");
        using (var canceled = new CancellationTokenSource())
        {
            canceled.Cancel();
            try { await api.PrepareExportAsync(docPath, canceled.Token); throw new Exception("Cancellation ignored"); }
            catch (OperationCanceledException) { }
        }
        var zipBefore = await store.ReadAsync();
            var oversizedData = (JsonObject)zipBefore.Data.DeepClone();
            for (var i = 0; i < 6; i++)
            {
                var fakeId = Guid.NewGuid().ToString("D");
                oversizedData["documents"]!.AsArray().Add(new JsonObject { ["id"] = fakeId, ["size"] = DocumentApi.MaxFileBytes });
                oversizedData["profile_imports"]!.AsArray().Add(new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["applicationId"] = appId, ["documentId"] = fakeId });
            }
            var oversize = await store.CommitAsync(zipBefore.Revision, oversizedData, "zip-limit-test");
            await Reject(() => api.PrepareExportAsync($"/interno/applications/{appId}/export.zip", default), "invalid_request");
            await store.CommitAsync(oversize.Revision, zipBefore.Data, "restore-test-fixture");
            await Reject(() => api.HandleAsync(new JsonObject { ["path"] = "/profile/imports", ["body"] = "{" }, default), "invalid_request");
            await TestReparseAsync(root, store, staff, docPath);
            var diskPath = Path.Combine(root, "documents", after.Data["documents"]![0]!["id"]!.GetValue<string>() + ".bin");
    await File.WriteAllBytesAsync(diskPath, Encoding.UTF8.GetBytes("tampered"));
    await Reject(() => api.PrepareExportAsync(docPath, default), "store_unavailable");
    var missingRoot = Path.Combine(root, "does-not-exist");
    var missing = new DocumentApi(store, missingRoot, false, staff);
    await Reject(() => missing.PrepareExportAsync(docPath, default), "store_unavailable");
    Check(!Directory.Exists(missingRoot), "never create missing root");
    var inlineCv = new JsonObject { ["name"] = "cv", ["fileName"] = "cv.pdf", ["mime"] = "application/pdf", ["size"] = bytes.Length, ["base64"] = Convert.ToBase64String(bytes) };
    var again = new JsonObject { ["parts"] = new JsonArray(
        Field("firstName", "Test"), Field("lastName", "Person"), Field("email", "PERSON@example.test"),
        Field("birthDate", "1990-01-02"), Field("coverLetter", "Letter"), inlineCv) };
    var reimport = await api.HandleAsync(Request("/interno/listings/listing/import_candidate", again, (await store.ReadAsync()).Revision), default);
    Check(reimport["applicationId"]!.GetValue<string>() == appId && reimport["already"]!.GetValue<bool>(), "re-import reuses the application");
    Check((await store.ReadAsync()).Data["applications"]!.AsArray().Count == 1, "no duplicate application");
    Check((await api.HandleAsync(new JsonObject { ["path"] = $"/interno/applications/{appId}/documents" }, default))["items"]!.AsArray().Count == 2, "new CV attached to it");
    Console.WriteLine("PASS: document contracts, temp store, uploads, replay, permissions, export and safety");
        await ImportedDocumentsTests.RunAsync(root);
}
finally { Directory.Delete(root, recursive: true); }

static async Task TestReparseAsync(string root, SharedStore store, DesktopIdentity staff, string docPath)
{
    var safe = Path.Combine(root, "reparse-fixture");
    var target = Path.Combine(root, "reparse-target");
    Directory.CreateDirectory(safe); Directory.CreateDirectory(target);
    var link = Path.Combine(safe, "documents");
    if (OperatingSystem.IsWindows())
    {
        var start = new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c mklink /J \"{link}\" \"{target}\"")
        { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        using var process = System.Diagnostics.Process.Start(start) ?? throw new Exception("Cannot start junction fixture");
        await process.WaitForExitAsync();
        Check(process.ExitCode == 0, "create real temp junction");
    }
    else Directory.CreateSymbolicLink(link, target);
    try
    {
        var unsafeApi = new DocumentApi(store, safe, false, staff);
        await Reject(() => unsafeApi.PrepareExportAsync(docPath, default), "store_unavailable");
        var unsafeRoot = new DocumentApi(store, link, false, staff);
        await Reject(() => unsafeRoot.PrepareExportAsync(docPath, default), "store_unavailable");
        Check(!Directory.EnumerateFileSystemEntries(target).Any(), "reparse target untouched");
    }
    finally { Directory.Delete(link); }
}

static JsonObject Field(string name, string value) => new() { ["name"] = name, ["value"] = value };
static JsonObject Request(string path, JsonObject body, long revision) => new() { ["path"] = path, ["method"] = "POST", ["body"] = body, ["expectedRevision"] = revision, ["operationId"] = Guid.NewGuid().ToString("D") };
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
static void Check(bool condition, string message) { if (!condition) throw new Exception("FAIL: " + message); }
static async Task Reject(Func<Task> action, string code)
{
    try { await action(); }
    catch (LegacyApiException ex) when (ex.Code == code) { return; }
    throw new Exception("Expected " + code);
}
