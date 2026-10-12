using System.Text.Json;
using System.Text.Json.Nodes;
using ProyectoX.Storage;

namespace ProyectoX.Desktop;

internal sealed class DesktopBridge(SharedStore store, string root, bool readOnly, DesktopIdentity identity)
{
    private readonly StorageBridge original = new(store, readOnly);
    private readonly LegacyApi api = new(store, readOnly, identity);
    public DocumentApi Documents { get; } = new(store, root, readOnly, identity);

    public async Task<JsonObject> HandleAsync(string message, CancellationToken token)
    {
        JsonNode? id = null;
        try
        {
            if (message.Length > 1_048_576) throw new LegacyApiException("invalid_request", "La solicitud supera el tamaño permitido.");
            var request = JsonNode.Parse(message) as JsonObject ?? throw new LegacyApiException("invalid_request", "Solicitud JSON inválida.");
            if (request["id"] is not JsonValue value || !value.TryGetValue<string>(out var requestId) || requestId.Length > 128)
                throw new LegacyApiException("invalid_request", "Identificador de solicitud inválido.");
            id = value.DeepClone();
            var operation = request["operation"]?.GetValue<string>();
            var payload = request["payload"] as JsonObject ?? new JsonObject();
            JsonObject result;
            if (operation == "legacyApi")
            {
                var path = payload["path"]?.GetValue<string>() ?? "";
                result = DocumentApi.SupportsPath(path)
                    ? await Documents.HandleAsync(payload, token)
                    : await api.HandleAsync(payload, token);
            }
            else if (operation is "uploadBegin" or "uploadChunk" or "uploadFinish")
                result = await Documents.HandleUploadAsync(operation, payload, token);
            else
                return await original.HandleAsync(message, token);
            return Success(id, result);
        }
        catch (Exception exception)
        {
            return Failure(id, exception);
        }
    }

    public static JsonObject Success(JsonNode? id, JsonObject result) => new()
    {
        ["id"] = id?.DeepClone(), ["ok"] = true, ["result"] = result, ["error"] = null
    };

    public static JsonObject Failure(JsonNode? id, Exception exception)
    {
        var (code, message) = exception switch
        {
            LegacyApiException legacy => (legacy.Code, legacy.Message),
            BridgeException validation => (validation.Code, validation.Message),
            StoreConflictException => ("conflict", "Los datos han cambiado. Actualice antes de guardar."),
            StoreRecoveryRequiredException => ("recovery_required", "Hay una operación pendiente. Abra el almacén con permisos de escritura para recuperarla; no borre commit.pending."),
            StoreReadOnlyException => ("read_only", "El almacenamiento está en modo solo lectura."),
            StoreUnavailableException => ("store_unavailable", "El almacenamiento no está disponible. Compruebe la conexión y los permisos."),
            OperationCanceledException => ("cancelled", "Operación cancelada."),
            JsonException => ("invalid_request", "Solicitud JSON inválida."),
            _ => ("internal_error", "No se pudo completar la operación. Actualice antes de repetir una escritura.")
        };
        HostLog.Event("desktop_request_failed", exception);
        return new JsonObject
        {
            ["id"] = id?.DeepClone(), ["ok"] = false, ["result"] = null,
            ["error"] = new JsonObject
                        {
                            ["code"] = code, ["message"] = message,
                            ["uncertain"] = exception is StoreUnavailableException or System.IO.IOException
                        }
        };
    }
}
