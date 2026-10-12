using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ProyectoX.Desktop;
using ProyectoX.Storage;

if (args.Length != 0)
{
    Console.Error.WriteLine("This harness accepts no arguments and uses temporary synthetic data only.");
    return 2;
}

var tests = new (string Name, Func<Task> Run)[]
{
    ("Original UI wire, chunk import, native export and full hire payload", OriginalUiAsync),
    ("Migrated PocketBase pointers through bridge and native export", MigratedPocketBaseAsync),
    ("Read-only reads/exports and rejected mutations", ReadOnlyAsync),
    ("Optimistic stale revision and replay (host serialization is out of scope)", OptimisticAsync),
    ("Disappeared root never returns silent empty state", DisappearedRootAsync)
};
var failed = 0;
foreach (var test in tests)
{
    try { await test.Run(); Console.WriteLine("PASS: " + test.Name); }
    catch (Exception ex)
    {
        failed++;
        // Do not print paths, payloads or exception messages, even for fixture failures.
        Console.Error.WriteLine("FAIL: " + test.Name + " [" + ex.GetType().Name + "]");
                if (ex is HarnessAssertionException assertion) Console.Error.WriteLine("  Assertion: " + assertion.Message);
                if (ex is LegacyApiException legacy) Console.Error.WriteLine("  Code: " + legacy.Code);
                foreach (var frame in new System.Diagnostics.StackTrace(ex, false).GetFrames().Take(6))
                    Console.Error.WriteLine("  Method: " + frame.GetMethod()?.Name);
    }
}
Console.WriteLine($"RESULT: {tests.Length - failed} passed, {failed} failed, {tests.Length} total");
return failed == 0 ? 0 : 1;

static async Task OriginalUiAsync()
{
    using var f = new Fixture();
    var me = await f.Get("/me");
    Check(Text(me["user"]!["id"]) == Fixture.Identity.Id, "host identity");
    Check(Text(me["user"]!["role"]) == "rrhh" && Text(me["user"]!["authMode"]) == "windows", "Windows authentication shape");
    var state = await f.Get("/state");
    foreach (var key in new[] { "listings", "candidates", "applications" })
        Check(state["state"]![key] is JsonArray { Count: 0 }, "initial UI collections");
    Check((await f.Get("/listings"))["items"] is JsonArray { Count: 0 }, "initial listings");

    var listingBody = ListingBody();
    var create = f.Request("/listings", "POST", listingBody, 0);
    var created = await Send(f.Bridge, create);
    Check(Revision(created) == 1, "listing commits once");
    foreach (var field in listingBody)
        Check(JsonNode.DeepEquals(created["item"]![field.Key], field.Value), "original createListing payload preserved");
    var listingId = Text(created["item"]!["id"]);
    Check((await f.Get("/listings"))["items"] is JsonArray { Count: 1 }, "created listing visible");

    // Larger than the bridge budget if encoded inline: only bounded chunks carry base64.
    var cv = new byte[1_048_576 + 19];
    for (var i = 0; i < cv.Length; i++) cv[i] = (byte)(i % 251);
    Encoding.ASCII.GetBytes("%PDF-1.7 synthetic\n").CopyTo(cv, 0);
    var certificate = Encoding.UTF8.GetBytes("%PDF-1.7 synthetic certificate");
    var cvPart = await f.Upload("cv", "Test+Candidate.pdf", cv);
    var certPart = await f.Upload("certificates", "certificate.pdf", certificate);
    var parts = new JsonArray(Field("firstName", "Test"), Field("lastName", "Candidate"),
        Field("email", "candidate@example.test"), Field("birthDate", "1990-01-02"),
        Field("coverLetter", "Synthetic letter"), cvPart, certPart);
    var importRequest = f.Request($"/interno/listings/{listingId}/import_candidate", "POST", new JsonObject { ["parts"] = parts }, 1);
    Check(!importRequest.ToJsonString().Contains("base64", StringComparison.Ordinal), "multipart references only");
    var imported = await Send(f.Bridge, importRequest);
    Check(Revision(imported) == 2, "atomic multipart commit");
    Check(JsonNode.DeepEquals(imported, await Send(f.Bridge, importRequest)), "consumed upload replay");
    var appId = Text(imported["applicationId"]);
    var candidateId = Text(imported["candidateProfileId"]);
    var applications = (await f.Get("/applications"))["items"]!.AsArray();
    Check(applications.Count == 1 && Text(applications[0]!["id"]) == appId, "applications UI shape");
    var profile = (await f.Get($"/company/candidates/{candidateId}/profile"))["profile"]!;
    Check(Text(profile["firstName"]) == "Test" && Text(profile["email"]) == "candidate@example.test", "candidate profile UI shape");
    var docs = (await f.Get($"/interno/applications/{appId}/documents"))["items"]!.AsArray();
    Check(docs.Count == 2, "CV and certificate listed");
    foreach (var doc in docs)
    {
        var path = $"/interno/applications/{appId}/documents/{Text(doc!["id"])}";
        var descriptor = await f.Get(path);
        Check(descriptor["nativeActionRequired"]!.GetValue<bool>() && !descriptor.ContainsKey("base64"), "native action descriptor only");
        var exported = await f.Bridge.Documents.PrepareExportAsync(path, default);
        var expected = Text(doc["docType"]) == "cv" ? cv : certificate;
        Check(exported.Bytes.SequenceEqual(expected) && exported.Mime == "application/pdf", "native exact bytes");
    }
    var cvUrl = Text((await f.Get($"/company/candidates/{candidateId}/cv"))["url"]);
    Check((await f.Bridge.Documents.PrepareExportAsync(cvUrl, default)).Bytes.SequenceEqual(cv), "legacy CV resolves native export");

    await SeedCatalogs(f);
    var revision = (await f.Store.ReadAsync()).Revision;
    var hireBody = new JsonObject
    {
        ["firstName"] = "New", ["lastName"] = "Hire", ["email"] = "hire@example.test",
        ["departmentId"] = "department-fixture", ["jobTitleId"] = "job-fixture",
        ["costCenter"] = "TEST", ["startDate"] = "2026-11-01"
    };
    var hireRequest = f.Request("/enterprise/hire-profiles", "POST", hireBody, revision);
    var hire = await Send(f.Bridge, hireRequest);
    Check(Revision(hire) == revision + 1, "full original hire payload committed");
    foreach (var key in new[] { "firstName", "lastName", "email", "departmentId", "jobTitleId", "costCenter" })
        Check(JsonNode.DeepEquals(hire["hire_profile"]![key], hireBody[key]), "hire fields preserved");
    Check(Text(hire["hire_profile"]!["startDate"]).StartsWith("2026-11-01", StringComparison.Ordinal), "hire date preserved");
    Check(JsonNode.DeepEquals(hire, await Send(f.Bridge, hireRequest)), "hire replay");
    Check((await f.Get("/enterprise/outbox"))["items"] is JsonArray { Count: 1 }, "manual IT outbox only");
    await Error(f.Bridge, f.Request("/public/listings/test", "GET"), "unsupported_local");
    await Error(f.Bridge, f.Request($"/listings/{listingId}/apply_tokens", "POST", new JsonObject(), revision + 1), "unsupported_local");
    Check((await f.Store.ReadAsync()).Revision == revision + 1, "public operations never mutate");
}

static async Task MigratedPocketBaseAsync()
{
    using var f = new Fixture();
    var bytes = Encoding.UTF8.GetBytes("%PDF-1.7 dummy migrated CV\0");
    var relative = "pocketbase-storage/imports_fixture/import-fixture/dummy.pdf";
    var file = Path.Combine(f.Root, relative.Replace('/', Path.DirectorySeparatorChar));
    Directory.CreateDirectory(Path.GetDirectoryName(file)!);
    await File.WriteAllBytesAsync(file, bytes);
    var snapshot = await f.Store.ReadAsync();
    snapshot.Data["listings"]!.AsArray().Add(new JsonObject { ["id"] = "listing-pb", ["ownerUserId"] = "company-pb" });
    snapshot.Data["candidate_profiles"] = new JsonArray(new JsonObject
    {
        ["id"] = "profile-pb", ["userId"] = "user-pb", ["firstName"] = "Migrated",
        ["lastName"] = "Fixture", ["email"] = "migrated@example.test", ["custom"] = "preserved"
    });
    snapshot.Data["applications"]!.AsArray().Add(new JsonObject
    {
        ["id"] = "application-pb", ["listingId"] = "listing-pb", ["candidateUserId"] = "profile-pb"
    });
    snapshot.Data["profile_imports"] = new JsonArray(new JsonObject
    {
        ["id"] = "import-fixture", ["collectionId"] = "imports_fixture", ["userId"] = "user-pb",
        ["applicationId"] = "application-pb", ["kind"] = "cv", ["file"] = "dummy.pdf", ["created"] = "2025-01-01",
        ["_desktopFiles"] = new JsonObject { ["file"] = new JsonArray(new JsonObject
        {
            ["fileName"] = "dummy.pdf", ["relativePath"] = relative, ["size"] = bytes.Length,
            ["sha256"] = Hash(bytes).ToLowerInvariant()
        }) }
    });
    await f.Store.CommitAsync(snapshot.Revision, snapshot.Data, "synthetic-migration");
    var before = await f.Store.ReadAsync();
    Check((await f.Get("/applications"))["items"] is JsonArray { Count: 1 }, "migrated applications visible");
    var profile = (await f.Get("/company/candidates/profile-pb/profile"))["profile"]!;
    Check(Text(profile["id"]) == "profile-pb" && Text(profile["userId"]) == "user-pb", "PB profile id differs from user id");
    var docs = (await f.Get("/interno/applications/application-pb/documents"))["items"]!.AsArray();
    Check(docs.Count == 1 && Text(docs[0]!["id"]) == "import-fixture", "PB document pointer listed");
    const string path = "/interno/applications/application-pb/documents/import-fixture";
    Check((await f.Get(path))["nativeActionRequired"]!.GetValue<bool>(), "PB native descriptor through bridge");
    var prepared = await f.Bridge.Documents.PrepareExportAsync(path, default);
    Check(prepared.Bytes.SequenceEqual(bytes) && prepared.FileName == "dummy.pdf", "PB native exact bytes");
    var url = Text((await f.Get("/company/candidates/profile-pb/cv"))["url"]);
    Check(url == "/documents/import-fixture", "PB CV uses import record pointer");
    Check((await f.Bridge.Documents.PrepareExportAsync(url, default)).Bytes.SequenceEqual(bytes), "PB direct CV export");
    var zipBytes = (await f.Bridge.Documents.PrepareExportAsync("/interno/listings/listing-pb/export.zip", default)).Bytes;
    using (var zip = new ZipArchive(new MemoryStream(zipBytes)))
    {
        var entry = zip.GetEntry("documents/import-fixture/dummy.pdf");
        Check(entry is not null && zip.GetEntry("manifest.json") is not null, "PB ZIP manifest and file");
        using var contents = new MemoryStream();
        using var input = entry!.Open();
        await input.CopyToAsync(contents);
        Check(contents.ToArray().SequenceEqual(bytes), "PB ZIP bytes");
    }
    var readOnly = new DesktopBridge(new SharedStore(f.Root, true), f.Root, true, Fixture.Identity);
    Check((await readOnly.Documents.PrepareExportAsync(path, default)).Bytes.SequenceEqual(bytes), "PB read-only native export");
    var after = await f.Store.ReadAsync();
    Check(before.Revision == after.Revision && JsonNode.DeepEquals(before.Data, after.Data), "migration reads never rewrite state");
    await File.WriteAllBytesAsync(file, Encoding.UTF8.GetBytes("tampered"));
    try { await f.Bridge.Documents.PrepareExportAsync(path, default); throw new Exception("Expected failure"); }
    catch (LegacyApiException ex) when (ex.Code == "store_unavailable") { }
}

static async Task ReadOnlyAsync()
{
    using var f = new Fixture();
    var created = await Send(f.Bridge, f.Request("/listings", "POST", ListingBody(), 0));
    var bytes = Encoding.UTF8.GetBytes("%PDF synthetic read-only export");
    var part = await f.Upload("cv", "cv.pdf", bytes);
    var imported = await Send(f.Bridge, f.Request($"/interno/listings/{Text(created["item"]!["id"])}/import_candidate", "POST",
        new JsonObject { ["parts"] = new JsonArray(Field("firstName", "Read"), Field("lastName", "Only"),
                    Field("email", "readonly@example.test"), Field("birthDate", "1990-01-02"), Field("coverLetter", "Synthetic letter"), part) }, 1));
    var bridge = new DesktopBridge(new SharedStore(f.Root, true), f.Root, true, Fixture.Identity);
    var before = await f.Store.ReadAsync();
    foreach (var path in new[] { "/me", "/state", "/listings", "/applications", "/profile" })
        Check((await Send(bridge, f.Request(path, "GET")))["__desktop"]!["readOnly"]!.GetValue<bool>(), "read-only metadata");
    var docsPath = $"/interno/applications/{Text(imported["applicationId"])}/documents";
    var docId = Text((await Send(bridge, f.Request(docsPath, "GET")))["items"]![0]!["id"]);
    Check((await bridge.Documents.PrepareExportAsync(docsPath + "/" + docId, default)).Bytes.SequenceEqual(bytes), "native export allowed read-only");
    await Error(bridge, f.Request("/listings", "POST", ListingBody(), before.Revision), "read_only");
    await Error(bridge, Envelope("uploadBegin", new JsonObject { ["fileName"] = "cv.pdf", ["mime"] = "application/pdf", ["size"] = 1 }), "read_only");
    await Error(bridge, f.Request("/profile/imports/file", "POST", new JsonObject(), before.Revision), "read_only");
    await Error(bridge, f.Request("/enterprise/hire-profiles", "POST", new JsonObject(), before.Revision), "read_only");
    await Error(bridge, Envelope("saveEntity", new JsonObject()), "read_only");
    var after = await f.Store.ReadAsync();
    Check(before.Revision == after.Revision && JsonNode.DeepEquals(before.Data, after.Data), "read-only never commits");
}

static async Task OptimisticAsync()
{
    using var f = new Fixture();
    var other = new DesktopBridge(new SharedStore(f.Root), f.Root, false, Fixture.Identity);
    Check(Revision(await f.Get("/state")) == 0 && Revision(await Send(other, f.Request("/state", "GET"))) == 0, "two clients share initial revision");
    // Main serializes host requests. Test stale clients deterministically, not parallel dispatch.
    var first = f.Request("/listings", "POST", ListingBody(), 0);
    var stale = f.Request("/listings", "POST", ListingBody(), 0);
    var saved = await Send(f.Bridge, first);
    await Error(other, stale, "conflict");
    Check(JsonNode.DeepEquals(saved, await Send(other, first)), "retry with same operation ID replays before stale check");
    var refresh = Revision(await Send(other, f.Request("/state", "GET")));
    Check(refresh == 1, "refresh confirms winner revision");
    Check(Revision(await Send(other, f.Request("/listings", "POST", ListingBody(), refresh))) == 2, "fresh operation succeeds");
    Check((await f.Get("/listings"))["items"] is JsonArray { Count: 2 }, "no lost updates or duplicate replay");
}

static async Task DisappearedRootAsync()
{
    using var f = new Fixture();
    await Send(f.Bridge, f.Request("/listings", "POST", ListingBody(), 0));
    Directory.Move(f.Root, f.Root + "-removed");
    try
    {
        foreach (var path in new[] { "/me", "/state", "/listings", "/applications", "/profile" })
            await Error(f.Bridge, f.Request(path, "GET"), "store_unavailable");
        await Error(f.Bridge, Envelope("getState", new JsonObject()), "store_unavailable");
        await Error(f.Bridge, f.Request("/listings", "POST", ListingBody(), 1), "store_unavailable");
        Check(!Directory.Exists(f.Root), "missing root not recreated");
    }
    finally { Directory.Move(f.Root + "-removed", f.Root); }
    Check((await f.Get("/listings"))["items"] is JsonArray { Count: 1 }, "restored store retains data");
}

static async Task SeedCatalogs(Fixture f)
{
    var snapshot = await f.Store.ReadAsync();
    snapshot.Data["departments"] = new JsonArray(new JsonObject { ["id"] = "department-fixture", ["name"] = "Synthetic department", ["isActive"] = true });
    snapshot.Data["job_titles"] = new JsonArray(new JsonObject { ["id"] = "job-fixture", ["name"] = "Synthetic job", ["isActive"] = true });
    await f.Store.CommitAsync(snapshot.Revision, snapshot.Data, "synthetic-catalogs");
}

static JsonObject ListingBody() => new()
{
    ["kind"] = "empleo", ["title"] = "Synthetic role", ["company"] = "Test company", ["location"] = "Madrid",
    ["pay"] = "Test range", ["tags"] = new JsonArray("QA", "Desktop"), ["desc"] = "Original UI description"
};
static JsonObject Field(string name, string value) => new() { ["name"] = name, ["value"] = value };
static string Text(JsonNode? node) => node!.GetValue<string>();
static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
static long Revision(JsonObject result) => result["__desktop"]!["revision"]!.GetValue<long>();
static void Check(bool condition, string label)
{
    if (!condition) throw new HarnessAssertionException(label);
}
static JsonObject Envelope(string operation, JsonObject payload) => new()
{
    ["id"] = Guid.NewGuid().ToString("D"), ["operation"] = operation, ["payload"] = payload
};
static async Task<JsonObject> Response(DesktopBridge bridge, JsonObject request)
{
    var wire = request.ToJsonString();
    Check(wire.Length <= 1_048_576 && Encoding.UTF8.GetByteCount(wire) <= 1_048_576, "wire <= 1 MiB");
    var response = await bridge.HandleAsync(wire, default);
    Check(JsonNode.DeepEquals(response["id"], request["id"]), "correlation id echoed");
    return response;
}
static async Task<JsonObject> Send(DesktopBridge bridge, JsonObject request)
{
    var response = await Response(bridge, request);
    Check(response["ok"]!.GetValue<bool>() && response["error"] is null && response["result"] is JsonObject,
            "success envelope (code=" + (response["error"]?["code"]?.GetValue<string>() ?? "none") + ")");
    return response["result"]!.AsObject();
}
static async Task Error(DesktopBridge bridge, JsonObject request, string code)
{
    var response = await Response(bridge, request);
    Check(!response["ok"]!.GetValue<bool>() && response["result"] is null && Text(response["error"]!["code"]) == code, "error envelope: " + code);
}

sealed class HarnessAssertionException(string label) : Exception(label);

sealed class Fixture : IDisposable
{
    public static readonly DesktopIdentity Identity = new("WINDOWS\\synthetic-staff", "staff@example.test", "rrhh", "Synthetic staff");
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "px-desktop-bridge-tests-" + Guid.NewGuid().ToString("N"));
    public SharedStore Store { get; }
    public DesktopBridge Bridge { get; }
    public Fixture()
    {
        Directory.CreateDirectory(Root);
        Store = new SharedStore(Root);
        Bridge = new DesktopBridge(Store, Root, false, Identity);
    }
    public JsonObject Request(string path, string method, JsonObject? body = null, long? revision = null) => new()
    {
        ["id"] = Guid.NewGuid().ToString("D"), ["operation"] = "legacyApi", ["payload"] = new JsonObject
        {
            ["path"] = path, ["method"] = method, ["body"] = body?.DeepClone(),
            ["expectedRevision"] = revision, ["operationId"] = Guid.NewGuid().ToString("D")
        }
    };
    public async Task<JsonObject> Get(string path)
    {
        var request = Request(path, "GET");
        var response = await Bridge.HandleAsync(request.ToJsonString(), default);
        if (!response["ok"]!.GetValue<bool>() || !JsonNode.DeepEquals(response["id"], request["id"]) || response["error"] is not null)
            throw new HarnessAssertionException("GET success envelope");
        return response["result"]!.AsObject();
    }
    public async Task<JsonObject> Upload(string name, string fileName, byte[] bytes)
    {
        async Task<JsonObject> Call(string operation, JsonObject payload)
        {
            var request = new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["operation"] = operation, ["payload"] = payload };
            var wire = request.ToJsonString();
            if (wire.Length > 1_048_576 || Encoding.UTF8.GetByteCount(wire) > 1_048_576) throw new HarnessAssertionException("upload wire budget");
            var response = await Bridge.HandleAsync(wire, default);
            if (!response["ok"]!.GetValue<bool>() || response["error"] is not null || !JsonNode.DeepEquals(response["id"], request["id"]))
                throw new HarnessAssertionException("upload success envelope");
            return (JsonObject)response["result"]!.DeepClone();
        }
        var begin = await Call("uploadBegin", new JsonObject { ["fileName"] = fileName, ["mime"] = "application/pdf", ["size"] = bytes.Length });
        var id = begin["uploadId"]!.GetValue<string>();
        var chunkBytes = begin["chunkBytes"]!.GetValue<int>();
        if (chunkBytes != DocumentApi.MaxChunkBytes) throw new HarnessAssertionException("host chunk budget");
        for (var offset = 0; offset < bytes.Length; offset += chunkBytes)
        {
            var chunk = bytes.AsSpan(offset, Math.Min(chunkBytes, bytes.Length - offset)).ToArray();
            var ack = await Call("uploadChunk", new JsonObject
            {
                ["uploadId"] = id, ["offset"] = offset, ["base64"] = Convert.ToBase64String(chunk),
                ["sha256"] = Convert.ToHexString(SHA256.HashData(chunk))
            });
            if (ack["offset"]!.GetValue<long>() != offset + chunk.Length) throw new HarnessAssertionException("chunk acknowledgement");
        }
        var part = await Call("uploadFinish", new JsonObject { ["uploadId"] = id, ["sha256"] = Convert.ToHexString(SHA256.HashData(bytes)) });
        if (part.ContainsKey("base64") || part["size"]!.GetValue<int>() != bytes.Length) throw new HarnessAssertionException("finished upload reference");
        part["name"] = name;
        return part;
    }
    public void Dispose()
    {
        if (Directory.Exists(Root)) Directory.Delete(Root, recursive: true);
    }
}
