using System.Text.Json.Nodes;

namespace ProyectoX.Storage;

public sealed record StoreSnapshot(long Revision, JsonObject Data);

public sealed class StoreConflictException : Exception
{
    public long ExpectedRevision { get; }
    public long ActualRevision { get; }

    public StoreConflictException(long expectedRevision, long actualRevision)
        : base($"Revision conflict: expected {expectedRevision}, actual {actualRevision}.")
    {
        ExpectedRevision = expectedRevision;
        ActualRevision = actualRevision;
    }
}

public sealed class StoreUnavailableException : Exception
{
    public StoreUnavailableException(string message, Exception? innerException = null)
        : base(message, innerException) { }
}

public class StoreReadOnlyException : Exception
{
    public StoreReadOnlyException(string message = "The shared store is read-only.")
        : base(message) { }
}

public sealed class StoreRecoveryRequiredException : StoreReadOnlyException
{
    public StoreRecoveryRequiredException()
        : base("A pending journal requires recovery by a writable SharedStore; do not delete it manually.") { }
}
