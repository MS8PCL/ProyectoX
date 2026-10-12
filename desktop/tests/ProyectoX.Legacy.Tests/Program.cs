using System.Text.Json.Nodes;
using ProyectoX.Desktop;
using ProyectoX.Storage;

var tests = new (string Name, Func<Task> Run)[]
{
    ("Empty store reads without seeds", Empty),
    ("Listing CRUD, normalized paths, object/string bodies", Listings),
    ("Receipts, canonical fingerprints, stale retry, UUID collision", Receipts),
    ("Revision races and durable uncertain outcomes", Concurrency),
    ("Windows identity, staff ACL, readOnly and cancellation", Permissions),
    ("User-specific state never overwrites shared collections", State),
    ("Own preferences save on a stale revision; shared writes still conflict", StalePreferences),
    ("Own profile and onboarding completeness", Profile),
    ("PocketBase candidate profile IDs, aliases and pipeline stages", Imported),
    ("Candidates/applications CRUD and reference conflicts", Applications),
    ("Deleting an imported application removes its own imports", ImportedApplicationDelete),
    ("Atomic hire, outbox export and completion", Hire),
    ("New stores serve official catalogs so IT onboarding works", SeededCatalogHire),
    ("Standalone hire-tools frontend shape", StandaloneHire),
    ("Catalog filters, audit pagination and real metrics", Reporting),
    ("Explicit unsupported operations and document dispatch", Unsupported),
    ("Unsafe paths and invalid input leave revision unchanged", Validation),
    ("Malformed persisted extras and receipts fail closed", Corruption),
        ("GET Windows auth alias does not open password routes", WindowsAuth),
        ("Real user-scoped notifications and atomic marks", Notifications),
        ("Imported state hydration, explicit mappings and independent profiles", Hydration),
        ("Serialized Vue state envelopes preserve shared business data", SerializedState),
        ("Publish kinds and full original hire payload", PublishContracts),
        ("Audit pseudonyms and sanitized dynamic error messages", Privacy),
            ("Home metrics count distinct profiles and preserve actual activity dates", MetricsUi)
};
var failures = 0;
foreach (var (name, run) in tests)
{
    try { await run(); Console.WriteLine("PASS " + name); }
    catch (Exception ex) { failures++; Console.Error.WriteLine("FAIL " + name + "\n" + ex); }
}
Console.WriteLine($"{tests.Length - failures}/{tests.Length} passed");
return failures == 0 ? 0 : 1;

static JsonObject Obj(string json) => JsonNode.Parse(json)!.AsObject();
static string Str(JsonNode? node) => node!.GetValue<string>();
static long Rev(JsonObject response) => response["__desktop"]!["revision"]!.GetValue<long>();
static void Check(bool condition, string message = "Assertion failed") { if (!condition) throw new Exception(message); }
static async Task Code(string code, Func<Task> run)
{
    try { await run(); } catch (LegacyApiException ex) { Check(ex.Code == code, $"Expected {code}, got {ex.Code}: {ex.Message}"); return; }
    throw new Exception("Expected " + code);
}
static Task<JsonObject> Get(Fixture f, string path, LegacyApi? api = null) => (api ?? f.Api).HandleAsync(new JsonObject { ["path"] = path }, default);
static JsonObject Request(string path, string method, JsonObject body, long revision, string? op = null) => new()
{
    ["path"] = path, ["method"] = method, ["body"] = body.DeepClone(), ["expectedRevision"] = revision, ["operationId"] = op ?? Guid.NewGuid().ToString("D")
};
static async Task<JsonObject> Write(Fixture f, string path, string method, JsonObject body, LegacyApi? api = null) => await (api ?? f.Api).HandleAsync(Request(path, method, body, (await f.Store.ReadAsync()).Revision), default);
static JsonObject Listing() => Obj("""{"kind":"empleo","title":"Engineer","company":"Company","location":"Remote","tags":["C#"],"desc":"Description"}""");
static JsonObject CandidateBody() => Obj("""{"fullName":"Ada Lovelace","email":"ada@example.org","firstName":"Ada","lastName":"Lovelace"}""");
static async Task<(string Listing, string Candidate, string Application)> Setup(Fixture f)
{
    var l = Str((await Write(f, "/listings", "POST", Listing()))["item"]!["id"]);
    var c = Str((await Write(f, "/candidates", "POST", CandidateBody()))["item"]!["id"]);
    var a = Str((await Write(f, "/applications", "POST", new JsonObject { ["listingId"] = l, ["candidateUserId"] = c }))["item"]!["id"]);
    return (l, c, a);
}
static async Task SeedCatalogs(Fixture f)
{
    var s = await f.Store.ReadAsync();
    s.Data["departments"] = Obj("""{"items":[{"id":"dep-pb","code":"01","name":"Research","normalizedKey":"research","isActive":true},{"id":"inactive","code":"02","name":"Old","isActive":false}]}""")["items"]!.DeepClone();
    s.Data["job_titles"] = new JsonArray(Obj("""{"id":"job-pb","code":"ENG","name":"Engineer","isActive":true}"""));
    await f.Store.CommitAsync(s.Revision, s.Data, "test-import");
}
static JsonObject HireBody(string application) => new()
{
    ["applicationId"] = application, ["startDate"] = "2026-11-01", ["departmentId"] = "dep-pb", ["jobTitleId"] = "job-pb",
    ["costCenter"] = "R&D", ["managerEmail"] = "manager@example.org", ["accessProfileId"] = "base", ["notesIT"] = "Laptop"
};
static async Task Empty()
{
    using var f = new Fixture();
    foreach (var path in new[] { "/listings", "/candidates", "/applications", "/enterprise/outbox", "/enterprise/catalog/items", "/enterprise/rbac/rules", "/enterprise/hire-profiles", "/enterprise/audit-log" })
    {
        var r = await Get(f, path); Check(r["items"]!.AsArray().Count == 0); Check(Rev(r) == 0);
    }
    // Only the official reference catalogs (backend/src/seeds) are served; reading writes nothing.
    var departments = (await Get(f, "/interno/departments"))["items"]!.AsArray();
    Check(departments.Count > 50 && departments.Any(x => Str(x!["name"]) == "RHIT - Information Technologies" && Str(x!["code"]) == "RHIT"));
    Check(Str((await Get(f, "/interno/job_titles"))["items"]![0]!["name"]) == "GEN - General");
    Check((await Get(f, "/profile"))["profile"] is null);
    var state = (await Get(f, "/state"))["state"]!.AsObject();
        Check(state["listings"]!.AsArray().Count == 0 && state["candidates"]!.AsArray().Count == 0 && state["applications"]!.AsArray().Count == 0);
    Check(!(await Get(f, "/onboarding/status"))["complete"]!.GetValue<bool>());
    Check((await Get(f, "/metrics"))["avgTimeToHire"] is null);
    Check(!File.Exists(Path.Combine(f.Root, "state.json")));
}
static async Task Listings()
{
    using var f = new Fixture();
    var request = Request("/api//listings/", "post", Listing(), 0);
    request["body"] = Listing().ToJsonString();
    var r = await f.Api.HandleAsync(request, default); var id = Str(r["item"]!["id"]);
    Check(Rev(r) == 1); Check(Str(r["item"]!["ownerUserId"]) == "windows-a");
    Check(Str((await Get(f, "/api/listings/" + id))["item"]!["title"]) == "Engineer");
    Check((await Get(f, "/listings/feed"))["items"]!.AsArray().Count == 1);
    await Write(f, "/listings/" + id, "PATCH", Obj("""{"title":"Senior engineer"}"""));
    Check(Str((await Get(f, "/listings"))["items"]![0]!["title"]) == "Senior engineer");
    var delete = Request("/listings/" + id, "DELETE", new(), 2);
    await f.Api.HandleAsync(delete, default); await f.Api.HandleAsync(delete, default);
    Check((await Get(f, "/listings"))["items"]!.AsArray().Count == 0); Check((await f.Store.ReadAsync()).Revision == 3);
}
static async Task Receipts()
{
    using var f = new Fixture(); var request = Request("/listings", "POST", Listing(), 0);
    var result = await f.Api.HandleAsync(request, default);
    var reorder = Request("/api/listings/", "POST", Obj("""{"desc":"Description","tags":["C#"],"location":"Remote","company":"Company","title":"Engineer","kind":"empleo"}"""), 0, Str(request["operationId"]));
    var retry = await f.Api.HandleAsync(reorder, default); Check(Rev(retry) == 1); Check(JsonNode.DeepEquals(result, retry));
    request["body"]!["title"] = "Different";
    await Code("invalid_request", () => f.Api.HandleAsync(request, default));
    await Code("conflict", () => f.Api.HandleAsync(Request("/listings", "POST", Listing(), 0), default));
    var data = (await f.Store.ReadAsync()).Data;
    Check(Str(data["_operations"]![Str(reorder["operationId"])]).Length == 64);
    Check(!data.ToJsonString().Contains("expectedRevision"));
        await Write(f, "/listings/" + Str(result["item"]!["id"]), "DELETE", new());
        var afterDeletion = await f.Api.HandleAsync(reorder, default);
        Check(afterDeletion["ok"]!.GetValue<bool>() && afterDeletion["item"] is null);
        Check(Rev(afterDeletion) == 2 && (await f.Store.ReadAsync()).Data["listings"]!.AsArray().Count == 0);
}
static async Task Concurrency()
{
    using var f = new Fixture(); var request = Request("/listings", "POST", Listing(), 0);
    var other = new LegacyApi(new SharedStore(f.Root), false, Fixture.Identity);
    var results = await Task.WhenAll(f.Api.HandleAsync(request, default), other.HandleAsync(request, default));
    Check(results.All(x => Rev(x) == 1)); Check((await f.Store.ReadAsync()).Data["listings"]!.AsArray().Count == 1);
    var next = Request("/listings", "POST", Listing(), 1);
    f.Store.FailureHook = stage => { if (stage == CommitStage.JournalPublished) throw new IOException("Injected uncertain outcome"); };
    try { await f.Api.HandleAsync(next, default); throw new Exception("Expected storage error"); } catch (StoreUnavailableException) { }
    f.Store.FailureHook = null;
    Check(Rev(await other.HandleAsync(next, default)) == 2);
    Check((await f.Store.ReadAsync()).Data["listings"]!.AsArray().Count == 2);
    var requests = new[] { Request("/listings", "POST", Listing(), 2), Request("/listings", "POST", Listing(), 2) };
    async Task<bool> Try(JsonObject r) { try { await other.HandleAsync(r, default); return true; } catch (LegacyApiException ex) when (ex.Code == "conflict") { return false; } }
    Check((await Task.WhenAll(requests.Select(Try))).Count(x => x) == 1);
}
static async Task Permissions()
{
    using var f = new Fixture();
    var reader = new LegacyApi(f.Store, true, Fixture.Identity);
    Check((await Get(f, "/me", reader))["__desktop"]!["readOnly"]!.GetValue<bool>());
    await Code("read_only", () => reader.HandleAsync(Request("/listings", "POST", Listing(), 0), default));
    var worker = new LegacyApi(f.Store, false, new("worker", "w@example.org", "worker", "Worker"));
    await Code("forbidden", () => Get(f, "/applications", worker));
        await Code("forbidden", () => Get(f, "/candidates", worker));
    await Code("forbidden", () => Write(f, "/listings", "POST", Listing(), worker));
    var me = await Get(f, "/me");
        Check(Str(me["user"]!["email"]) == Fixture.Identity.Email);
        Check(Str(me["user"]!["authMode"]) == "windows");
    using var cts = new CancellationTokenSource(); cts.Cancel();
    try { await f.Api.HandleAsync(new JsonObject { ["path"] = "/me" }, cts.Token); throw new Exception("Expected cancellation"); } catch (OperationCanceledException) { }
    Check((await f.Store.ReadAsync()).Revision == 0);
}
static async Task State()
{
    using var f = new Fixture(); await Setup(f);
    var other = new LegacyApi(f.Store, false, new("windows-b", "b@example.org", "rrhh", "B"));
    var state = Obj("""{"state":{"v":3,"theme":"light","listings":[],"applications":[],"candidates":[],"pipeline":{},"lists":[],"listMembers":{}}}""");
    var request = Request("/state", "PUT", state, 3);
    await f.Api.HandleAsync(request, default); await f.Api.HandleAsync(request, default);
    Check((await Get(f, "/state"))["state"]!["listings"]!.AsArray().Count == 1);
    Check(Str((await Get(f, "/state", other))["state"]!["theme"]) == "terminal");
    await Write(f, "/state", "PUT", Obj("""{"state":{"theme":"terminal"}}"""), other);
    Check(Str((await Get(f, "/state"))["state"]!["theme"]) == "light");
    Check((await f.Store.ReadAsync()).Data["applications"]!.AsArray().Count == 1);
    await Write(f, "/settings", "PUT", Obj("""{"settings":{"density":"compact"}}"""));
    Check(Str((await Get(f, "/settings"))["settings"]!["density"]) == "compact");
    Check((await Get(f, "/settings", other))["settings"]!.AsObject().Count == 0);
}
static async Task Profile()
{
    using var f = new Fixture();
    var body = Obj("""{"fullName":"Windows User","title":"Recruiter","location":"Madrid","public":false,"skills":["Hiring"],"about":"Team"}""");
    var request = Request("/profile", "PUT", body, 0);
    var r = await f.Api.HandleAsync(request, default); Check(r["complete"]!.GetValue<bool>());
    var id = Str(r["profile"]!["id"]); Check(JsonNode.DeepEquals(r, await f.Api.HandleAsync(request, default)));
    body["title"] = "HR"; await Write(f, "/profile", "PUT", body); Check(Str((await Get(f, "/profile"))["profile"]!["id"]) == id);
    var company = new LegacyApi(f.Store, false, new("company-a", "co@example.org", "company", "Company"));
    await Write(f, "/profile", "PUT", Obj("""{"companyName":"Acme","sector":"IT","location":"Remote"}"""), company);
    Check(Str((await Get(f, "/profile", company))["profile"]!["companyName"]) == "Acme");
}
static async Task Imported()
{
    using var f = new Fixture(); var s = await f.Store.ReadAsync();
    s.Data["candidate_profiles"] = new JsonArray(Obj("""{"id":"pb-profile-id","userId":"NOT-the-reference","fullName":"Imported","email":"imported@example.org","customLegacy":{"value":7}}"""));
    s.Data["listings"] = new JsonArray(Obj("""{"id":"pb-listing","title":"Imported offer"}"""));
    s.Data["applications"] = new JsonArray(Obj("""{"id":"pb-app","candidateUserId":"pb-profile-id","listingId":"pb-listing","stage":"nuevo"}"""));
    await f.Store.CommitAsync(0, s.Data, "import-test");
    Check(Str((await Get(f, "/company/candidates/pb-profile-id/profile"))["profile"]!["id"]) == "pb-profile-id");
    await Write(f, "/candidates/pb-profile-id", "PATCH", Obj("""{"phone":"123"}"""));
    var data = (await f.Store.ReadAsync()).Data;
    Check(Str(data["candidates"]![0]!["id"]) == "pb-profile-id"); Check(data["candidates"]![0]!["customLegacy"]!["value"]!.GetValue<int>() == 7);
    Check(JsonNode.DeepEquals(data["candidate_profiles"], data["candidates"]));
    await Write(f, "/company/applications/pb-app", "PATCH", Obj("""{"stage":"entrevista","notes":"Scheduled"}"""));
    Check(Str((await Get(f, "/company/listings/pb-listing/applications"))["items"]![0]!["stage"]) == "entrevista");
    await Code("not_found", () => Get(f, "/company/candidates/NOT-the-reference/profile"));
}
static async Task Applications()
{
    using var f = new Fixture(); var (l, c, a) = await Setup(f);
    await Code("reference_conflict", () => Write(f, "/candidates/" + c, "DELETE", new()));
    await Code("reference_conflict", () => Write(f, "/listings/" + l, "DELETE", new()));
    await Code("invalid_request", () => Write(f, "/company/applications/" + a, "PATCH", Obj("""{"stage":"fake"}""")));
    var duplicate = await Write(f, "/applications", "POST", new JsonObject { ["listingId"] = l, ["candidateUserId"] = c }); Check(duplicate["already"]!.GetValue<bool>());
    await Code("reference_conflict", () => Write(f, "/candidates", "POST", CandidateBody()));
    foreach (var stage in new[] { "revisar", "entrevista", "oferta", "descartado", "hired" })
        await Write(f, "/company/applications/" + a, "PATCH", new JsonObject { ["stage"] = stage });
    var delete = Request("/company/applications/" + a, "DELETE", new(), (await f.Store.ReadAsync()).Revision);
    await f.Api.HandleAsync(delete, default); await f.Api.HandleAsync(delete, default);
    await Write(f, "/candidates/" + c, "DELETE", new()); await Write(f, "/listings/" + l, "DELETE", new());
    Check((await f.Store.ReadAsync()).Data["applications"]!.AsArray().Count == 0);
}
static async Task ImportedApplicationDelete()
{
    using var f = new Fixture(); var (_, c, a) = await Setup(f);
    var seeded = await f.Store.ReadAsync();
    seeded.Data["profile_imports"] = new JsonArray(
        new JsonObject { ["id"] = "imp-app", ["applicationId"] = a, ["userId"] = c, ["docType"] = "cv", ["documentId"] = "00000000-0000-0000-0000-000000000001" },
        new JsonObject { ["id"] = "imp-own", ["userId"] = c, ["docType"] = "cv" });
    await f.Store.CommitAsync(seeded.Revision, seeded.Data, "test");
    await Write(f, "/company/applications/" + a, "DELETE", new());
    var data = (await f.Store.ReadAsync()).Data;
    Check(data["applications"]!.AsArray().Count == 0);
    Check(data["profile_imports"]!.AsArray().Select(x => Str(x!["id"])).SequenceEqual(["imp-own"]));
}
static async Task SeededCatalogHire()
{
    using var f = new Fixture(); var (_, _, a) = await Setup(f);
    var dep = Str((await Get(f, "/interno/departments?q=Business"))["items"]![0]!["id"]);
    var job = Str((await Get(f, "/interno/job_titles"))["items"]![0]!["id"]);
    var body = new JsonObject { ["applicationId"] = a, ["startDate"] = "2026-11-02", ["departmentId"] = dep, ["jobTitleId"] = job, ["costCenter"] = "CC1", ["managerEmail"] = "jefa@example.org", ["accessProfileId"] = "estandar" };
    var r = await Write(f, "/interno/hire/enqueue_it_request", "POST", body);
    Check(Str(r["outbox"]!["export_blob"]!["department"]!["name"]) == "BD - Business Development");
    var data = (await f.Store.ReadAsync()).Data;
    Check(data["departments"]!.AsArray().Count > 50, "the first write persists the official catalog");
    data["departments"] = new JsonArray(new JsonObject { ["id"] = "own", ["name"] = "Own", ["isActive"] = true });
    await f.Store.CommitAsync((await f.Store.ReadAsync()).Revision, data, "test");
    Check((await Get(f, "/interno/departments"))["items"]!.AsArray().Count == 1, "an existing catalog is never replaced");
}
static async Task StalePreferences()
{
    using var f = new Fixture(); var (l, _, _) = await Setup(f);
    var stale = (await f.Store.ReadAsync()).Revision;
    await Write(f, "/listings/" + l, "PATCH", Obj("""{"location":"Bilbao"}"""));
    var saved = await f.Api.HandleAsync(Request("/state", "PUT", Obj("""{"state":{"theme":"light","listings":[]}}"""), stale), default);
    Check(Rev(saved) == stale + 2);
    Check(Str((await Get(f, "/state"))["state"]!["theme"]) == "light");
    Check(Str((await f.Store.ReadAsync()).Data["listings"]![0]!["location"]) == "Bilbao", "shared data untouched");
    await Code("conflict", () => f.Api.HandleAsync(Request("/listings/" + l, "PATCH", Obj("""{"location":"Vigo"}"""), stale), default));
    await Code("conflict", () => f.Api.HandleAsync(Request("/state", "PUT", Obj("""{"state":{"theme":"terminal"}}"""), stale), default));
}
static async Task Hire()
{
    using var f = new Fixture(); var (_, _, a) = await Setup(f); await SeedCatalogs(f);
    var before = (await f.Store.ReadAsync()).Revision;
    var bad = HireBody(a); bad["jobTitleId"] = "missing";
    await Code("not_found", () => Write(f, "/interno/hire/enqueue_it_request", "POST", bad)); Check((await f.Store.ReadAsync()).Revision == before);
    var request = Request("/interno/hire/enqueue_it_request", "POST", HireBody(a), before);
    var r = await f.Api.HandleAsync(request, default); Check(Rev(r) == before + 1); Check(Str(r["movedStage"]) == "hired");
    var oid = Str(r["outbox"]!["id"]); var retry = await f.Api.HandleAsync(request, default); Check(JsonNode.DeepEquals(r, retry));
    var snapshot = await f.Store.ReadAsync(); Check(snapshot.Data["hire_profiles"]!.AsArray().Count == 1); Check(snapshot.Data["integration_outbox"]!.AsArray().Count == 1);
    Check(Str(snapshot.Data["applications"]![0]!["stage"]) == "hired");
        var repeated = await Write(f, "/interno/hire/enqueue_it_request", "POST", HireBody(a));
        Check(!repeated["created"]!.GetValue<bool>() && Str(repeated["outbox"]!["id"]) == oid);
        var changed = HireBody(a); changed["costCenter"] = "Changed";
        var unchangedRevision = (await f.Store.ReadAsync()).Revision;
        await Code("reference_conflict", () => Write(f, "/interno/hire/enqueue_it_request", "POST", changed));
        Check((await f.Store.ReadAsync()).Revision == unchangedRevision);
        var inactive = await f.Store.ReadAsync(); inactive.Data["departments"]![0]!["isActive"] = false;
        await f.Store.CommitAsync(inactive.Revision, inactive.Data, "test");
        Check((await f.Api.HandleAsync(request, default))["ok"]!.GetValue<bool>());
    Check(Str((await Get(f, "/outbox/" + oid + "/export"))["export"]!["candidate"]!["fullName"]) == "Ada Lovelace");
    await Write(f, "/outbox/" + oid + "/mark_exported", "POST", new());
    Check((await Get(f, "/enterprise/outbox?status=pending"))["items"]!.AsArray().Count == 0);
    await Write(f, "/enterprise/outbox/" + oid, "PATCH", Obj("""{"status":"completed"}"""));
    await Write(f, "/enterprise/outbox/" + oid + "/complete", "POST", new());
    await Code("reference_conflict", () => Write(f, "/company/applications/" + a, "DELETE", new()));
}
static async Task StandaloneHire()
{
    using var f = new Fixture(); await SeedCatalogs(f);
    var request = Request("/enterprise/hire-profiles", "POST", Obj("""{"firstName":"Grace","lastName":"Hopper","email":"grace@example.org","departmentId":"dep-pb","jobTitleId":"job-pb","costCenter":"IT","startDate":"2026-11-01"}"""), 1);
    var r = await f.Api.HandleAsync(request, default); Check(r["hire_profile"] is JsonObject); Check(JsonNode.DeepEquals(r, await f.Api.HandleAsync(request, default)));
    var data = (await f.Store.ReadAsync()).Data; Check(data["applications"]!.AsArray().Count == 0); Check(data["candidates"]!.AsArray().Count == 1); Check(data["hire_profiles"]!.AsArray().Count == 1);
    Check(Str(data["candidates"]![0]!["fullName"]) == "Grace Hopper");
        await Write(f, "/candidates/" + Str(data["candidates"]![0]!["id"]), "PATCH", Obj("""{"firstName":"Amazing Grace"}"""));
        Check(Str((await Get(f, "/candidates"))["items"]![0]!["fullName"]) == "Amazing Grace Hopper");
}
static async Task Reporting()
{
    using var f = new Fixture(); var (_, _, a) = await Setup(f); await SeedCatalogs(f);
    var s = await f.Store.ReadAsync(); s.Data["applications"]![0]!["created"] = "2026-10-01T00:00:00Z"; s.Data["applications"]![0]!["hiredAt"] = "2026-10-06T00:00:00Z"; s.Data["applications"]![0]!["stage"] = "hired";
    s.Data["catalog_items"] = new JsonArray(Obj("""{"id":"catalog-pb","type":"access_profile","key":"base"}"""));
    await f.Store.CommitAsync(s.Revision, s.Data, "test");
    var metrics = await Get(f, "/metrics"); Check(metrics["totalApplications"]!.GetValue<int>() == 1); Check(metrics["avgTimeToHire"]!.GetValue<double>() == 5); Check(metrics["conversionRate"]!.GetValue<double>() == 100);
    Check(Str(metrics["recentActivity"]![0]!["candidateName"]) == "Ada Lovelace"); Check(Str(metrics["recentActivity"]![0]!["id"]) == a);
    Check((await Get(f, "/interno/departments?active=1&q=Research"))["items"]!.AsArray().Count == 1);
    Check((await Get(f, "/departments?q=NoMatch"))["items"]!.AsArray().Count == 0);
    Check((await Get(f, "/enterprise/catalog/items?type=access_profile"))["items"]!.AsArray().Count == 1);
    var audit = await Get(f, "/enterprise/audit-log?page=2&perPage=1&action=POST"); Check(audit["totalItems"]!.GetValue<int>() == 3); Check(audit["items"]!.AsArray().Count == 1); Check(audit["totalPages"]!.GetValue<int>() == 3);
        Check(Str(audit["items"]![0]!["user"]) == Fixture.Identity.DisplayName);
        Check(DateTimeOffset.TryParse(Str(audit["items"]![0]!["timestamp"]), out _));
}
static async Task Unsupported()
{
    using var f = new Fixture();
    foreach (var path in new[] { "/auth/login", "/auth/logout", "/auth/register", "/apply/token", "/public/apply/token", "/interno/apply_tokens", "/interno/applications/a/apply_tokens", "/mock/otrs/simulate/x", "/listings/a/apply", "/me/favorites" })
        await Code("unsupported_local", () => Get(f, path));
    foreach (var path in new[] { "/profile/imports", "/profile/imports/file", "/company/candidates/a/cv", "/interno/applications/a/documents", "/interno/applications/a/documents/doc", "/interno/applications/a/export.zip", "/interno/listings/a/export.zip", "/interno/listings/a/import_candidate" })
        await Code("document_dispatch_required", () => Get(f, path));
    await Code("unsupported_operation", () => Get(f, "/nonexistent"));
    foreach (var path in new[] { "/wf/transition", "/rbac/preview", "/otrs/link", "/outbox/enqueue/otrs_create_ticket" })
        await Code("unsupported_operation", () => Write(f, path, "POST", new()));
    Check((await f.Store.ReadAsync()).Revision == 0);
}
static async Task Validation()
{
    using var f = new Fixture();
    foreach (var path in new[] { "https://host/me", "//host/me", "/api/../me", "/api/%2e%2e/me", "/api/%252e%252e/me", "/listings/a%2fb", "/listings/a%5Cb", "/me#x", "/me%00", "/me%GG", "/metrics?q=a&q=b" }) await Code("invalid_request", () => Get(f, path));
    await Code("invalid_request", () => f.Api.HandleAsync(new JsonObject { ["path"] = "/listings", ["method"] = "POST" }, default));
    var req = Request("/listings", "POST", Listing(), 0); req["expectedRevision"] = -1; await Code("invalid_request", () => f.Api.HandleAsync(req, default));
    var body = Listing(); body["id"] = "client-id"; await Code("invalid_request", () => Write(f, "/listings", "POST", body));
    body = CandidateBody(); body["email"] = "bad"; await Code("invalid_request", () => Write(f, "/candidates", "POST", body));
    await Code("invalid_request", () => Write(f, "/state", "PUT", Obj("""{"state":{"_operations":{}}}""")));
    Check((await f.Store.ReadAsync()).Revision == 0);
}
static async Task Corruption()
{
    using var f = new Fixture(); var s = await f.Store.ReadAsync(); s.Data["departments"] = new JsonObject(); await f.Store.CommitAsync(0, s.Data, "test");
    await Code("store_unavailable", () => Get(f, "/departments"));
    s = await f.Store.ReadAsync(); s.Data.Remove("departments"); s.Data["_operations"] = new JsonObject { ["not-a-uuid"] = "bad" }; await f.Store.CommitAsync(1, s.Data, "test");
    await Code("store_unavailable", () => Get(f, "/listings"));
}

static async Task WindowsAuth()
{
    using var f = new Fixture();
    Check(JsonNode.DeepEquals(await Get(f, "/me"), await Get(f, "/api/auth/windows/")));
    var reader = new LegacyApi(f.Store, true, Fixture.Identity);
    Check(JsonNode.DeepEquals(await Get(f, "/me", reader), await Get(f, "/auth/windows", reader)));
    await Code("unsupported_local", () => Write(f, "/auth/windows", "POST", new()));
    await Code("unsupported_local", () => Get(f, "/auth/login"));
    Check((await f.Store.ReadAsync()).Revision == 0);
}
static async Task Notifications()
{
    using var f = new Fixture();
    Check((await Get(f, "/notifications"))["items"]!.AsArray().Count == 0);
    var s = await f.Store.ReadAsync();
    s.Data["notifications"] = new JsonArray(
        Obj("""{"id":"notice-own","desktopIdentityId":"windows-a","type":"move","title":"Interview scheduled","body":"Real stored event","read":false,"createdAt":"2026-10-12T12:00:00Z","link":"/candidatos"}"""),
        Obj("""{"id":"notice-direct","userId":"windows-a","title":"Existing direct identity reference","read":false,"created":"2026-10-11T12:00:00Z"}"""),
        Obj("""{"id":"notice-other","desktopIdentityId":"windows-b","title":"Other user's event","read":false}"""),
        Obj("""{"id":"notice-legacy","userId":"pb-user","email":"a@example.org","title":"Unmapped legacy event","read":false}"""),
        Obj("""{"id":"notice-unscoped","title":"No recipient","read":false}"""));
    await f.Store.CommitAsync(0, s.Data, "test-import");
    var r = await Get(f, "/notifications"); Check(r["items"]!.AsArray().Count == 2); Check(Str(r["items"]![0]!["id"]) == "notice-own");
    Check(Str(r["items"]![0]!["body"]) == "Real stored event");
    var request = Request("/notifications/notice-own", "PATCH", Obj("""{"read":true}"""), 1);
    var marked = await f.Api.HandleAsync(request, default); Check(marked["item"]!["read"]!.GetValue<bool>());
    Check(JsonNode.DeepEquals(marked, await f.Api.HandleAsync(request, default)));
    await Code("not_found", () => Write(f, "/notifications/notice-other", "PATCH", Obj("""{"read":true}""")));
    await Code("invalid_request", () => Write(f, "/notifications/notice-own", "PATCH", Obj("""{"read":"true"}""")));
    var reader = new LegacyApi(f.Store, true, Fixture.Identity);
    await Code("read_only", () => Write(f, "/notifications/mark-all-read", "POST", new(), reader));
    var allRequest = Request("/notifications/mark-all-read", "POST", new(), 2);
    var all = await f.Api.HandleAsync(allRequest, default); Check(all["items"]!.AsArray().All(x => x!["read"]!.GetValue<bool>()));
    Check(JsonNode.DeepEquals(all, await f.Api.HandleAsync(allRequest, default)));
    var data = (await f.Store.ReadAsync()).Data;
    Check(!data["notifications"]![2]!["read"]!.GetValue<bool>() && !data["notifications"]![3]!["read"]!.GetValue<bool>() && !data["notifications"]![4]!["read"]!.GetValue<bool>());
    var worker = new LegacyApi(f.Store, false, new("windows-b", "b@example.org", "worker", "B"));
    Check((await Get(f, "/notifications", worker))["items"]!.AsArray().Count == 1);
    await Write(f, "/notifications/notice-other", "PATCH", Obj("""{"read":true}"""), worker);
}
static async Task Hydration()
{
    using var f = new Fixture(); var s = await f.Store.ReadAsync();
    s.Data["user_state"] = new JsonArray(Obj("""{"id":"pb-state","userId":"pb-user","state":{"v":1,"theme":"light","homeMode":"console","listings":[{"id":"stale-offer"}],"candidates":[{"id":"stale-candidate"}],"applications":[],"lists":[{"id":"talent-list","name":"Research"}],"favorites":["pb-offer"]}}"""));
    s.Data["candidate_profiles"] = new JsonArray(Obj("""{"id":"pb-candidate","userId":"pb-user","email":"a@example.org","fullName":"Imported Scientist","title":"Researcher","location":"Madrid","skills":["Biology"],"about":"Imported profile","public":false}"""));
    s.Data["listings"] = new JsonArray(Obj("""{"id":"pb-offer","kind":"becario","title":"Research Internship","company":"Pharma","location":"Madrid","pay":"18k","tags":["Lab"],"desc":"Actual description","created":"2026-10-01T00:00:00Z","ownerUserId":"pb-company"}"""));
    s.Data["applications"] = new JsonArray(
        Obj("""{"id":"pb-application","candidateUserId":"pb-candidate","listingId":"pb-offer","stage":"interview","created":"2026-10-02T00:00:00Z","notes":"Meeting"}"""),
        Obj("""{"id":"pb-hired","candidateId":"pb-candidate","listingId":"pb-offer","stage":"hired","createdAt":"2026-10-01T00:00:00Z","hiredAt":"2026-10-06T00:00:00Z"}"""));
    s.Data["notifications"] = new JsonArray(Obj("""{"id":"mapped-notice","userId":"pb-user","title":"Actual migration event","read":false}"""));
    await f.Store.CommitAsync(0, s.Data, "test-import");
    var legacyState = s.Data["user_state"]!.DeepClone(); var legacyProfile = s.Data["candidate_profiles"]!.DeepClone();
    var state = (await Get(f, "/state"))["state"]!.AsObject();
    Check(Str(state["theme"]) == "terminal" && state["lists"]!.AsArray().Count == 0);
    Check((await Get(f, "/profile"))["profile"] is null); Check((await Get(f, "/notifications"))["items"]!.AsArray().Count == 0);
    Check(Str(state["listings"]![0]!["kind"]) == "becario");
    Check(state["listings"]![0]!["createdAt"]!.GetValue<long>() == DateTimeOffset.Parse("2026-10-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture).ToUnixTimeMilliseconds());
    Check(Str(state["candidates"]![0]!["name"]) == "Imported Scientist"); Check(Str(state["candidates"]![0]!["tags"]![0]) == "Biology");
    Check(Str(state["applications"]![0]!["candidateId"]) == "pb-candidate" && Str(state["applications"]![0]!["stage"]) == "entrevista" && Str(state["applications"]![0]!["status"]) == "entrevista");
    var metrics = await Get(f, "/metrics"); Check(metrics["totalApplications"]!.GetValue<int>() == 2); Check(metrics["avgTimeToHire"]!.GetValue<double>() == 5); Check(metrics["conversionRate"]!.GetValue<double>() == 50);
    Check(metrics["applicationsByStage"]!["entrevista"]!.GetValue<int>() == 1 && metrics["listingsByKind"]!["becario"]!.GetValue<int>() == 1);
    Check(Str(metrics["recentActivity"]![0]!["candidateName"]) == "Imported Scientist");
        Check(metrics["totalCandidates"]!.GetValue<int>() == 1);
        var activity = metrics["recentActivity"]!.AsArray();
        var interview = activity.First(x => Str(x!["id"]) == "pb-application")!;
        Check(Str(interview["name"]) == "Imported Scientist" && Str(interview["action"]) == "etapa actual: en entrevista");
        Check(Str(interview["detail"]) == "Research Internship" && Str(interview["icon"]) == "MessageSquare");
        Check(Str(interview["timestamp"]) == "2026-10-02T00:00:00Z" && Str(interview["createdAt"]) == "2026-10-02T00:00:00Z");
        Check(Str(activity[0]!["id"]) == "pb-hired" && Str(activity[0]!["timestamp"]) == "2026-10-06T00:00:00Z");
    var current = await f.Store.ReadAsync(); current.Data["desktop_identity_mappings"] = new JsonArray(Obj("""{"desktopIdentityId":"windows-a","legacyUserId":"pb-user"}"""));
    await f.Store.CommitAsync(current.Revision, current.Data, "explicit-mapping-test");
    state = (await Get(f, "/state"))["state"]!.AsObject();
    Check(Str(state["theme"]) == "light" && state["v"]!.GetValue<int>() == 3 && state["lists"]!.AsArray().Count == 1);
    Check(Str(state["listings"]![0]!["id"]) == "pb-offer" && state["applications"]!.AsArray().Count == 2);
    Check(Str(state["profile"]!["candidato"]!["name"]) == "Imported Scientist");
    Check(Str((await Get(f, "/profile"))["profile"]!["id"]) == "pb-candidate");
    Check((await Get(f, "/notifications"))["items"]!.AsArray().Count == 1);
    await Write(f, "/state", "PUT", Obj("""{"state":{"theme":"terminal","v":3}}"""));
    await Write(f, "/profile", "PUT", Obj("""{"fullName":"Desktop Operator","title":"HR","location":"Madrid"}"""));
    var data = (await f.Store.ReadAsync()).Data;
    Check(JsonNode.DeepEquals(data["user_state"], legacyState)); Check(JsonNode.DeepEquals(data["candidate_profiles"], legacyProfile));
    Check(data["desktop_profiles"]!.AsArray().Count == 1 && data["desktop_user_state"]!.AsArray().Count == 1);
    Check(Str((await Get(f, "/profile"))["profile"]!["id"]) != "pb-candidate");
    Check(Str((await Get(f, "/state"))["state"]!["profile"]!["candidato"]!["name"]) == "Desktop Operator");
    var other = new LegacyApi(f.Store, false, new("windows-b", "a@example.org", "rrhh", "Desktop Operator"));
    Check((await Get(f, "/profile", other))["profile"] is null);
    var worker = new LegacyApi(f.Store, false, new("worker", "a@example.org", "worker", "Worker"));
    var restricted = (await Get(f, "/state", worker))["state"]!;
    Check(restricted["candidates"]!.AsArray().Count == 0 && restricted["applications"]!.AsArray().Count == 0);
}
static async Task SerializedState()
{
    using var f = new Fixture(); await Setup(f);
    var first = await Get(f, "/state"); var revision = Rev(first); var state = first["state"]!.AsObject();
    var before = (await f.Store.ReadAsync()).Data;
    for (var i = 0; i < 4; i++)
    {
        state["theme"] = i % 2 == 0 ? "light" : "terminal";
        state["listings"] = new JsonArray(); state["candidates"] = new JsonArray(); state["applications"] = new JsonArray();
        var request = Request("/state", "PUT", new JsonObject { ["state"] = state.DeepClone() }, revision);
        request["body"] = request["body"]!.ToJsonString();
        var r = await f.Api.HandleAsync(request, default); Check(Rev(r) == revision + 1); revision = Rev(r);
        Check(Rev(await f.Api.HandleAsync(request, default)) == revision);
        var hydrated = (await Get(f, "/state"))["state"]!;
        Check(Str(hydrated["theme"]) == Str(state["theme"])); Check(hydrated["listings"]!.AsArray().Count == 1 && hydrated["applications"]!.AsArray().Count == 1);
    }
    await Code("conflict", () => f.Api.HandleAsync(Request("/state", "PUT", new JsonObject { ["state"] = state.DeepClone() }, revision - 1), default));
    var after = (await f.Store.ReadAsync()).Data;
    foreach (var key in new[] { "listings", "candidates", "applications" }) Check(JsonNode.DeepEquals(before[key], after[key]));
    Check(after["desktop_user_state"]![0]!["state"]!["listings"] is null && after["desktop_user_state"]![0]!["state"]!["pipeline"] is null);
}
static async Task PublishContracts()
{
    using var f = new Fixture();
    foreach (var kind in new[] { "empleo", "ett", "becario", "freelance" })
    {
        var payload = Obj("""{"kind":"empleo","title":"Actual offer","company":"Pharma","location":"Madrid","pay":"18k","tags":["Lab","Research"],"desc":"Actual requirements"}"""); payload["kind"] = kind;
        var request = Request("/listings", "POST", payload, (await f.Store.ReadAsync()).Revision); request["body"] = payload.ToJsonString();
        var r = await f.Api.HandleAsync(request, default); Check(Str(r["item"]!["kind"]) == kind && Str(r["item"]!["desc"]) == "Actual requirements");
    }
    var unsupportedKind = Listing(); unsupportedKind["kind"] = "invalid"; await Code("invalid_request", () => Write(f, "/listings", "POST", unsupportedKind));
    var wrongField = Listing(); wrongField["type"] = "empleo"; await Code("invalid_request", () => Write(f, "/listings", "POST", wrongField));
    var (_, _, app) = await Setup(f); await SeedCatalogs(f);
    var hire = HireBody(app); hire["managerName"] = "Actual Manager"; hire["hardwareProfile"] = "Laptop";
    var result = await Write(f, "/interno/hire/enqueue_it_request", "POST", hire);
    Check(Str(result["movedStage"]) == "hired"); var hp = result["outbox"]!["export_blob"]!["hire_profile"]!;
    foreach (var key in new[] { "applicationId", "departmentId", "jobTitleId", "costCenter", "managerEmail", "managerName", "accessProfileId", "hardwareProfile", "notesIT" }) Check(JsonNode.DeepEquals(hp[key], hire[key]));
}
static async Task Privacy()
{
    using var f = new Fixture(); var r = await Write(f, "/listings", "POST", Listing()); var id = Str(r["item"]!["id"]);
    await Write(f, "/listings/" + id, "PATCH", Obj("""{"title":"Updated"}"""));
    var audit = (await f.Store.ReadAsync()).Data["audit_log"]!.AsArray();
    var expected = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Fixture.Identity.Id)));
    Check(audit.All(x => Str(x!["actorUserId"]) == expected));
    Check(audit.All(x => Str(x!["user"]) == Fixture.Identity.DisplayName));
    Check(!audit.ToJsonString().Contains(Fixture.Identity.Id) && !audit.ToJsonString().Contains(Fixture.Identity.Email) && !audit.ToJsonString().Contains(id));
    foreach (var request in new[] { new JsonObject { ["path"] = "/unsupported/private-person@example.org" }, Request("/listings/private-person@example.org", "PATCH", Obj("""{"title":"Updated"}"""), 2) })
    {
        try { await f.Api.HandleAsync(request, default); throw new Exception("Expected sanitized error"); }
        catch (LegacyApiException ex) { Check(!ex.Message.Contains("private-person") && !ex.Message.Contains("/listings/")); }
    }
}

static async Task MetricsUi()
{
    using var f = new Fixture(); var s = await f.Store.ReadAsync();
    s.Data["candidate_profiles"] = new JsonArray(Obj("""{"id":"old-pb-profile","userId":"old-pb-user","fullName":"","name":" ","firstName":"Ada","lastName":"Lovelace"}"""));
    s.Data["listings"] = new JsonArray(Obj("""{"id":"old-pb-listing","title":"Historical research offer","kind":"empleo","status":"closed"}"""));
    s.Data["applications"] = new JsonArray(
        Obj("""{"id":"old-pb-app1","candidateUserId":"old-pb-profile","listingId":"old-pb-listing","stage":"nuevo","created":"2020-01-01T10:00:00Z","updated":"2026-10-01T10:00:00Z","notes":"Later notes edit"}"""),
        Obj("""{"id":"old-pb-app2","candidateId":"old-pb-profile","listingId":"old-pb-listing","stage":"screening","createdAt":"2020-02-01T10:00:00Z","updatedAt":"2026-10-02T10:00:00Z"}"""));
    await f.Store.CommitAsync(0, s.Data, "representative-import");
    var metrics = await Get(f, "/metrics");
    Check(metrics["totalCandidates"]!.GetValue<int>() == 1 && metrics["totalApplications"]!.GetValue<int>() == 2);
    Check(metrics["totalListings"]!.GetValue<int>() == 1 && metrics["listingsByKind"]!["empleo"]!.GetValue<int>() == 1);
    Check(metrics["avgTimeToHire"] is null && metrics["conversionRate"]!.GetValue<double>() == 0);
    Check(metrics["applicationsByStage"]!["nuevo"]!.GetValue<int>() == 1 && metrics["applicationsByStage"]!["revisar"]!.GetValue<int>() == 1);
    Check(JsonNode.DeepEquals(metrics, await Get(f, "/dashboard/metrics")));
    var activity = metrics["recentActivity"]!.AsArray();
    Check(Str(activity[0]!["id"]) == "old-pb-app2" && Str(activity[1]!["id"]) == "old-pb-app1");
    foreach (var item in activity)
    {
        Check(Str(item!["name"]) == "Ada Lovelace" && Str(item["candidateName"]) == "Ada Lovelace");
        Check(Str(item["candidateId"]) == "old-pb-profile" && Str(item["listingId"]) == "old-pb-listing");
        Check(Str(item["detail"]) == "Historical research offer" && Str(item["listingTitle"]) == "Historical research offer");
        Check(Str(item["timestamp"]) == Str(item["createdAt"]) && Str(item["timestamp"]).StartsWith("2020-"));
    }
    Check(Str(activity[0]!["action"]) == "etapa actual: en revisión" && Str(activity[0]!["icon"]) == "Clock");
    Check(Str(activity[1]!["action"]) == "etapa actual: candidatura recibida" && Str(activity[1]!["icon"]) == "FileText");
    foreach (var key in new[] { "growth", "trends", "candidateGrowth", "applicationGrowth", "activeListings", "closedListings" }) Check(!metrics.ContainsKey(key));
    var unchanged = await f.Store.ReadAsync();
    Check(unchanged.Revision == 1 && JsonNode.DeepEquals(unchanged.Data["candidate_profiles"], s.Data["candidate_profiles"]));
    unchanged.Data["candidates"] = unchanged.Data["candidate_profiles"]!.DeepClone();
    await f.Store.CommitAsync(unchanged.Revision, unchanged.Data, "duplicate-alias-test");
    Check((await Get(f, "/metrics"))["totalCandidates"]!.GetValue<int>() == 1);
    foreach (var (stage, label, icon) in new[]
    {
        ("entrevista", "en entrevista", "MessageSquare"), ("oferta", "en oferta", "CheckCircle2"),
        ("descartado", "descartado", "XCircle"), ("hired", "contratado", "UserPlus")
    })
    {
        await Write(f, "/company/applications/old-pb-app2", "PATCH", new JsonObject { ["stage"] = stage });
        var snapshot = await f.Store.ReadAsync(); var app = snapshot.Data["applications"]![1]!;
        var stageDate = Str(app["stageChangedAt"]); Check(stageDate == Str(app["updated"]));
        var eventRow = (await Get(f, "/metrics"))["recentActivity"]![0]!;
        Check(Str(eventRow["id"]) == "old-pb-app2" && Str(eventRow["action"]) == "etapa actual: " + label && Str(eventRow["icon"]) == icon);
        Check(Str(eventRow["timestamp"]) == stageDate && Str(eventRow["createdAt"]) == "2020-02-01T10:00:00Z");
        await Write(f, "/company/applications/old-pb-app2", "PATCH", Obj("""{"notes":"No new stage event"}"""));
        Check(Str((await Get(f, "/metrics"))["recentActivity"]![0]!["timestamp"]) == stageDate);
    }
    var missing = await f.Store.ReadAsync(); missing.Data["applications"]!.AsArray().Add(Obj("""{"id":"undated-app","candidateId":"old-pb-profile","listingId":"old-pb-listing","stage":"legacy-custom","updated":"2026-10-03T10:00:00Z"}"""));
    await f.Store.CommitAsync(missing.Revision, missing.Data, "undated-import");
    var undated = (await Get(f, "/metrics"))["recentActivity"]!.AsArray().First(x => Str(x!["id"]) == "undated-app")!;
    Check(undated["timestamp"] is null && undated["createdAt"] is null && Str(undated["action"]) == "etapa actual: legacy-custom");
}

sealed class Fixture : IDisposable
{
    public static readonly DesktopIdentity Identity = new("windows-a", "a@example.org", "rrhh", "Windows A");
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "ProyectoX.Legacy.Tests-" + Guid.NewGuid().ToString("N"));
    public SharedStore Store { get; }
    public LegacyApi Api { get; }
    public Fixture() { Directory.CreateDirectory(Root); Store = new SharedStore(Root); Api = new LegacyApi(Store, false, Identity); }
    public void Dispose() { Directory.Delete(Root, true); }
}
