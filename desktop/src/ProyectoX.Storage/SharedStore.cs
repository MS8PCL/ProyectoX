using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace ProyectoX.Storage;

public sealed class SharedStore
{
    private const string StateName = "state.json";
    private const string JournalName = "commit.pending";
    private const string BackupName = "state.backup.json";
    private const string LockName = ".write.lock";
    private static readonly TimeSpan LockTimeout = TimeSpan.FromSeconds(3);
    private readonly string root;
    private readonly bool readOnly;

    // Per-instance fault injection; never part of the host's public contract.
    internal Action<CommitStage>? FailureHook { get; set; }

    public SharedStore(string root, bool readOnly = false)
    {
        if (string.IsNullOrWhiteSpace(root))
            throw new ArgumentException("An existing store directory is required.", nameof(root));
        try
        {
            this.root = Path.GetFullPath(root);
            this.readOnly = readOnly;
            ValidateRoot();
        }
        catch (Exception ex) when (IsStorageError(ex) || ex is ArgumentException)
        {
            throw new StoreUnavailableException("The specified store root is unavailable or unsafe; no fallback was created.", ex);
        }
    }

    public async Task<StoreSnapshot> ReadAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var lease = await AcquireLockAsync(cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return RecoverAndRead();
        }
        catch (Exception ex) when (IsStorageError(ex))
        {
            throw new StoreUnavailableException("Cannot read the shared store; existing files were not reset.", ex);
        }
    }

    public async Task<StoreSnapshot> CommitAsync(long expectedRevision, JsonObject data,
        string actor, CancellationToken cancellationToken = default)
    {
        if (readOnly)
            throw new StoreReadOnlyException();
        ArgumentNullException.ThrowIfNull(data);
        ArgumentException.ThrowIfNullOrWhiteSpace(actor);
        if (expectedRevision < 0)
            throw new ArgumentOutOfRangeException(nameof(expectedRevision));

        // Own the caller's mutable JSON before waiting for the lock.
        var nextData = (JsonObject)data.DeepClone();
        ValidateData(nextData);
        try
        {
            using var lease = await AcquireLockAsync(cancellationToken).ConfigureAwait(false);
            var current = RecoverAndRead();
            if (current.Revision != expectedRevision)
                throw new StoreConflictException(expectedRevision, current.Revision);
            if (current.Revision == long.MaxValue)
                throw new StoreUnavailableException("The store revision cannot increase beyond Int64.MaxValue.");

            var revision = current.Revision + 1;
            var audit = current.Data["audit"]?.DeepClone() as JsonArray ?? new JsonArray();
            audit.Add(new JsonObject
            {
                ["revision"] = revision,
                ["actorHash"] = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(actor))),
                ["timestampUtc"] = DateTimeOffset.UtcNow.ToString("O")
            });
            nextData["audit"] = audit;
            var snapshot = new StoreSnapshot(revision, nextData);
            var document = ToDocument(snapshot);
            var journal = new JsonObject
            {
                ["snapshot"] = document.DeepClone(),
                ["sha256"] = Hash(document)
            };

            cancellationToken.ThrowIfCancellationRequested();
            // Once the durable journal is published, finish without cancellation: a failure
            // here has an uncertain outcome and must be resolved by reading, not blind retry.
            PublishJournal(journal);
            FailureHook?.Invoke(CommitStage.JournalPublished);
            Promote(snapshot);
            FailureHook?.Invoke(CommitStage.StatePromoted);
            DeleteJournal();
            return snapshot;
        }
        catch (Exception ex) when (IsStorageError(ex))
        {
            throw new StoreUnavailableException("Commit could not complete. Read the store to resolve its outcome before retrying.", ex);
        }
    }

    private async Task<FileStream> AcquireLockAsync(CancellationToken cancellationToken)
    {
        var timer = Stopwatch.StartNew();
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ValidateRoot();
            var path = SafePath(LockName);
            try
            {
                // Readers also lock exclusively. A read-only store may create this metadata
                // file, but never modifies state, journal or backup files.
                var exists = File.Exists(path);
                return new FileStream(path,
                    readOnly && exists ? FileMode.Open : FileMode.OpenOrCreate,
                    readOnly && exists ? FileAccess.Read : FileAccess.ReadWrite,
                    FileShare.None);
            }
            catch (IOException ex) when (timer.Elapsed < LockTimeout)
            {
                // Sharing violations and transient share errors are bounded equally.
                _ = ex;
                await Task.Delay(40, cancellationToken).ConfigureAwait(false);
            }
            catch (IOException ex)
            {
                throw new StoreUnavailableException("Could not acquire the store lock within 3 seconds; the share may be unavailable or busy.", ex);
            }
        }
    }

    private StoreSnapshot RecoverAndRead()
    {
        ValidateRoot();
        var statePath = SafePath(StateName);
        var journalPath = SafePath(JournalName);
        var hasState = File.Exists(statePath);
        var hasJournal = File.Exists(journalPath);
        if (hasJournal && readOnly)
            throw new StoreRecoveryRequiredException();

        // Validate the original first. A journal is never a license to overwrite corruption.
        var current = hasState ? ParseSnapshot(ReadObject(statePath)) : EmptySnapshot();
        if (!hasState && File.Exists(SafePath(BackupName)))
            throw new StoreUnavailableException("state.json is missing but a backup exists. Manual investigation is required; refusing to reset the revision.");
        if (!hasJournal)
            return current;

        var journal = ReadObject(journalPath);
        if (journal.Count != 2 || journal["snapshot"] is not JsonObject document ||
            journal["sha256"] is not JsonValue checksum ||
            !checksum.TryGetValue<string>(out var expectedHash) ||
            !string.Equals(Hash(document), expectedHash, StringComparison.Ordinal))
            throw new StoreUnavailableException("Pending journal checksum or structure is invalid; no files were changed.");
        var pending = ParseSnapshot(document);
        if (pending.Revision == current.Revision && hasState)
        {
            if (!JsonNode.DeepEquals(ToDocument(current), document))
                throw new StoreUnavailableException("Pending journal disagrees with state at the same revision; refusing recovery.");
        }
        else if (current.Revision < long.MaxValue && pending.Revision == current.Revision + 1)
        {
            Promote(pending);
        }
        else
        {
            throw new StoreUnavailableException("Pending journal has a stale or non-consecutive revision; refusing to decrease or skip revisions.");
        }
        DeleteJournal();
        return pending;
    }

    private void PublishJournal(JsonObject journal)
    {
        var temporary = WriteTemporary(journal);
        try
        {
            File.Move(temporary, SafePath(JournalName), overwrite: false);
        }
        finally
        {
            DeleteTemporary(temporary);
        }
    }

    private void Promote(StoreSnapshot snapshot)
    {
        var temporary = WriteTemporary(ToDocument(snapshot));
        try
        {
            var state = SafePath(StateName);
            var backup = SafePath(BackupName);
            if (File.Exists(state))
                File.Replace(temporary, state, backup, ignoreMetadataErrors: false);
            else
                File.Move(temporary, state, overwrite: false);
            // WriteTemporary flushed the contents before the same-directory rename.
            // Directory-entry durability depends on the filesystem/server (see README).
        }
        finally
        {
            DeleteTemporary(temporary);
        }
    }

    private string WriteTemporary(JsonObject document)
    {
        var path = SafePath($".store-{Guid.NewGuid():N}.tmp");
        try
        {
            using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                4096, FileOptions.WriteThrough);
            using (var writer = new Utf8JsonWriter(stream))
            {
                document.WriteTo(writer);
                writer.Flush();
            }
            stream.Flush(flushToDisk: true);
            return path;
        }
        catch
        {
            DeleteTemporary(path);
            throw;
        }
    }

    private void DeleteJournal() => File.Delete(SafePath(JournalName));

    private static void DeleteTemporary(string path)
    {
        // Cleanup failure must not obscure the original commit outcome. Orphan temporary
        // files are ignored, never treated as state or automatically promoted.
        try { File.Delete(path); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private void ValidateRoot()
    {
        if (!Directory.Exists(root))
            throw new StoreUnavailableException("The configured root directory does not exist or cannot be accessed; it will not be created.");
        for (var directory = new DirectoryInfo(root); directory is not null; directory = directory.Parent)
        {
            if ((directory.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new StoreUnavailableException("Reparse points in the store root or its ancestors are not allowed.");
        }
    }

    private string SafePath(string name)
    {
        if (Path.GetFileName(name) != name || name is "." or "..")
            throw new StoreUnavailableException("Store filenames cannot traverse directories.");
        var path = Path.Combine(root, name);
        try
        {
            var attributes = File.GetAttributes(path);
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
                throw new StoreUnavailableException($"Unsafe store entry: {name}.");
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { throw new StoreUnavailableException("The store root disappeared."); }
        return path;
    }

    private static JsonObject ReadObject(string path)
    {
        var bytes = File.ReadAllBytes(path);
        // JsonNode otherwise silently accepts duplicate keys until accessed. Reject them
        // recursively so readers and checksum validation have one unambiguous document.
        using var parsed = JsonDocument.Parse(bytes);
        RejectDuplicateKeys(parsed.RootElement);
        return JsonNode.Parse(bytes) as JsonObject
            ?? throw new StoreUnavailableException("Store document must be a JSON object.");
    }

    private static void RejectDuplicateKeys(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                    throw new StoreUnavailableException("Store document contains duplicate JSON properties.");
                RejectDuplicateKeys(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in element.EnumerateArray())
                RejectDuplicateKeys(item);
        }
    }

    private static StoreSnapshot ParseSnapshot(JsonObject document)
    {
        if (document.Count != 2 || document["revision"] is not JsonValue value ||
            !value.TryGetValue<long>(out var revision) || revision < 1 ||
            document["data"] is not JsonObject data)
            throw new StoreUnavailableException("Invalid persisted snapshot: a positive Int64 revision and data object are required.");
        try { ValidateData(data); }
        catch (ArgumentException ex)
        {
            throw new StoreUnavailableException("Persisted data schema is invalid; refusing to reset it.", ex);
        }
        return new StoreSnapshot(revision, data);
    }

    private static void ValidateData(JsonObject data)
    {
        foreach (var name in new[] { "listings", "candidates", "applications" })
            if (data[name] is not JsonArray)
                throw new ArgumentException($"Data must contain the '{name}' array.", nameof(data));
        if (data["audit"] is not null && data["audit"] is not JsonArray)
            throw new ArgumentException("The reserved 'audit' field must be an array.", nameof(data));
    }

    private static StoreSnapshot EmptySnapshot() => new(0, new JsonObject
    {
        ["listings"] = new JsonArray(),
        ["candidates"] = new JsonArray(),
        ["applications"] = new JsonArray()
    });

    private static JsonObject ToDocument(StoreSnapshot snapshot) => new()
    {
        ["revision"] = snapshot.Revision,
        ["data"] = snapshot.Data.DeepClone()
    };

    private static string Hash(JsonObject document) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(document.ToJsonString())));

    private static bool IsStorageError(Exception ex) =>
        ex is IOException or UnauthorizedAccessException or JsonException or NotSupportedException or System.Security.SecurityException;
}

internal enum CommitStage { JournalPublished, StatePromoted }
