using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ProyectoX.Storage;

namespace ProyectoX.Desktop;

internal sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed class StorageBridge(SharedStore store, bool readOnly)
{
    private static readonly HashSet<string> Collections = ["listings", "candidates", "applications"];
    private static readonly HashSet<string> Stages = ["applied", "screening", "interview", "offer", "hired", "rejected"];
    private static readonly Dictionary<string, HashSet<string>> Fields = new()
    {
        ["listings"] = ["title", "department", "description"],
        ["candidates"] = ["name", "email", "phone"],
        ["applications"] = ["candidateId", "listingId", "stage", "notes"]
    };

    public async Task<JsonObject> HandleAsync(string message, CancellationToken cancellationToken)
    {
        JsonNode? id = null;
        try
        {
            if (message.Length > 1_048_576)
                throw Invalid("La solicitud supera el tamaño permitido.");
            var request = JsonNode.Parse(message) as JsonObject ?? throw Invalid("La solicitud debe ser un objeto JSON.");
            if (request["id"] is not JsonValue requestId ||
                !(requestId.TryGetValue<string>(out _) || requestId.TryGetValue<long>(out _)))
                throw Invalid("id debe ser una cadena o un entero.");
            id = requestId.DeepClone();
            var operation = RequiredString(request, "operation", 64);
            JsonObject result;
            switch (operation)
            {
                case "getState":
                    result = State(await store.ReadAsync(cancellationToken));
                    break;
                case "saveEntity":
                case "deleteEntity":
                    if (readOnly)
                        throw new BridgeException("read_only", "El almacenamiento está en modo solo lectura.");
                    var payload = request["payload"] as JsonObject ?? throw Invalid("payload debe ser un objeto.");
                    result = await MutateAsync(operation, payload, cancellationToken);
                    break;
                default:
                    throw new BridgeException("unsupported_operation", "Operación no soportada. Solo están disponibles getState, saveEntity y deleteEntity; no hay documentos ni tickets.");
            }
            return new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result, ["error"] = null };
        }
        catch (Exception exception)
        {
            var (code, text) = exception switch
            {
                BridgeException validation => (validation.Code, validation.Message),
                StoreConflictException => ("conflict", "Los datos han cambiado. Recargue el estado antes de volver a guardar."),
                StoreRecoveryRequiredException => ("recovery_required", "Hay una operación pendiente. Un usuario con permisos de escritura debe abrir el almacén para recuperarla. No borre commit.pending."),
                StoreReadOnlyException => ("read_only", "El almacenamiento está en modo solo lectura."),
                StoreUnavailableException => ("store_unavailable", "El almacenamiento compartido no está disponible. Compruebe la conexión y los permisos de Windows."),
                OperationCanceledException => ("cancelled", "La solicitud se ha cancelado."),
                JsonException => ("invalid_request", "JSON no válido."),
                _ => ("internal_error", "No se ha podido completar la solicitud.")
            };
            HostLog.Event("bridge_request_failed", exception);
            return new JsonObject
            {
                ["id"] = id, ["ok"] = false, ["result"] = null,
                ["error"] = new JsonObject { ["code"] = code, ["message"] = text }
            };
        }
    }

    private JsonObject State(StoreSnapshot snapshot)
    {
        var data = Normalize(snapshot.Data);
        return new JsonObject
        {
            ["revision"] = snapshot.Revision,
            ["data"] = data,
            ["readOnly"] = readOnly,
            ["appliedOperationIds"] = new JsonArray(((JsonObject)data["_operations"]!).Select(
                receipt => (JsonNode?)JsonValue.Create(receipt.Key)).ToArray())
        };
    }

    private static JsonObject Normalize(JsonObject source)
    {
        var data = (JsonObject)source.DeepClone();
        foreach (var collection in Collections)
        {
            if (!data.ContainsKey(collection)) data[collection] = new JsonArray();
            if (data[collection] is not JsonArray array || array.Any(item => item is not JsonObject))
                throw new BridgeException("store_unavailable", "El formato del almacenamiento no es compatible.");
        }
        if (!data.ContainsKey("_operations")) data["_operations"] = new JsonObject();
        if (data["_operations"] is not JsonObject receipts || receipts.Any(receipt =>
            !Guid.TryParseExact(receipt.Key, "D", out var uuid) || receipt.Key != uuid.ToString("D") ||
            StringValue(receipt.Value) is not { Length: 64 } hash || !hash.All(Uri.IsHexDigit)))
            throw new BridgeException("store_unavailable", "El formato del almacenamiento no es compatible.");
        return data;
    }

    private async Task<JsonObject> MutateAsync(string operation, JsonObject payload, CancellationToken cancellationToken)
    {
        if (StringValue(payload["operationId"]) is not { } operationIdText ||
            !Guid.TryParseExact(operationIdText, "D", out var operationUuid))
            throw Invalid("operationId debe ser una cadena UUID.");
        var operationId = operationUuid.ToString("D");
        if (payload["expectedRevision"] is not JsonValue revisionValue ||
            !revisionValue.TryGetValue<long>(out var expectedRevision) || expectedRevision < 0)
            throw Invalid("expectedRevision debe ser un entero no negativo.");
        var collection = RequiredString(payload, "collection", 64);
        if (!Collections.Contains(collection))
            throw new BridgeException("unsupported_collection", "Solo están soportadas listings, candidates y applications; documentos y tickets no están disponibles.");
        var fingerprint = Fingerprint(operation, collection, payload);
        var snapshot = await store.ReadAsync(cancellationToken);
        var data = Normalize(snapshot.Data);
        if (HasReceipt(data, operationId, fingerprint)) return State(snapshot);
        if (snapshot.Revision != expectedRevision)
            throw new BridgeException("conflict", "Los datos han cambiado. Recargue el estado antes de volver a guardar.");
        var entities = (JsonArray)data[collection]!;
        if (operation == "deleteEntity")
        {
            var id = RequiredString(payload, "id", 128);
            var existing = Find(entities, id) ?? throw new BridgeException("not_found", "La entidad ya no existe.");
            if (collection is "listings" or "candidates")
            {
                var reference = collection == "listings" ? "listingId" : "candidateId";
                if (((JsonArray)data["applications"]!).OfType<JsonObject>().Any(item => StringValue(item[reference]) == id))
                    throw new BridgeException("reference_conflict", "La entidad tiene candidaturas asociadas. Elimínelas antes de eliminar la entidad.");
            }
            entities.Remove(existing);
        }
        else
        {
            var input = payload["entity"] as JsonObject ?? throw Invalid("entity debe ser un objeto.");
            var entity = ValidateEntity(collection, input, entities, data);
            var existing = Find(entities, entity["id"]!.GetValue<string>());
            if (existing is null) entities.Add(entity);
            else entities[entities.IndexOf(existing)] = entity;
        }
        ((JsonObject)data["_operations"]!)[operationId] = fingerprint;
        try
        {
            // Commit the receipt atomically with the mutation; never persist the request body.
            // The actor is an audit label, not an authenticated identity or a role.
            return State(await store.CommitAsync(expectedRevision, data, "desktop", cancellationToken));
        }
        catch (StoreConflictException)
        {
            var current = await store.ReadAsync(cancellationToken);
            if (HasReceipt(Normalize(current.Data), operationId, fingerprint)) return State(current);
            throw;
        }
    }

    private static bool HasReceipt(JsonObject data, string operationId, string fingerprint)
    {
        var receipts = (JsonObject)data["_operations"]!;
        if (!receipts.TryGetPropertyValue(operationId, out var receipt)) return false;
        if (StringValue(receipt) != fingerprint)
            throw Invalid("operationId ya se ha utilizado para una solicitud diferente.");
        return true;
    }

    private static string Fingerprint(string operation, string collection, JsonObject payload)
    {
        var content = new JsonObject { ["operation"] = operation, ["collection"] = collection };
        if (operation == "saveEntity")
            content["entity"] = Canonicalize(payload["entity"] as JsonObject ?? throw Invalid("entity debe ser un objeto."));
        else
            content["id"] = RequiredString(payload, "id", 128);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(content.ToJsonString())));
    }

    // JSON object property order is not part of a mutation's identity.
    private static JsonNode? Canonicalize(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj.OrderBy(field => field.Key, StringComparer.Ordinal)
            .Select(field => new KeyValuePair<string, JsonNode?>(field.Key, Canonicalize(field.Value)))),
        JsonArray array => new JsonArray(array.Select(Canonicalize).ToArray()),
        _ => node?.DeepClone()
    };

    private static JsonObject ValidateEntity(string collection, JsonObject input, JsonArray entities, JsonObject data)
    {
        foreach (var field in input)
            if (!Fields[collection].Contains(field.Key) && field.Key is not ("id" or "createdAt" or "updatedAt"))
                throw Invalid("La entidad contiene campos no permitidos.");

        JsonObject? existing = null;
        string id;
        if (input.ContainsKey("id"))
        {
            id = RequiredString(input, "id", 128);
            existing = Find(entities, id) ?? throw new BridgeException("not_found", "La entidad que se quiere actualizar no existe. Para crear, omita id.");
        }
        else id = Guid.NewGuid().ToString("D");

        foreach (var timestamp in new[] { "createdAt", "updatedAt" })
            if (input.ContainsKey(timestamp) && (existing is null || !JsonNode.DeepEquals(input[timestamp], existing[timestamp])))
                throw Invalid("Las fechas son administradas por el host y no se pueden modificar.");

        var entity = existing is null ? new JsonObject() : (JsonObject)existing.DeepClone();
        foreach (var field in input.Where(field => Fields[collection].Contains(field.Key)))
        {
            if (StringValue(field.Value) is not { } text || text.Length > 20_000)
                throw Invalid("Los campos deben ser textos de hasta 20000 caracteres.");
            entity[field.Key] = text;
        }
        switch (collection)
        {
            case "listings":
                entity["title"] = RequiredString(entity, "title", 300);
                entity["department"] ??= "";
                entity["description"] ??= "";
                break;
            case "candidates":
                entity["name"] = RequiredString(entity, "name", 300);
                var email = RequiredString(entity, "email", 320);
                if (!MailAddress.TryCreate(email, out var address) || address.Address != email ||
                    !email.Contains('@') || email.Any(char.IsWhiteSpace))
                    throw Invalid("email debe ser una dirección de correo válida, sin nombre de presentación.");
                entity["email"] = email;
                entity["phone"] ??= "";
                break;
            case "applications":
                var candidateId = RequiredString(entity, "candidateId", 128);
                var listingId = RequiredString(entity, "listingId", 128);
                if (Find((JsonArray)data["candidates"]!, candidateId) is null || Find((JsonArray)data["listings"]!, listingId) is null)
                    throw new BridgeException("reference_conflict", "La candidatura debe referenciar un candidato y una oferta existentes.");
                var stage = RequiredString(entity, "stage", 32);
                if (!Stages.Contains(stage))
                    throw Invalid("stage debe ser applied, screening, interview, offer, hired o rejected.");
                entity["candidateId"] = candidateId;
                entity["listingId"] = listingId;
                entity["stage"] = stage;
                entity["notes"] ??= "";
                break;
        }
        var now = DateTimeOffset.UtcNow.ToString("O");
        entity["id"] = id;
        if (existing is null) entity["createdAt"] = now;
        entity["updatedAt"] = now;
        return entity;
    }

    private static JsonObject? Find(JsonArray entities, string id) =>
        entities.OfType<JsonObject>().FirstOrDefault(entity => StringValue(entity["id"]) == id);

    private static string? StringValue(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static string RequiredString(JsonObject source, string field, int limit)
    {
        var text = StringValue(source[field]);
        if (string.IsNullOrWhiteSpace(text) || text.Length > limit)
            throw Invalid($"{field} es obligatorio y debe ser un texto de hasta {limit} caracteres.");
        return text.Trim();
    }

    private static BridgeException Invalid(string message) => new("invalid_request", message);
}
