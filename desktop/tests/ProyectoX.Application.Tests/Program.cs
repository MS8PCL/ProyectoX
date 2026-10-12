using System.Globalization;
using System.Reflection.Metadata;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ProyectoX.Desktop;
using ProyectoX.Storage;

var tests = new (string Name, Func<Fixture, Task> Run)[]
{
    ("getState empty JSON contract", async f =>
    {
        var state = Success(await f.Get());
        Check(Revision(state) == 0 && !state["readOnly"]!.GetValue<bool>(), "Initial state flags");
        foreach (var collection in Fixture.Collections)
            Check(Entities(state, collection).Count == 0, $"Empty {collection}");
        Check(((JsonArray)state["appliedOperationIds"]!).Count == 0, "No applied operations initially");
        Check(!File.Exists(Path.Combine(f.Root, "state.json")), "Read must not publish state");
    }),
    ("CRUD listings, candidates, applications and persisted revisions", async f =>
    {
        var listing = await f.Create("listings", new() { ["title"] = "Developer" });
        var candidate = await f.Create("candidates", new() { ["name"] = "Ada", ["email"] = "ada@example.com" });
        var application = await f.Create("applications", new()
        {
            ["listingId"] = Id(listing), ["candidateId"] = Id(candidate), ["stage"] = "applied"
        });
        Check(f.Revision == 3, "Each creation increments revision");
        foreach (var entity in new[] { listing, candidate, application })
        {
            Check(Guid.TryParse(Id(entity), out _), "Host generated UUID");
            foreach (var field in new[] { "createdAt", "updatedAt" })
                Check(DateTimeOffset.TryParseExact(entity[field]!.GetValue<string>(), "O", CultureInfo.InvariantCulture,
                    DateTimeStyles.None, out _), $"Host timestamp {field}");
        }
        Check(listing["department"]!.GetValue<string>() == "" && candidate["phone"]!.GetValue<string>() == "" &&
            application["notes"]!.GetValue<string>() == "", "Default fields");
        var updatedListing = await f.Update("listings", new() { ["id"] = Id(listing), ["title"] = "Lead" });
        var updatedCandidate = await f.Update("candidates", new() { ["id"] = Id(candidate), ["name"] = "Ada Lovelace" });
        var updatedApplication = await f.Update("applications", new() { ["id"] = Id(application), ["notes"] = "Reviewed" });
        Check(updatedListing["title"]!.GetValue<string>() == "Lead", "Listing update");
        Check(updatedCandidate["name"]!.GetValue<string>() == "Ada Lovelace", "Candidate update");
        Check(updatedApplication["notes"]!.GetValue<string>() == "Reviewed", "Application update");
        Check(JsonNode.DeepEquals(listing["createdAt"], updatedListing["createdAt"]), "Creation time preserved");
        var reopened = Success(await f.Get(new StorageBridge(new SharedStore(f.Root), false)));
        Check(Revision(reopened) == 6, "Revision survives reopening");
        Check(JsonNode.DeepEquals(reopened, Success(await f.Get())), "Full JSON survives reopening");
        await f.Delete("applications", Id(application));
        await f.Delete("candidates", Id(candidate));
        await f.Delete("listings", Id(listing));
        var final = Success(await f.Get());
        Check(Revision(final) == 9, "CRUD revision count");
        foreach (var collection in Fixture.Collections)
            Check(Entities(final, collection).Count == 0, $"Deleted {collection}");
    }),
    ("referenced deletes and missing application references blocked", async f =>
    {
        var (listing, candidate, _) = await f.Seed();
        await f.Reject("deleteEntity", f.DeletePayload("listings", Id(listing)), "reference_conflict");
        await f.Reject("deleteEntity", f.DeletePayload("candidates", Id(candidate)), "reference_conflict");
        foreach (var field in new[] { "listingId", "candidateId" })
        {
            var entity = new JsonObject { ["listingId"] = Id(listing), ["candidateId"] = Id(candidate), ["stage"] = "applied" };
            entity[field] = "missing";
            await f.Reject("saveEntity", f.SavePayload("applications", entity), "reference_conflict");
        }
    }),
    ("all stages accepted, invalid stages rejected", async f =>
    {
        var (_, _, application) = await f.Seed();
        foreach (var stage in new[] { "applied", "screening", "interview", "offer", "hired", "rejected" })
        {
            var updated = await f.Update("applications", new() { ["id"] = Id(application), ["stage"] = stage });
            Check(updated["stage"]!.GetValue<string>() == stage, $"Stage {stage}");
        }
        foreach (var stage in new[] { "unknown", "HIRED", "" })
            await f.Reject("saveEntity", f.SavePayload("applications", new() { ["id"] = Id(application), ["stage"] = stage }), "invalid_request");
    }),
    ("bridge and storage read-only prohibit writes", async f =>
    {
        var listing = await f.Create("listings", new() { ["title"] = "Original" });
        foreach (var (bridge, advertisedReadOnly) in new[]
        {
            (new StorageBridge(new SharedStore(f.Root), true), true),
            (new StorageBridge(new SharedStore(f.Root, readOnly: true), false), false)
        })
        {
            var state = Success(await f.Get(bridge));
            Check(state["readOnly"]!.GetValue<bool>() == advertisedReadOnly, "Bridge read-only flag");
            await f.Reject("saveEntity", f.SavePayload("listings", new() { ["title"] = "Blocked" }), "read_only", bridge);
            await f.Reject("saveEntity", f.SavePayload("listings", new() { ["id"] = Id(listing), ["title"] = "Blocked" }), "read_only", bridge);
            await f.Reject("deleteEntity", f.DeletePayload("listings", Id(listing)), "read_only", bridge);
        }
    }),
    ("stale revision conflicts never overwrite", async f =>
    {
        var listing = await f.Create("listings", new() { ["title"] = "Original" });
        var stale = f.Revision;
        await f.Update("listings", new() { ["id"] = Id(listing), ["title"] = "Winner" });
        var save = f.SavePayload("listings", new() { ["id"] = Id(listing), ["title"] = "Loser" });
        save["expectedRevision"] = stale;
        await f.Reject("saveEntity", save, "conflict");
        var delete = f.DeletePayload("listings", Id(listing));
        delete["expectedRevision"] = stale;
        await f.Reject("deleteEntity", delete, "conflict");
        Check(Entities(Success(await f.Get()), "listings")[0]!["title"]!.GetValue<string>() == "Winner", "Winner preserved");
    }),
    ("unknown operation and collection rejected", async f =>
    {
        await f.Reject("launchExecutable", null, "unsupported_operation");
        foreach (var collection in new[] { "documents", "tickets", "unknown" })
            await f.Reject("saveEntity", f.SavePayload(collection, new()), "unsupported_collection");
    }),
    ("client timestamps rejected, unchanged timestamps accepted", async f =>
    {
        foreach (var field in new[] { "createdAt", "updatedAt" })
            await f.Reject("saveEntity", f.SavePayload("listings", new() { ["title"] = "Forged", [field] = "2000-01-01T00:00:00Z" }), "invalid_request");
        var listing = await f.Create("listings", new() { ["title"] = "Original" });
        foreach (var field in new[] { "createdAt", "updatedAt" })
            foreach (var value in new JsonNode?[] { JsonValue.Create("2000-01-01T00:00:00Z"), null })
                await f.Reject("saveEntity", f.SavePayload("listings", new() { ["id"] = Id(listing), [field] = value?.DeepClone() }), "invalid_request");
        listing["title"] = "Round trip";
        var updated = await f.Update("listings", listing);
        Check(updated["title"]!.GetValue<string>() == "Round trip", "Unchanged host timestamps allowed");
    }),
    ("malformed requests return JSON errors", async f =>
    {
        foreach (var input in new[] { "{", "[]", "{}", "{\"id\":true,\"operation\":\"getState\"}" })
            Error(await f.Bridge.HandleAsync(input, f.Token), "invalid_request");
        var negative = f.SavePayload("listings", new() { ["title"] = "Invalid" });
        negative["expectedRevision"] = -1;
        await f.Reject("saveEntity", negative, "invalid_request");
    }),
    ("storage errors sanitized without paths or exception details", async f =>
    {
        await f.Create("listings", new() { ["title"] = "Original" });
        var statePath = Path.Combine(f.Root, "state.json");
        var marker = "PRIVATE-ERROR-DETAIL";
        var corrupt = "{ " + marker + " " + f.Root;
        await File.WriteAllTextAsync(statePath, corrupt, f.Token);
        var response = await f.Get();
        Error(response, "store_unavailable");
        var json = response.ToJsonString();
        foreach (var secret in new[] { f.Root, JsonValue.Create(f.Root)!.ToJsonString().Trim('"'), statePath, marker, "JsonException", "System.IO" })
            Check(!json.Contains(secret, StringComparison.OrdinalIgnoreCase), $"Response leaked {secret}");
        Check(await File.ReadAllTextAsync(statePath, f.Token) == corrupt, "Corruption not reset");
    }),
    ("operationId UUID required for every mutation", async f =>
    {
        foreach (var operation in new[] { "saveEntity", "deleteEntity" })
            foreach (var value in new JsonNode?[] { null, JsonValue.Create("not-a-uuid"), JsonValue.Create(42), JsonValue.Create("") })
            {
                var payload = operation == "saveEntity" ? f.SavePayload("listings", new() { ["title"] = "Invalid" }) :
                    f.DeletePayload("listings", "missing");
                payload["operationId"] = value?.DeepClone();
                await f.Reject(operation, payload, "invalid_request");
                payload.Remove("operationId");
                await f.Reject(operation, payload, "invalid_request");
            }
    }),
    ("stale creation replay after reopening returns current state without writing", async f =>
    {
        var payload = f.SavePayload("listings", new() { ["title"] = "Only once", ["department"] = "Engineering" });
        var original = Success(await f.Send("saveEntity", payload));
        Check(Revision(original) == 1, "First creation committed");
        var other = f.SavePayload("candidates", new() { ["name"] = "Ada", ["email"] = "ada@example.com" });
        other["expectedRevision"] = 1;
        Success(await f.Send("saveEntity", other));
        var reopened = new StorageBridge(new SharedStore(f.Root), false);
        var current = Success(await f.Get(reopened));
        var files = StoreFiles(f.Root);
        // Reordered JSON and a changed revision must have the same fingerprint.
        payload["entity"] = new JsonObject { ["department"] = "Engineering", ["title"] = "Only once" };
        payload["expectedRevision"] = 0;
        payload["operationId"] = payload["operationId"]!.GetValue<string>().ToUpperInvariant();
        var replay = Success(await f.Send("saveEntity", payload, reopened));
        Check(JsonNode.DeepEquals(current, replay) && Revision(replay) == 2, "Replay returns latest state");
        Check(Entities(replay, "listings").Count == 1, "Creation not duplicated");
        SameFiles(files, StoreFiles(f.Root));
    }),
    ("operationId reuse with different entity, collection, operation or id rejected", async f =>
    {
        var payload = f.SavePayload("listings", new() { ["title"] = "Original" });
        var created = Success(await f.Send("saveEntity", payload));
        var changed = (JsonObject)payload.DeepClone();
        changed["entity"]!["title"] = "Different";
        await f.Reject("saveEntity", changed, "invalid_request");
        changed = (JsonObject)payload.DeepClone();
        changed["collection"] = "candidates";
        changed["entity"] = new JsonObject { ["name"] = "Ada", ["email"] = "ada@example.com" };
        await f.Reject("saveEntity", changed, "invalid_request");
        var deletion = f.DeletePayload("listings", Id((JsonObject)Entities(created, "listings")[0]!));
        deletion["operationId"] = payload["operationId"]!.DeepClone();
        await f.Reject("deleteEntity", deletion, "invalid_request");
        deletion["operationId"] = Guid.NewGuid().ToString("D");
        deletion["expectedRevision"] = 1;
        Success(await f.Send("deleteEntity", deletion));
        deletion["id"] = "another-id";
        await f.Reject("deleteEntity", deletion, "invalid_request");
    }),
    ("update replay after deletion bypasses entity existence checks", async f =>
    {
        var listing = await f.Create("listings", new() { ["title"] = "Original" });
        var update = f.SavePayload("listings", new() { ["id"] = Id(listing), ["title"] = "Updated" });
        Success(await f.Send("saveEntity", update));
        var deletion = f.DeletePayload("listings", Id(listing));
        deletion["expectedRevision"] = 2;
        Success(await f.Send("deleteEntity", deletion));
        var files = StoreFiles(f.Root);
        var replay = Success(await f.Send("saveEntity", update, new StorageBridge(new SharedStore(f.Root), false)));
        Check(Revision(replay) == 3 && Entities(replay, "listings").Count == 0, "Update replay does not recreate deleted entity");
        SameFiles(files, StoreFiles(f.Root));
    }),
    ("deletion replay after reopening succeeds without another commit", async f =>
    {
        var listing = await f.Create("listings", new() { ["title"] = "Delete once" });
        var deletion = f.DeletePayload("listings", Id(listing));
        var deleted = Success(await f.Send("deleteEntity", deletion));
        var files = StoreFiles(f.Root);
        var replay = Success(await f.Send("deleteEntity", deletion, new StorageBridge(new SharedStore(f.Root), false)));
        Check(JsonNode.DeepEquals(deleted, replay) && Revision(replay) == 2, "Repeated stale deletion succeeds");
        Check(Entities(replay, "listings").Count == 0, "Deleted entity remains absent");
        SameFiles(files, StoreFiles(f.Root));
    }),
    ("receipts persist only UUIDs and SHA256 fingerprints, not payload or PII", async f =>
    {
        var payload = f.SavePayload("candidates", new()
        {
            ["name"] = "Private Person", ["email"] = "private@example.com", ["phone"] = "PRIVATE-PHONE"
        });
        var state = Success(await f.Send("saveEntity", payload));
        var persisted = (JsonObject)JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(f.Root, "state.json"), f.Token))!;
        var receipts = (JsonObject)persisted["data"]!["_operations"]!;
        Check(receipts.Count == 1 && receipts.ContainsKey(payload["operationId"]!.GetValue<string>()), "Receipt persisted atomically");
        var fingerprint = receipts.First().Value!.GetValue<string>();
        Check(fingerprint.Length == 64 && fingerprint.All(Uri.IsHexDigit), "SHA256 only");
        var content = new JsonObject
        {
            ["operation"] = "saveEntity", ["collection"] = "candidates",
            ["entity"] = new JsonObject { ["email"] = "private@example.com", ["name"] = "Private Person", ["phone"] = "PRIVATE-PHONE" }
        };
        Check(fingerprint == Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content.ToJsonString()))), "Fingerprint covers mutation content only");
        foreach (var text in new[] { "Private Person", "private@example.com", "PRIVATE-PHONE", "expectedRevision", "saveEntity", "entity" })
            Check(!receipts.ToJsonString().Contains(text, StringComparison.Ordinal), "No request contents in receipts");
        Check(JsonNode.DeepEquals(state["data"]!["_operations"], receipts), "State exposes persisted receipts");
    }),
    ("parallel same operationId succeeds for all callers with a single commit", async f =>
    {
        var payload = f.SavePayload("listings", new() { ["title"] = "Shared operation" });
        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var tasks = Enumerable.Range(0, 8).Select(_ => Task.Run(async () =>
        {
            var bridge = new StorageBridge(new SharedStore(f.Root), false);
            await gate.Task.WaitAsync(f.Token);
            return await f.Send("saveEntity", payload, bridge);
        }, f.Token)).ToArray();
        gate.SetResult(true);
        var responses = await Task.WhenAll(tasks);
        var final = Success(await f.Get(new StorageBridge(new SharedStore(f.Root), false)));
        foreach (var response in responses)
            Check(JsonNode.DeepEquals(Success(response), final), "Every caller resolves same committed state");
        Check(Revision(final) == 1 && Entities(final, "listings").Count == 1, "Only one mutation");
        Check(((JsonArray)final["data"]!["audit"]!).Count == 1 && ((JsonObject)final["data"]!["_operations"]!).Count == 1,
            "Only one audit entry and receipt");
    }),
    ("pending journal read-only maps recovery_required without modifying files", async f =>
    {
        await f.Create("listings", new() { ["title"] = "Persisted" });
        var current = Success(await f.Get());
        var snapshot = new JsonObject { ["revision"] = 2, ["data"] = current["data"]!.DeepClone() };
        var journal = new JsonObject
        {
            ["snapshot"] = snapshot.DeepClone(),
            ["sha256"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(snapshot.ToJsonString())))
        };
        await File.WriteAllTextAsync(Path.Combine(f.Root, "commit.pending"), journal.ToJsonString(), f.Token);
        var files = StoreFiles(f.Root);
        var reader = new StorageBridge(new SharedStore(f.Root, readOnly: true), true);
        var response = await f.Get(reader);
        Error(response, "recovery_required");
        Check(response["error"]!["message"]!.GetValue<string>() ==
            "Hay una operación pendiente. Un usuario con permisos de escritura debe abrir el almacén para recuperarla. No borre commit.pending.", "Exact recovery guidance");
        SameFiles(files, StoreFiles(f.Root));
        var recovered = Success(await f.Get());
        Check(Revision(recovered) == 2 && !File.Exists(Path.Combine(f.Root, "commit.pending")), "Writer recovers journal");
    }),
    ("parallel commits have one winner and no lost updates", async f =>
    {
        const int writers = 8;
        const int rounds = 3;
        for (var round = 0; round < rounds; round++)
        {
            var before = Success(await f.Get());
            var revision = Revision(before);
            var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            var tasks = Enumerable.Range(0, writers).Select(index => Task.Run(async () =>
            {
                var bridge = new StorageBridge(new SharedStore(f.Root), false);
                var payload = new JsonObject
                {
                    ["operationId"] = Guid.NewGuid().ToString("D"),
                                        ["expectedRevision"] = revision, ["collection"] = "listings",
                    ["entity"] = new JsonObject { ["title"] = $"round-{round}-writer-{index}" }
                };
                await gate.Task.WaitAsync(f.Token);
                return await f.Send("saveEntity", payload, bridge);
            }, f.Token)).ToArray();
            gate.SetResult(true);
            var responses = await Task.WhenAll(tasks);
            var winners = responses.Where(response => response["ok"]!.GetValue<bool>()).ToArray();
            Check(winners.Length == 1, $"Round {round}: exactly one winner");
            foreach (var loser in responses.Where(response => !response["ok"]!.GetValue<bool>()))
                Error(loser, "conflict");
            var after = Success(await f.Get(new StorageBridge(new SharedStore(f.Root), false)));
            Check(Revision(after) == revision + 1, "Single revision increment");
            Check(JsonNode.DeepEquals(after, Success(winners[0])), "Persisted state equals winner");
            var previous = Entities(before, "listings");
            var current = Entities(after, "listings");
            Check(current.Count == previous.Count + 1, "Exactly one entity added");
            foreach (var entity in previous)
                Check(current.Any(item => JsonNode.DeepEquals(item, entity)), "Previous commits preserved");
        }
    })
};

var failed = 0;
foreach (var (name, run) in tests)
{
    try
    {
        using var fixture = new Fixture();
        await run(fixture);
        Console.WriteLine($"PASS {name}");
    }
    catch (Exception exception)
    {
        failed++;
        Console.WriteLine($"FAIL {name}: {exception}");
    }
}
Console.WriteLine($"RESULT {tests.Length - failed}/{tests.Length} passed; {failed} failed");
if (args.Length > 0)
{
    try
    {
        Check(args.Length == 2, "Package check requires assembly path and compiled UI directory");
        using var stream = File.OpenRead(args[0]);
        using var pe = new PEReader(stream);
        var metadata = pe.GetMetadataReader();
        var resources = pe.GetSectionData(pe.PEHeaders.CorHeader!.ResourcesDirectory.RelativeVirtualAddress);
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var handle in metadata.ManifestResources)
        {
            var resource = metadata.GetManifestResource(handle);
            var name = metadata.GetString(resource.Name).Replace('\\', '/');
            if (!name.StartsWith("ProyectoX.Ui/", StringComparison.Ordinal)) continue;
            Check(resource.Implementation.IsNil, "UI must be embedded, not linked to external files");
            var relative = name["ProyectoX.Ui/".Length..];
            Check(!relative.Split('/').Any(segment => segment is "." or ".."), "Safe embedded path");
            var offset = checked((int)resource.Offset);
            var reader = resources.GetReader(offset, resources.Length - offset);
            var length = reader.ReadInt32();
            var embedded = reader.ReadBytes(length);
            var builtFile = Path.Combine(args[1], relative.Replace('/', Path.DirectorySeparatorChar));
            Check(File.Exists(builtFile) && embedded.SequenceEqual(File.ReadAllBytes(builtFile)), $"Embedded asset matches build: {relative}");
            names.Add(relative);
        }
        var expected = Directory.GetFiles(args[1], "*", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(args[1], path).Replace('\\', '/')).ToHashSet(StringComparer.Ordinal);
        Check(names.Contains("index.html") && names.SetEquals(expected), "Every generated UI asset is embedded");
        Console.WriteLine($"PASS Package: {names.Count} embedded UI resources match the compiled UI; application not launched");
    }
    catch (Exception exception)
    {
        failed++;
        Console.WriteLine($"FAIL Package: {exception}");
    }
}
return failed == 0 ? 0 : 1;

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

static JsonObject Success(JsonObject response)
{
    Envelope(response);
    Check(response["ok"]!.GetValue<bool>(), $"Expected success: {response}");
    Check(response["error"] is null && response["result"] is JsonObject, "Success envelope");
    var result = (JsonObject)response["result"]!;
    Check(result.Count == 4 && result["data"] is JsonObject && result["readOnly"] is JsonValue &&
            result["appliedOperationIds"] is JsonArray, "State contract");
        var receipts = (JsonObject)result["data"]!["_operations"]!;
        var ids = ((JsonArray)result["appliedOperationIds"]!).Select(id => id!.GetValue<string>()).ToArray();
        Check(ids.Length == receipts.Count && ids.ToHashSet(StringComparer.Ordinal).SetEquals(receipts.Select(receipt => receipt.Key)),
            "Applied ids match durable receipts");
    _ = Revision(result);
    return result;
}

static void Error(JsonObject response, string code)
{
    Envelope(response);
    Check(!response["ok"]!.GetValue<bool>() && response["result"] is null, "Error envelope");
    var error = response["error"] as JsonObject;
    Check(error is { Count: 2 } && error["code"]!.GetValue<string>() == code &&
        !string.IsNullOrWhiteSpace(error["message"]!.GetValue<string>()), $"Expected error {code}: {response}");
}

static void Envelope(JsonObject response) => Check(response.Count == 4 &&
    new[] { "id", "ok", "result", "error" }.All(response.ContainsKey), "Exact response envelope");
static long Revision(JsonObject state) => state["revision"]!.GetValue<long>();
static JsonArray Entities(JsonObject state, string collection) => (JsonArray)state["data"]![collection]!;
static string Id(JsonObject entity) => entity["id"]!.GetValue<string>();

static Dictionary<string, byte[]> StoreFiles(string root) => Directory.GetFiles(root)
    .ToDictionary(path => Path.GetFileName(path)!, File.ReadAllBytes, StringComparer.Ordinal);

static void SameFiles(Dictionary<string, byte[]> before, Dictionary<string, byte[]> after)
{
    Check(before.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(after.Keys), "No files added or removed");
    foreach (var (name, bytes) in before)
        Check(bytes.SequenceEqual(after[name]), $"File unchanged: {name}");
}

sealed class Fixture : IDisposable
{
    public static readonly string[] Collections = ["listings", "candidates", "applications"];
    private readonly CancellationTokenSource timeout = new(TimeSpan.FromSeconds(20));
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "ProyectoX.Application.Tests-" + Guid.NewGuid().ToString("N"));
    public StorageBridge Bridge { get; }
    public CancellationToken Token => timeout.Token;
    public long Revision { get; private set; }

    public Fixture()
    {
        Directory.CreateDirectory(Root);
        Bridge = new StorageBridge(new SharedStore(Root), false);
    }

    public async Task<JsonObject> Send(string operation, JsonObject? payload = null, StorageBridge? bridge = null)
    {
        var id = Guid.NewGuid().ToString("N");
        var request = new JsonObject { ["id"] = id, ["operation"] = operation, ["payload"] = payload?.DeepClone() };
        var response = await (bridge ?? Bridge).HandleAsync(request.ToJsonString(), Token);
        // Exercise the wire representation rather than depending on in-memory node types.
        response = (JsonObject)JsonNode.Parse(response.ToJsonString())!;
        if (response["id"]?.GetValue<string>() != id) throw new InvalidOperationException("Request id not echoed");
        return response;
    }

    public Task<JsonObject> Get(StorageBridge? bridge = null) => Send("getState", bridge: bridge);
    public JsonObject SavePayload(string collection, JsonObject entity) => new()
    {
        ["operationId"] = Guid.NewGuid().ToString("D"),
                ["expectedRevision"] = Revision, ["collection"] = collection, ["entity"] = entity.DeepClone()
    };
    public JsonObject DeletePayload(string collection, string id) => new()
    {
        ["operationId"] = Guid.NewGuid().ToString("D"),
                ["expectedRevision"] = Revision, ["collection"] = collection, ["id"] = id
    };

    public Task<JsonObject> Create(string collection, JsonObject entity) => Update(collection, entity);
    public async Task<JsonObject> Update(string collection, JsonObject entity)
    {
        var result = Accept(await Send("saveEntity", SavePayload(collection, entity)));
        var array = (JsonArray)result["data"]![collection]!;
        var saved = entity["id"] is null ? (JsonObject)array.Last()! :
            array.OfType<JsonObject>().Single(item => item["id"]!.GetValue<string>() == entity["id"]!.GetValue<string>());
        return (JsonObject)saved.DeepClone();
    }

    public async Task Delete(string collection, string id) => Accept(await Send("deleteEntity", DeletePayload(collection, id)));

    private JsonObject Accept(JsonObject response)
    {
        if (!response["ok"]!.GetValue<bool>() || response["error"] is not null || response.Count != 4)
            throw new InvalidOperationException($"Mutation failed: {response}");
        var result = (JsonObject)response["result"]!;
        var revision = result["revision"]!.GetValue<long>();
        if (revision != Revision + 1) throw new InvalidOperationException("Mutation did not increment revision once");
        Revision = revision;
        return result;
    }

    public async Task Reject(string operation, JsonObject? payload, string code, StorageBridge? bridge = null)
    {
        var before = await Get();
        var path = Path.Combine(Root, "state.json");
        var bytes = File.Exists(path) ? await File.ReadAllBytesAsync(path, Token) : null;
        var response = await Send(operation, payload, bridge);
        if (response.Count != 4 || response["ok"]!.GetValue<bool>() || response["result"] is not null ||
            response["error"] is not JsonObject error || error.Count != 2 || error["code"]!.GetValue<string>() != code ||
            string.IsNullOrWhiteSpace(error["message"]!.GetValue<string>()))
            throw new InvalidOperationException($"Expected {code}: {response}");
        if (!JsonNode.DeepEquals(before["result"], (await Get())["result"]))
            throw new InvalidOperationException("Rejected request changed state");
        var after = File.Exists(path) ? await File.ReadAllBytesAsync(path, Token) : null;
        if (bytes is null ? after is not null : after is null || !bytes.SequenceEqual(after))
            throw new InvalidOperationException("Rejected request changed persisted bytes");
    }

    public async Task<(JsonObject Listing, JsonObject Candidate, JsonObject Application)> Seed()
    {
        var listing = await Create("listings", new() { ["title"] = "Developer" });
        var candidate = await Create("candidates", new() { ["name"] = "Ada", ["email"] = "ada@example.com" });
        var application = await Create("applications", new()
        {
            ["listingId"] = listing["id"]!.DeepClone(), ["candidateId"] = candidate["id"]!.DeepClone(), ["stage"] = "applied"
        });
        return (listing, candidate, application);
    }

    public void Dispose()
    {
        timeout.Dispose();
        Directory.Delete(Root, recursive: true);
    }
}
