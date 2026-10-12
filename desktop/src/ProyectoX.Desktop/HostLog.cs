using System.Diagnostics;

namespace ProyectoX.Desktop;

internal static class HostLog
{
    // Never log exception messages, request bodies, paths or business data.
    public static void Event(string eventName, Exception? exception = null) =>
        Trace.WriteLine($"ProyectoX event={eventName} exceptionType={exception?.GetType().Name ?? "none"}");
}
