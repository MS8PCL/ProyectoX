using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using ProyectoX.Storage;

if (args.Length == 3 && args[0] == "writer")
{
    try
    {
        File.WriteAllText(Path.Combine(args[1], args[2] + ".ready"), "ready");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!File.Exists(Path.Combine(args[1], "go")))
            await Task.Delay(20, timeout.Token);
        await new SharedStore(args[1]).CommitAsync(0, Data(args[2]), args[2], timeout.Token);
        return 0;
    }
    catch (StoreConflictException) { return 3; }
    catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
}

var tests = new (string Name, Func<Task> Run)[]
{
    ("Empty root, exact contract and multi-entity round trip", RoundTrip),
    ("Two concurrent writers: exactly one winner", ConcurrentWriters),
    ("Two independent processes: exactly one winner", ProcessWriters),
    ("Conflicts and monotonic revisions", Conflicts),
    ("Read-only rejects commit without changing state", ReadOnly),
    ("Unavailable root is never created or replaced", Unavailable),
    ("Malformed and duplicate JSON are never reset", Malformed),
    ("Invalid input leaves the store untouched", InvalidInput),
    ("Journal recovery before state promotion", RecoverJournal),
    ("Read-only rejects pending recovery without changing files", ReadOnlyRecovery),
    ("Recovery after promotion is idempotent", RecoverPromoted),
    ("Checksum corruption is rejected", BadChecksum),
    ("Stale, skipped and divergent journal revisions are rejected", BadRevisions),
    ("Corrupt original is not overwritten by a valid journal", CorruptOriginal),
    ("Missing state with backup cannot reset revision", MissingState),
    ("Revision overflow leaves original intact", Overflow),
    ("Lock retry is bounded and cancellable", Locking),
    ("Readers wait for a writer and recover under the same lock", CoordinatedReaders),
    ("Audit stores only actor hash and preserves history", Audit),
    ("Original root and unrelated files remain unchanged", OriginalRoot),
    ("Reparse roots, ancestors and store entries are rejected", Reparse)
};
var failures = 0;
foreach (var test in tests)
{
    try { await test.Run(); Console.WriteLine($"PASS {test.Name}"); }
    catch (Exception ex) { failures++; Console.Error.WriteLine($"FAIL {test.Name}\n{ex}"); }
}
Console.WriteLine($"{tests.Length - failures}/{tests.Length} passed");
return failures == 0 ? 0 : 1;

static JsonObject Data(string id = "item") => new()
{
    ["listings"] = new JsonArray(new JsonObject { ["id"] = id }),
    ["candidates"] = new JsonArray(new JsonObject { ["id"] = "candidate" }),
    ["applications"] = new JsonArray(new JsonObject { ["listingId"] = id, ["candidateId"] = "candidate" })
};
static void Check(bool condition, string message = "Assertion failed")
{
    if (!condition) throw new InvalidOperationException(message);
}
static async Task<T> Throws<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T ex) { return ex; }
    throw new InvalidOperationException($"Expected {typeof(T).Name}");
}
static string State(TempRoot temp) => Path.Combine(temp.Root, "state.json");
static string Pending(TempRoot temp) => Path.Combine(temp.Root, "commit.pending");
static void PutJournal(TempRoot temp, JsonObject snapshot)
{
    var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(snapshot.ToJsonString())));
    File.WriteAllText(Pending(temp), new JsonObject { ["snapshot"] = snapshot, ["sha256"] = hash }.ToJsonString());
}
static JsonObject Document(long revision, string id = "pending") => new()
{
    ["revision"] = revision, ["data"] = Data(id)
};
static async Task Crash(SharedStore store, long revision, CommitStage stage)
{
    store.FailureHook = point => { if (point == stage) throw new IOException("Injected crash boundary"); };
    await Throws<StoreUnavailableException>(() => store.CommitAsync(revision, Data("pending"), "actor"));
    store.FailureHook = null;
}

static async Task RoundTrip()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    var empty = await store.ReadAsync();
    Check(empty.Revision == 0 && !File.Exists(State(temp)));
    var data = Data();
    var written = await store.CommitAsync(0, data, "actor");
    data["listings"] = new JsonArray();
    Check(written.Revision == 1 && written.Data["listings"]!.AsArray().Count == 1);
    var read = await new SharedStore(temp.Root).ReadAsync();
    Check(JsonNode.DeepEquals(written.Data, read.Data));
    read.Data["candidates"] = new JsonArray();
    Check((await store.ReadAsync()).Data["candidates"]!.AsArray().Count == 1);
    Check(!File.Exists(Pending(temp)) && File.Exists(Path.Combine(temp.Root, ".write.lock")));
    var json = JsonNode.Parse(File.ReadAllText(State(temp)))!.AsObject();
    Check(json.Count == 2 && json["revision"]!.GetValue<long>() == 1);
}
static async Task ConcurrentWriters()
{
    using var temp = new TempRoot();
    var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    async Task<bool> Write(string id)
    {
        await gate.Task;
        try { await new SharedStore(temp.Root).CommitAsync(0, Data(id), id); return true; }
        catch (StoreConflictException) { return false; }
    }
    var first = Task.Run(() => Write("one"));
    var second = Task.Run(() => Write("two"));
    gate.SetResult();
    var results = await Task.WhenAll(first, second);
    Check(results.Count(result => result) == 1);
    Check((await new SharedStore(temp.Root).ReadAsync()).Revision == 1);
}
static async Task ProcessWriters()
{
    using var temp = new TempRoot();
    Process Start(string id)
    {
        var info = new ProcessStartInfo("dotnet") { UseShellExecute = false };
        info.ArgumentList.Add(Assembly.GetExecutingAssembly().Location);
        info.ArgumentList.Add("writer"); info.ArgumentList.Add(temp.Root); info.ArgumentList.Add(id);
        return Process.Start(info)!;
    }
    using var first = Start("one");
    using var second = Start("two");
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
    try
    {
        while (!File.Exists(Path.Combine(temp.Root, "one.ready")) || !File.Exists(Path.Combine(temp.Root, "two.ready")))
            await Task.Delay(20, timeout.Token);
        File.WriteAllText(Path.Combine(temp.Root, "go"), "go");
        await Task.WhenAll(first.WaitForExitAsync(timeout.Token), second.WaitForExitAsync(timeout.Token));
        Check(new[] { first.ExitCode, second.ExitCode }.Order().SequenceEqual(new[] { 0, 3 }));
        Check((await new SharedStore(temp.Root).ReadAsync()).Revision == 1);
    }
    finally
    {
        if (!first.HasExited) first.Kill(entireProcessTree: true);
        if (!second.HasExited) second.Kill(entireProcessTree: true);
    }
}
static async Task Conflicts()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await store.CommitAsync(0, Data(), "actor");
    var before = File.ReadAllBytes(State(temp));
    var conflict = await Throws<StoreConflictException>(() => store.CommitAsync(0, Data(), "actor"));
    Check(conflict.ExpectedRevision == 0 && conflict.ActualRevision == 1);
    Check(before.SequenceEqual(File.ReadAllBytes(State(temp))));
    for (var revision = 1; revision <= 4; revision++)
        Check((await store.CommitAsync(revision, Data(), "actor")).Revision == revision + 1);
    var backup = JsonNode.Parse(File.ReadAllText(Path.Combine(temp.Root, "state.backup.json")))!;
    Check(backup["revision"]!.GetValue<long>() == 4);
}
static async Task ReadOnly()
{
    using var temp = new TempRoot();
    await new SharedStore(temp.Root).CommitAsync(0, Data(), "actor");
    var before = File.ReadAllBytes(State(temp));
    var store = new SharedStore(temp.Root, readOnly: true);
    Check((await store.ReadAsync()).Revision == 1);
    await Throws<StoreReadOnlyException>(() => store.CommitAsync(1, Data(), "actor"));
    Check(before.SequenceEqual(File.ReadAllBytes(State(temp))) && !File.Exists(Pending(temp)));
}
static async Task Unavailable()
{
    using var temp = new TempRoot();
    var missing = Path.Combine(temp.Root, "missing", "nested");
    await Throws<StoreUnavailableException>(() => Task.FromResult(new SharedStore(missing)));
    Check(!Directory.Exists(Path.Combine(temp.Root, "missing")));
    var file = Path.Combine(temp.Root, "not-a-directory");
    File.WriteAllText(file, "sentinel");
    await Throws<StoreUnavailableException>(() => Task.FromResult(new SharedStore(file)));
    Check(File.ReadAllText(file) == "sentinel");
    var store = new SharedStore(temp.Root);
    Directory.Delete(temp.Root, recursive: true);
    await Throws<StoreUnavailableException>(() => store.ReadAsync());
    Check(!Directory.Exists(temp.Root));
}
static async Task Malformed()
{
    foreach (var content in new[]
    {
        "{broken", "null", "[]", "{\"revision\":-1,\"data\":{}}",
        "{\"revision\":1,\"data\":{\"listings\":[],\"candidates\":[]}}",
        "{\"revision\":1,\"revision\":2,\"data\":{}}"
    })
    {
        using var temp = new TempRoot();
        File.WriteAllText(State(temp), content);
        var store = new SharedStore(temp.Root);
        await Throws<StoreUnavailableException>(() => store.ReadAsync());
        await Throws<StoreUnavailableException>(() => store.CommitAsync(0, Data(), "actor"));
        Check(File.ReadAllText(State(temp)) == content && !File.Exists(Pending(temp)));
    }
}
static async Task InvalidInput()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await Throws<ArgumentException>(() => store.CommitAsync(0, new JsonObject(), "actor"));
    await Throws<ArgumentException>(() => store.CommitAsync(0, Data(), " "));
    await Throws<ArgumentOutOfRangeException>(() => store.CommitAsync(-1, Data(), "actor"));
    Check(Directory.GetFiles(temp.Root).Length == 0);
}
static async Task RecoverJournal()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await Crash(store, 0, CommitStage.JournalPublished);
    Check(File.Exists(Pending(temp)) && !File.Exists(State(temp)));
    Check((await new SharedStore(temp.Root).ReadAsync()).Revision == 1);
    await Crash(store, 1, CommitStage.JournalPublished);
    Check(JsonNode.Parse(File.ReadAllText(State(temp)))!["revision"]!.GetValue<long>() == 1);
    Check((await new SharedStore(temp.Root).ReadAsync()).Revision == 2);
    Check(!File.Exists(Pending(temp)));
    await Throws<StoreConflictException>(() => store.CommitAsync(1, Data(), "actor"));
}
static async Task ReadOnlyRecovery()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await store.CommitAsync(0, Data(), "actor");
    await Crash(store, 1, CommitStage.JournalPublished);
    var before = File.ReadAllBytes(State(temp));
    var journal = File.ReadAllBytes(Pending(temp));
    var error = await Throws<StoreReadOnlyException>(() => new SharedStore(temp.Root, true).ReadAsync());
    Check(error.Message.Contains("recovery", StringComparison.OrdinalIgnoreCase));
    Check(before.SequenceEqual(File.ReadAllBytes(State(temp))) && journal.SequenceEqual(File.ReadAllBytes(Pending(temp))));
    Check((await store.ReadAsync()).Revision == 2);
}
static async Task RecoverPromoted()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await store.CommitAsync(0, Data(), "actor");
    await Crash(store, 1, CommitStage.StatePromoted);
    var before = File.ReadAllBytes(State(temp));
    Check((await new SharedStore(temp.Root).ReadAsync()).Revision == 2);
    Check(before.SequenceEqual(File.ReadAllBytes(State(temp))) && !File.Exists(Pending(temp)));
    Check((await store.ReadAsync()).Revision == 2);
}
static async Task BadChecksum()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await Crash(store, 0, CommitStage.JournalPublished);
    var journal = JsonNode.Parse(File.ReadAllText(Pending(temp)))!;
    journal["snapshot"]!["revision"] = 2;
    File.WriteAllText(Pending(temp), journal.ToJsonString());
    var before = File.ReadAllBytes(Pending(temp));
    await Throws<StoreUnavailableException>(() => store.ReadAsync());
    Check(!File.Exists(State(temp)) && before.SequenceEqual(File.ReadAllBytes(Pending(temp))));
}
static async Task BadRevisions()
{
    foreach (var revision in new long[] { 1, 2, 4 })
    {
        using var temp = new TempRoot();
        var store = new SharedStore(temp.Root);
        await store.CommitAsync(0, Data(), "actor");
        await store.CommitAsync(1, Data(), "actor");
        var before = File.ReadAllBytes(State(temp));
        PutJournal(temp, Document(revision));
        await Throws<StoreUnavailableException>(() => store.ReadAsync());
        Check(before.SequenceEqual(File.ReadAllBytes(State(temp))) && File.Exists(Pending(temp)));
    }
}
static async Task CorruptOriginal()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await store.CommitAsync(0, Data(), "actor");
    await Crash(store, 1, CommitStage.JournalPublished);
    File.WriteAllText(State(temp), "corruption");
    await Throws<StoreUnavailableException>(() => store.ReadAsync());
    Check(File.ReadAllText(State(temp)) == "corruption" && File.Exists(Pending(temp)));
}
static async Task MissingState()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    await store.CommitAsync(0, Data(), "actor");
    await store.CommitAsync(1, Data(), "actor");
    File.Delete(State(temp));
    await Throws<StoreUnavailableException>(() => store.ReadAsync());
    await Throws<StoreUnavailableException>(() => store.CommitAsync(0, Data(), "actor"));
    Check(!File.Exists(State(temp)));
}
static async Task Overflow()
{
    using var temp = new TempRoot();
    File.WriteAllText(State(temp), Document(long.MaxValue).ToJsonString());
    var before = File.ReadAllBytes(State(temp));
    var store = new SharedStore(temp.Root);
    Check((await store.ReadAsync()).Revision == long.MaxValue);
    await Throws<StoreUnavailableException>(() => store.CommitAsync(long.MaxValue, Data(), "actor"));
    Check(before.SequenceEqual(File.ReadAllBytes(State(temp))) && !File.Exists(Pending(temp)));
}
static async Task Locking()
{
    using var temp = new TempRoot();
    using var lease = new FileStream(Path.Combine(temp.Root, ".write.lock"), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
    var store = new SharedStore(temp.Root);
    using var cancel = new CancellationTokenSource(TimeSpan.FromMilliseconds(150));
    await Throws<OperationCanceledException>(() => store.ReadAsync(cancel.Token));
    var timer = Stopwatch.StartNew();
    await Throws<StoreUnavailableException>(() => store.ReadAsync());
    Check(timer.Elapsed < TimeSpan.FromSeconds(6));
    Check(!File.Exists(State(temp)));
}
static async Task CoordinatedReaders()
{
    using var temp = new TempRoot();
    using var published = new ManualResetEventSlim();
    using var release = new ManualResetEventSlim();
    var store = new SharedStore(temp.Root);
    store.FailureHook = point =>
    {
        if (point == CommitStage.JournalPublished)
        {
            published.Set();
            if (!release.Wait(TimeSpan.FromSeconds(5))) throw new IOException("Test synchronization timed out");
            throw new IOException("Injected writer failure");
        }
    };
    var writer = Task.Run(() => Throws<StoreUnavailableException>(() => store.CommitAsync(0, Data(), "actor")));
    try
    {
        Check(published.Wait(TimeSpan.FromSeconds(5)));
        var reader = new SharedStore(temp.Root).ReadAsync();
        await Task.Delay(100);
        Check(!reader.IsCompleted, "Reader bypassed writer lock");
        release.Set();
        await writer;
        Check((await reader).Revision == 1);
    }
    finally { release.Set(); await writer; }
}
static async Task Audit()
{
    using var temp = new TempRoot();
    var store = new SharedStore(temp.Root);
    const string actor = "person@example.test";
    await store.CommitAsync(0, Data(), actor);
    var input = Data();
    input["audit"] = new JsonArray(new JsonObject { ["actor"] = "forged" });
    var result = await store.CommitAsync(1, input, actor);
    var audit = result.Data["audit"]!.AsArray();
    Check(audit.Count == 2 && audit[0]!["actorHash"]!.GetValue<string>().Length == 64);
    foreach (var path in Directory.GetFiles(temp.Root))
    {
        var contents = File.ReadAllText(path);
        Check(!contents.Contains(actor) && !contents.Contains("forged"));
    }
}
static async Task OriginalRoot()
{
    using var temp = new TempRoot();
    var sentinel = Path.Combine(temp.Root, "original.txt");
    File.WriteAllText(sentinel, "keep me");
    var sibling = Path.Combine(temp.Base, "state.json");
    File.WriteAllText(sibling, "not the store");
    var store = new SharedStore(Path.Combine(temp.Root, "."));
    await store.CommitAsync(0, Data("../not-a-path"), "actor");
    Check(File.ReadAllText(sentinel) == "keep me" && File.ReadAllText(sibling) == "not the store");
    Check(Directory.Exists(temp.Root) && File.Exists(State(temp)));
}
static async Task Reparse()
{
    using var temp = new TempRoot();
    var target = Path.Combine(temp.Base, "target");
    Directory.CreateDirectory(target);
    var link = Path.Combine(temp.Base, "link");
    if (OperatingSystem.IsWindows())
    {
        var info = new ProcessStartInfo("cmd.exe") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        info.ArgumentList.Add("/c"); info.ArgumentList.Add("mklink"); info.ArgumentList.Add("/J");
        info.ArgumentList.Add(link); info.ArgumentList.Add(target);
        using var process = Process.Start(info)!;
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        await process.WaitForExitAsync(timeout.Token);
        Check(process.ExitCode == 0, await process.StandardError.ReadToEndAsync());
    }
    else Directory.CreateSymbolicLink(link, target);
    try
    {
        await Throws<StoreUnavailableException>(() => Task.FromResult(new SharedStore(link)));
        Directory.CreateDirectory(Path.Combine(target, "nested"));
        await Throws<StoreUnavailableException>(() => Task.FromResult(new SharedStore(Path.Combine(link, "nested"))));
        var entry = Path.Combine(temp.Root, "state.json");
        Directory.Move(link, entry);
        link = entry;
        await Throws<StoreUnavailableException>(() => new SharedStore(temp.Root).ReadAsync());
        Check(Directory.GetFiles(target).Length == 0);
    }
    finally { Directory.Delete(link); }
}

sealed class TempRoot : IDisposable
{
    public string Base { get; } = Path.Combine(Path.GetTempPath(), "ProyectoX.Storage.Tests-" + Guid.NewGuid().ToString("N"));
    public string Root { get; }
    public TempRoot()
    {
        Root = Path.Combine(Base, "root");
        Directory.CreateDirectory(Root);
    }
    public void Dispose()
    {
        if (Directory.Exists(Base)) Directory.Delete(Base, recursive: true);
    }
}
