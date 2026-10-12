using System.IO;
using System.IO.Compression;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using ProyectoX.Storage;

namespace ProyectoX.Desktop;

public sealed record PreparedDocument(byte[] Bytes, string FileName, string Mime);

/// <summary>Host-owned uploads and immutable local documents. No caller-supplied filesystem paths.</summary>
public sealed class DocumentApi(SharedStore store, string root, bool readOnly, DesktopIdentity identity)
{
    public const int MaxFileBytes = 50 * 1024 * 1024;
    public const int MaxTotalBytes = 64 * 1024 * 1024;
    public const int MaxChunkBytes = 256 * 1024;
    public const int MaxZipBytes = 256 * 1024 * 1024;
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly Dictionary<string, Upload> uploads = new(StringComparer.Ordinal);
        private sealed record DocumentSource(JsonObject Metadata, string? ImportedRelativePath = null);
    private sealed class Upload(string fileName, string mime, int size)
    {
        public string FileName { get; } = fileName;
        public string Mime { get; } = mime;
        public int Size { get; } = size;
        public MemoryStream Buffer { get; } = new();
        public bool Finished { get; set; }
        public DateTimeOffset Touched { get; set; } = DateTimeOffset.UtcNow;
    }

    // Static by design: the host can dispatch before constructing a request body.
    public static bool SupportsPath(string path)
    {
        var p = ParsePath(path);
        return p == "/profile/imports" || p is "/profile/imports/file" or "/profile/imports/link" ||
            Regex.IsMatch(p, @"^/company/candidates/[^/]+/cv$") ||
            Regex.IsMatch(p, @"^/interno/listings/[^/]+/(import_candidate|export\.zip)$") ||
            Regex.IsMatch(p, @"^/interno/applications/[^/]+/(export\.zip|documents(/[^/]+)?)$") ||
            Regex.IsMatch(p, @"^/documents/[^/]+$");
    }

    /// <summary>begin {fileName,mime,size}; chunk {uploadId,offset,base64,sha256}; finish {uploadId,sha256}.</summary>
    public async Task<JsonObject> HandleUploadAsync(string op, JsonObject payload, CancellationToken token)
    {
        Authorize();
        if (readOnly) throw Error("read_only", "El almacenamiento está en modo solo lectura.");
        await gate.WaitAsync(token);
        try
        {
            ExpireUploads();
            if (op == "uploadBegin")
            {
                var name = FileName(Required(payload, "fileName", 240));
                var mime = Mime(name, Required(payload, "mime", 150));
                var size = Integer(payload, "size");
                if (size < 1 || size > MaxFileBytes || uploads.Count >= 128 || uploads.Values.Sum(x => (long)x.Size) + size > MaxTotalBytes)
                    throw Invalid("Límite de subida: 50 MiB por archivo y 64 MiB por host.");
                var id = Guid.NewGuid().ToString("D");
                uploads.Add(id, new Upload(name, mime, (int)size));
                return new JsonObject { ["uploadId"] = id, ["chunkBytes"] = MaxChunkBytes };
            }
            var uploadId = Required(payload, "uploadId", 36);
            if (!uploads.TryGetValue(uploadId, out var upload)) throw Invalid("Subida desconocida o caducada en este host.");
            upload.Touched = DateTimeOffset.UtcNow;
            if (op == "uploadChunk")
            {
                if (upload.Finished) throw Invalid("La subida ya está cerrada.");
                var bytes = Decode(payload, MaxChunkBytes);
                VerifyHash(bytes, Required(payload, "sha256", 64));
                var offset = Integer(payload, "offset");
                if (offset < 0 || offset > upload.Buffer.Length) throw Invalid("Offset inválido.");
                // Exact duplicate chunks are safe to retry after an uncertain bridge response.
                if (offset >= 0 && offset + bytes.Length <= upload.Buffer.Length)
                {
                    if (!upload.Buffer.GetBuffer().AsSpan((int)offset, bytes.Length).SequenceEqual(bytes)) throw Invalid("El chunk repetido no coincide.");
                }
                else
                {
                    if (offset != upload.Buffer.Length || offset + bytes.Length > upload.Size) throw Invalid("Offset o longitud de chunk inválidos.");
                    await upload.Buffer.WriteAsync(bytes, token);
                }
                return new JsonObject { ["uploadId"] = uploadId, ["offset"] = upload.Buffer.Length };
            }
            if (op != "uploadFinish") throw Invalid("Operación de subida no permitida.");
            if (upload.Buffer.Length != upload.Size) throw Invalid("La subida está incompleta.");
            VerifyHash(upload.Buffer.GetBuffer().AsSpan(0, upload.Size), Required(payload, "sha256", 64));
            upload.Finished = true;
            return new JsonObject { ["uploadId"] = uploadId, ["fileName"] = upload.FileName, ["mime"] = upload.Mime, ["size"] = upload.Size };
        }
        finally { gate.Release(); }
    }

    public async Task<JsonObject> HandleAsync(JsonObject payload, CancellationToken token)
    {
        Authorize();
        var path = ParsePath(Required(payload, "path", 4096));
        if (!SupportsPath(path)) throw Error("unsupported_operation", "Ruta de documentos no implementada.");
        var method = (Text(payload["method"]) ?? "GET").ToUpperInvariant();
        JsonObject body;
        try
        {
            body = payload["body"] switch
            {
                null => new JsonObject(),
                JsonObject obj => (JsonObject)obj.DeepClone(),
                JsonValue value when value.TryGetValue<string>(out var json) => JsonNode.Parse(json) as JsonObject ?? throw Invalid("body debe ser un objeto."),
                _ => throw Invalid("body debe ser un objeto.")
            };
        }
        catch (JsonException) { throw Invalid("body contiene JSON inválido."); }
        await gate.WaitAsync(token);
        try
        {
            ExpireUploads();
            var snapshot = await store.ReadAsync(token);
            var data = (JsonObject)snapshot.Data.DeepClone();
            ValidateCollections(data);
            if (method == "GET") return Metadata(Read(data, path), snapshot);
            if (readOnly) throw Error("read_only", "El almacenamiento está en modo solo lectura.");
            if (method != "POST") throw Error("unsupported_operation", "Solo GET y POST están permitidos.");
            if (path.StartsWith("/interno/", StringComparison.Ordinal)) Staff();
            var op = Required(payload, "operationId", 36);
            if (!Guid.TryParseExact(op, "D", out var uuid) || uuid.ToString("D") != op) throw Invalid("operationId debe ser UUID canónico.");
            var revision = Integer(payload, "expectedRevision");
            if (revision < 0) throw Invalid("Revisión inválida.");
            var fingerprint = Hash(Encoding.UTF8.GetBytes(Canonical(new JsonObject { ["path"] = path, ["method"] = method, ["body"] = body.DeepClone(), ["identityId"] = identity.Id, ["identityRole"] = identity.Role }).ToJsonString()));
            var operations = Object(data, "_operations");
            var results = Object(data, "_documentResults");
            if (operations.ContainsKey(op))
            {
                if (Text(operations[op]) != fingerprint || results[op] is not JsonObject saved) throw Invalid("operationId ya utilizado para otra solicitud.");
                return Metadata((JsonObject)saved.DeepClone(), snapshot);
            }
            if (snapshot.Revision != revision) throw Error("conflict", "Los datos han cambiado. Recargue antes de guardar.");
            var used = new HashSet<string>(StringComparer.Ordinal);
            // Files are published before state. A failed/uncertain commit may leave harmless
            // UUID orphans; never delete files that a recovered journal may reference.
            var result = await WriteAsync(data, path, body, used, token);
            operations[op] = fingerprint;
            results[op] = result.DeepClone();
            Rows(data, "audit_log").Add(new JsonObject { ["id"] = Guid.NewGuid().ToString("D"), ["at"] = Now(), ["action"] = method + " " + path, ["actorUserId"] = identity.Id, ["correlationId"] = op });
            StoreSnapshot committed;
            try { committed = await store.CommitAsync(revision, data, identity.Id, token); }
            catch (StoreConflictException)
            {
                var current = await store.ReadAsync(token);
                if (Text(current.Data["_operations"]?[op]) != fingerprint || current.Data["_documentResults"]?[op] is not JsonObject replay)
                    throw Error("conflict", "Los datos han cambiado durante la escritura.");
                return Metadata((JsonObject)replay.DeepClone(), current);
            }
            foreach (var id in used) { uploads[id].Buffer.Dispose(); uploads.Remove(id); }
            return Metadata(result, committed);
        }
        finally { gate.Release(); }
    }

    private JsonObject Read(JsonObject data, string path)
    {
        var p = path.Split('/');
        if (path == "/profile/imports") return Items(Rows(data, "profile_imports").OfType<JsonObject>().Where(x => Text(x["userId"]) == identity.Id));
        if (path.StartsWith("/company/", StringComparison.Ordinal))
        {
            Staff();
            Candidate(data, p[3]);
            if (!Rows(data, "applications").OfType<JsonObject>().Any(x => CandidateId(x) == p[3])) throw Error("forbidden", "El candidato no tiene candidaturas.");
            var doc = Rows(data, "profile_imports").OfType<JsonObject>()
                .Where(x => ImportMatchesCandidate(data, x, p[3]) && (Text(x["docType"]) == "cv" || Text(x["kind"]) == "cv") && IsDocumentImport(x))
                .OrderByDescending(x => Text(x["created"])).FirstOrDefault();
            if (doc is null) return new JsonObject { ["ok"] = true, ["url"] = "" };
            SingleDocument(data, doc);
            return new JsonObject { ["ok"] = true, ["url"] = "/documents/" + (Text(doc["documentId"]) ?? Required(doc, "id", 256)) };
        }
        if (path.StartsWith("/interno/applications/", StringComparison.Ordinal) && p.Length == 5 && p[4] == "documents")
        {
            Staff(); var application = Find(data, "applications", p[3]);
            return Items(ApplicationImports(data, application).Select(ImportView));
        }
        if (path.EndsWith("/export.zip", StringComparison.Ordinal))
        {
            Staff(); Find(data, p[2], p[3]);
            return new JsonObject { ["ok"] = true, ["path"] = path, ["nativeActionRequired"] = true };
        }
        var document = ResolveDocument(data, path).Metadata;
        return new JsonObject { ["ok"] = true, ["path"] = "/documents/" + Text(document["id"]), ["fileName"] = Text(document["fileName"]), ["mime"] = Text(document["mime"]), ["size"] = document["size"]?.DeepClone(), ["nativeActionRequired"] = true };
    }

    private async Task<JsonObject> WriteAsync(JsonObject data, string path, JsonObject body, HashSet<string> used, CancellationToken token)
    {
        if (path == "/profile/imports/link")
        {
            var kind = Required(body, "kind", 30);
            var url = Required(body, "url", 2048);
            if (kind is not ("portfolio" or "behance" or "dribbble") || !Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || !string.IsNullOrEmpty(uri.UserInfo)) throw Invalid("Enlace no permitido.");
            var item = NewRecord(); item["userId"] = identity.Id; item["kind"] = kind; item["url"] = url;
            item["consentText"] = "He revisado y apruebo importar y almacenar estos datos en mi cuenta.";
            Rows(data, "profile_imports").Add(item);
            return new JsonObject { ["ok"] = true, ["item"] = item.DeepClone() };
        }
        if (path != "/profile/imports/file" && !path.EndsWith("/import_candidate", StringComparison.Ordinal)) throw Error("unsupported_operation", "Operación no implementada.");
        var (fields, files) = Form(body);
        if (files.Sum(x => Integer(x, "size")) > MaxTotalBytes) throw Invalid("El formulario supera 64 MiB.");
        string userId = identity.Id;
        string? applicationId = null;
        JsonObject? application = null;
        if (path != "/profile/imports/file")
        {
            var listing = Find(data, "listings", path.Split('/')[3]);
            var owner = Required(listing, "ownerUserId", 256);
            var first = Required(fields, "firstName", 80);
            var last = Required(fields, "lastName", 120);
            var email = Required(fields, "email", 120).ToLowerInvariant();
            if (!MailAddress.TryCreate(email, out var address) || address.Address != email || email.Any(char.IsWhiteSpace) || !email.Contains('@')) throw Invalid("Email inválido.");
            var birth = Required(fields, "birthDate", 40);
            if (!DateOnly.TryParseExact(birth, "yyyy-MM-dd", out var date)) throw Invalid("Fecha de nacimiento inválida.");
            var cover = Required(fields, "coverLetter", 5000);
            if (files.Count(x => Text(x["name"]) == "cv") != 1 || files.Any(x => Text(x["name"]) is not ("cv" or "certificates"))) throw Invalid("CV obligatorio; solo se permiten certificados adicionales.");
            MergeCandidates(data);
            var candidate = Rows(data, "candidates").OfType<JsonObject>().FirstOrDefault(x => string.Equals(Text(x["email"]), email, StringComparison.OrdinalIgnoreCase));
            if (candidate is null)
            {
                candidate = NewRecord(); candidate["userId"] = ""; candidate["public"] = false; candidate["skills"] = new JsonArray();
                foreach (var key in new[] { "title", "location", "about" }) candidate[key] = "";
                Rows(data, "candidates").Add(candidate);
            }
            candidate["firstName"] = first; candidate["lastName"] = last; candidate["fullName"] = first + " " + last; candidate["name"] = first + " " + last; candidate["email"] = email; candidate["updated"] = Now();
            userId = Required(candidate, "id", 256);
            application = NewRecord(); applicationId = Text(application["id"]);
            application["listingId"] = Text(listing["id"]); application["companyUserId"] = owner;
            application["candidateUserId"] = userId; application["candidateId"] = userId;
            application["stage"] = "nuevo"; application["notes"] = ""; application["birthDate"] = date.ToString("yyyy-MM-dd"); application["coverLetter"] = cover;
        }
        else
        {
            var type = Required(fields, "docType", 30);
            if (type is not ("cv" or "certificate" or "portfolio" or "linkedin" or "other") || files.Count != 1 || Text(files[0]["name"]) != "file") throw Invalid("docType o archivo inválido.");
        }
        // Validate every part before publishing any bytes or references.
        var materialized = files.Select(x => (Part: x, File: FilePart(x, used))).ToList();
        JsonObject? imported = null;
        foreach (var entry in materialized)
        {
            var file = entry.File;
            var id = Guid.NewGuid().ToString("D");
            var target = SafeDocumentPath(id, createDirectory: true);
            await using (var stream = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None, 8192, FileOptions.WriteThrough))
            {
                await stream.WriteAsync(file.Bytes, token);
                stream.Flush(true);
            }
            var document = new JsonObject { ["id"] = id, ["fileName"] = file.FileName, ["mime"] = file.Mime, ["size"] = file.Bytes.Length, ["sha256"] = Hash(file.Bytes) };
            Rows(data, "documents").Add(document);
            imported = NewRecord(); imported["userId"] = userId; imported["applicationId"] = applicationId;
            imported["kind"] = "document"; imported["docType"] = applicationId is null ? Text(fields["docType"]) : Text(entry.Part["name"]) == "cv" ? "cv" : "certificate";
            imported["file"] = file.FileName; imported["documentId"] = id;
            imported["url"] = "/documents/" + id;
            imported["consentText"] = applicationId is null ? "He revisado y apruebo importar y almacenar estos datos en mi cuenta." : "Internal import: consent";
            Rows(data, "profile_imports").Add(imported);
        }
        if (application is not null)
        {
            Rows(data, "applications").Add(application);
            if (data.ContainsKey("candidate_profiles")) data["candidate_profiles"] = Rows(data, "candidates").DeepClone();
            return new JsonObject { ["ok"] = true, ["applicationId"] = applicationId, ["candidateProfileId"] = userId };
        }
        return new JsonObject { ["ok"] = true, ["item"] = imported!.DeepClone() };
    }

    /// <summary>Called only by the native host after user consent; never serialized over WebView.</summary>
    public async Task<PreparedDocument> PrepareExportAsync(string path, CancellationToken token)
    {
        Authorize(); path = ParsePath(path);
        var snapshot = await store.ReadAsync(token);
        var data = (JsonObject)snapshot.Data.DeepClone(); ValidateCollections(data);
        if (!path.EndsWith("/export.zip", StringComparison.Ordinal)) return await ReadDocumentAsync(ResolveDocument(data, path), token);
        Staff();
        var p = path.Split('/');
        if (p.Length != 5 || p[1] != "interno" || p[2] is not ("applications" or "listings")) throw Invalid("Ruta ZIP inválida.");
        var entity = Find(data, p[2], p[3]);
        var applications = p[2] == "applications" ? new[] { entity } : Rows(data, "applications").OfType<JsonObject>().Where(x => Text(x["listingId"]) == p[3]).ToArray();
        var imports = applications.SelectMany(x => ApplicationImports(data, x)).DistinctBy(x => Text(x["id"])).ToArray();
        var documents = imports.SelectMany(x => ImportDocuments(data, x))
            .DistinctBy(x => x.ImportedRelativePath ?? "documents/" + Text(x.Metadata["id"]) + ".bin").ToArray();
        var manifest = new JsonObject { ["entity"] = entity.DeepClone(), ["applications"] = new JsonArray(applications.Select(x => x.DeepClone()).ToArray()), ["imports"] = new JsonArray(imports.Select(x => x.DeepClone()).ToArray()), ["candidates"] = new JsonArray(applications.Select(x => Candidate(data, CandidateId(x))).DistinctBy(x => Text(x["id"])).Select(x => x.DeepClone()).ToArray()) };
        var manifestBytes = Encoding.UTF8.GetBytes(manifest.ToJsonString());
        long total = manifestBytes.Length;
        foreach (var doc in documents) { var size = Integer(doc.Metadata, "size"); if (size < 1 || size > MaxFileBytes) throw Invalid("Tamaño de documento inválido."); total += size; }
        if (total > MaxZipBytes) throw Invalid("La exportación supera 256 MiB.");
        using var output = new MemoryStream();
        using (var zip = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            await using (var stream = zip.CreateEntry("manifest.json").Open()) await stream.WriteAsync(manifestBytes, token);
            foreach (var doc in documents)
            {
                var file = await ReadDocumentAsync(doc, token);
                await using var stream = zip.CreateEntry("documents/" + FileName(Required(doc.Metadata, "id", 240)) + "/" + file.FileName, CompressionLevel.Fastest).Open();
                await stream.WriteAsync(file.Bytes, token);
                if (output.Length > MaxZipBytes) throw Invalid("El ZIP supera 256 MiB.");
            }
        }
        if (output.Length > MaxZipBytes) throw Invalid("El ZIP supera 256 MiB.");
        return new PreparedDocument(output.ToArray(), p[2] == "applications" ? "application_export.zip" : "listing_export.zip", "application/zip");
    }

    private DocumentSource ResolveDocument(JsonObject data, string path)
    {
        var p = path.Split('/'); JsonObject import;
        if (p.Length == 3 && p[1] == "documents")
            import = Rows(data, "profile_imports").OfType<JsonObject>().FirstOrDefault(x => Text(x["documentId"]) == p[2])
                ?? Find(data, "profile_imports", p[2]);
        else if (p.Length == 6 && p[1] == "interno" && p[2] == "applications" && p[4] == "documents")
        {
            Staff(); var application = Find(data, "applications", p[3]); import = Find(data, "profile_imports", p[5]);
            if (!BelongsToApplication(data, import, application)) throw Error("forbidden", "El documento no pertenece a esta candidatura.");
        }
        else throw Invalid("Ruta de documento inválida.");
        if (Text(import["userId"]) != identity.Id)
        {
            Staff();
            if (!Rows(data, "applications").OfType<JsonObject>().Any(x => BelongsToApplication(data, import, x)))
                throw Error("forbidden", "Documento sin candidatura accesible.");
        }
        return SingleDocument(data, import);
    }

    private static bool IsDocumentImport(JsonObject import) => !string.IsNullOrEmpty(Text(import["documentId"])) ||
        Text(import["kind"]) is "document" or "cv" or "certificate" || !string.IsNullOrEmpty(Text(import["docType"])) ||
        new[] { "file", "files" }.Any(field => !string.IsNullOrEmpty(Text(import[field])) || import[field] is JsonArray { Count: > 0 } ||
            import["_desktopFiles"] is JsonObject mapping && mapping[field] is JsonArray { Count: > 0 });

    private static bool ImportMatchesCandidate(JsonObject data, JsonObject import, string candidateId)
    {
        var candidate = Candidate(data, candidateId);
        var userId = Text(candidate["userId"]);
        var references = new[] { Text(import["userId"]), Text(import["candidateUserId"]), Text(import["candidateId"]) }
            .Where(x => !string.IsNullOrEmpty(x)).ToArray();
        return references.Length > 0 && references.All(x => x == candidateId || !string.IsNullOrEmpty(userId) && x == userId);
    }

    private static bool BelongsToApplication(JsonObject data, JsonObject import, JsonObject application)
    {
        var appId = Text(import["applicationId"]);
        if (!string.IsNullOrEmpty(appId) && appId != Text(application["id"])) return false;
        // Direct application references may predate candidate metadata. If candidate
        // references are supplied, they must agree with the profile or its PB user ID.
        var hasCandidate = new[] { "userId", "candidateUserId", "candidateId" }.Any(x => !string.IsNullOrEmpty(Text(import[x])));
        return !hasCandidate ? !string.IsNullOrEmpty(appId) : ImportMatchesCandidate(data, import, CandidateId(application));
    }

    private static IEnumerable<JsonObject> ApplicationImports(JsonObject data, JsonObject application) =>
        Rows(data, "profile_imports").OfType<JsonObject>().Where(x => IsDocumentImport(x) && BelongsToApplication(data, x, application));

    private static JsonObject ImportView(JsonObject import)
    {
        var view = (JsonObject)import.DeepClone();
        view["file"] ??= import["files"]?.DeepClone();
        if (Text(view["docType"]) is null && Text(import["kind"]) is "cv" or "certificate") view["docType"] = import["kind"]!.DeepClone();
        return view;
    }

    private DocumentSource SingleDocument(JsonObject data, JsonObject import)
    {
        var documents = ImportDocuments(data, import);
        if (documents.Count != 1) throw Error("unsupported_operation", "Este registro contiene varios archivos; utilice la exportación ZIP.");
        return documents[0];
    }

    private List<DocumentSource> ImportDocuments(JsonObject data, JsonObject import)
    {
        if (Text(import["documentId"]) is { } id)
            return [new DocumentSource(Find(data, "documents", id))];
        if (import["_desktopFiles"] is not JsonObject mapping)
            throw Error("unsupported_operation", "El documento antiguo no tiene un mapping _desktopFiles verificado; no se utilizan rutas o URLs originales.");
        var fields = new[] { "file", "files" }.Where(x => mapping.ContainsKey(x)).ToArray();
        if (fields.Length != 1 || mapping[fields[0]] is not JsonArray entries || entries.Count == 0)
            throw Error("unsupported_operation", "Mapping de archivos desconocido o ambiguo.");
        var field = fields[0];
        var rawFiles = import[field];
        if (Text(rawFiles) is { } encoded && encoded.StartsWith('['))
        {
            try { rawFiles = JsonNode.Parse(encoded); }
            catch (JsonException) { throw Error("unsupported_operation", "Campo de archivos antiguo no reconocido."); }
        }
        var names = rawFiles switch
        {
            JsonValue value when value.TryGetValue<string>(out var name) && !string.IsNullOrEmpty(name) => new[] { name },
            JsonArray array when array.Count > 0 && array.All(x => Text(x) is { Length: > 0 }) => array.Select(x => Text(x)!).ToArray(),
            _ => throw Error("unsupported_operation", "Campo de archivo antiguo no reconocido.")
        };
        foreach (var name in names) FileName(name);
        if (names.Distinct(StringComparer.Ordinal).Count() != names.Length || entries.Count != names.Length)
            throw Error("unsupported_operation", "El mapping no cubre exactamente los archivos originales.");
        var result = new List<DocumentSource>();
        var mappedNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in entries)
        {
            if (node is not JsonObject entry || entry.Count != 4 || new[] { "fileName", "relativePath", "size", "sha256" }.Any(key => !entry.ContainsKey(key)))
                            throw Error("unsupported_operation", "Metadata de archivo desconocida.");
            var name = FileName(Required(entry, "fileName", 240));
            if (!names.Contains(name, StringComparer.Ordinal) || !mappedNames.Add(name)) throw Invalid("El mapping no coincide con el campo de archivo.");
            var relative = Required(entry, "relativePath", 2048);
            var segments = ImportedPathSegments(relative);
            if (segments[2] != Required(import, "id", 240) || segments[3] != name ||
                Text(import["collectionId"]) is { Length: > 0 } collectionId && segments[1] != collectionId)
                throw Invalid("La ruta importada no pertenece a este registro y archivo.");
            var size = Integer(entry, "size");
            if (size < 1 || size > MaxFileBytes) throw Invalid("Tamaño de documento inválido.");
            var hash = Required(entry, "sha256", 64);
            if (hash.Length != 64 || !hash.All(Uri.IsHexDigit)) throw Invalid("SHA-256 importado inválido.");
            var mime = Path.GetExtension(name).ToLowerInvariant() switch
            {
                ".pdf" => "application/pdf", ".doc" => "application/msword",
                ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                _ => throw Error("unsupported_operation", "Formato de documento importado no soportado.")
            };
            result.Add(new DocumentSource(new JsonObject { ["id"] = Required(import, "id", 240), ["fileName"] = name, ["mime"] = mime, ["size"] = size, ["sha256"] = hash }, relative));
        }
        return result;
    }

    private async Task<PreparedDocument> ReadDocumentAsync(DocumentSource source, CancellationToken token)
    {
        var doc = source.Metadata;
        var size = Integer(doc, "size");
        if (size < 1 || size > MaxFileBytes) throw Invalid("Tamaño de documento inválido.");
        var name = FileName(Required(doc, "fileName", 240)); var mime = Mime(name, Required(doc, "mime", 150));
        var path = source.ImportedRelativePath is { } relative ? SafeImportedPath(relative) : SafeDocumentPath(Required(doc, "id", 36), false);
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length != size) throw Error("store_unavailable", "El tamaño del documento no coincide.");
        var bytes = new byte[(int)size]; await stream.ReadExactlyAsync(bytes, token);
        VerifyHash(bytes, Required(doc, "sha256", 64));
        return new PreparedDocument(bytes, name, mime);
    }

    private static string[] ImportedPathSegments(string relative)
    {
        if (Path.IsPathRooted(relative) || relative.Contains('\\') || relative.Contains('%') || relative.Any(char.IsControl)) throw Invalid("Ruta importada no canónica.");
        var segments = relative.Split('/');
        if (segments.Length != 4 || segments[0] != "pocketbase-storage" || segments.Any(x => string.IsNullOrWhiteSpace(x)))
            throw Invalid("Solo se permiten rutas pocketbase-storage/colección/registro/archivo.");
        foreach (var segment in segments) FileName(segment);
        return segments;
    }

    private string SafeImportedPath(string relative)
    {
        var segments = ImportedPathSegments(relative);
        var fullRoot = Path.GetFullPath(root);
        if (!Directory.Exists(fullRoot)) throw Error("store_unavailable", "La raíz configurada debe existir.");
        for (var info = new DirectoryInfo(fullRoot); info is not null; info = info.Parent)
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw Error("store_unavailable", "Raíz con reparse point no permitida.");
        var path = Path.GetFullPath(Path.Combine(fullRoot, Path.Combine(segments)));
        var prefix = Path.EndsInDirectorySeparator(fullRoot) ? fullRoot : fullRoot + Path.DirectorySeparatorChar;
                if (!path.StartsWith(prefix, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) throw Invalid("Ruta fuera de la raíz configurada.");
        var current = fullRoot;
        for (var i = 0; i < segments.Length; i++)
        {
            current = Path.Combine(current, segments[i]);
            FileAttributes attributes;
            try { attributes = File.GetAttributes(current); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { throw Error("store_unavailable", "Archivo importado no disponible."); }
            if ((attributes & FileAttributes.ReparsePoint) != 0 || ((attributes & FileAttributes.Directory) != 0) != (i < segments.Length - 1))
                throw Error("store_unavailable", "Archivo importado o ancestro inseguro.");
        }
        return path;
    }

    private PreparedDocument FilePart(JsonObject part, HashSet<string> used)
    {
        var name = FileName(Required(part, "fileName", 240)); var mime = Mime(name, Required(part, "mime", 150)); var size = Integer(part, "size");
        if (size < 1 || size > MaxFileBytes) throw Invalid("Tamaño inválido.");
        if (Text(part["uploadId"]) is { } id)
        {
            if (part.ContainsKey("base64") || !used.Add(id) || !uploads.TryGetValue(id, out var upload) || !upload.Finished || upload.Size != size || upload.FileName != name || upload.Mime != mime) throw Invalid("Referencia de subida inválida.");
            return new PreparedDocument(upload.Buffer.ToArray(), name, mime);
        }
        var bytes = Decode(part, 512 * 1024);
        if (bytes.Length != size) throw Invalid("La longitud no coincide.");
        return new PreparedDocument(bytes, name, mime);
    }

    private static (JsonObject Fields, List<JsonObject> Files) Form(JsonObject body)
    {
        if (body.Count != 1 || body["parts"] is not JsonArray parts || parts.Count > 128) throw Invalid("Multipart inválido.");
        var fields = new JsonObject(); var files = new List<JsonObject>(); long inline = 0;
        foreach (var node in parts)
        {
            if (node is not JsonObject part) throw Invalid("Parte inválida.");
            var name = Required(part, "name", 100);
            if (part.ContainsKey("value"))
            {
                if (part.Count != 2 || Text(part["value"]) is not { } value || fields.ContainsKey(name)) throw Invalid("Campo duplicado o inválido.");
                inline += Encoding.UTF8.GetByteCount(value); fields[name] = value;
            }
            else
            {
                var allowed = new[] { "name", "fileName", "mime", "size", "base64", "uploadId" };
                if (part.Any(x => !allowed.Contains(x.Key)) || part.ContainsKey("base64") == part.ContainsKey("uploadId")) throw Invalid("Parte de archivo inválida.");
                var size = Integer(part, "size");
                                if (size < 1 || size > MaxFileBytes) throw Invalid("Tamaño de archivo inválido.");
                                if (part.ContainsKey("base64")) inline += size;
                files.Add(part);
            }
        }
        if (inline > 512 * 1024) throw Invalid("Multipart inline supera 512 KiB.");
        return (fields, files);
    }

    private string SafeDocumentPath(string id, bool createDirectory)
    {
        if (!Guid.TryParseExact(id, "D", out var uuid) || uuid.ToString("D") != id) throw Invalid("ID de documento inválido.");
        var fullRoot = Path.GetFullPath(root);
        if (!Directory.Exists(fullRoot)) throw Error("store_unavailable", "La raíz configurada debe existir.");
        for (var info = new DirectoryInfo(fullRoot); info is not null; info = info.Parent)
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0) throw Error("store_unavailable", "Raíz con reparse point no permitida.");
        var directory = Path.Combine(fullRoot, "documents");
        if (File.Exists(directory)) throw Error("store_unavailable", "Directorio de documentos inválido.");
        if (Directory.Exists(directory) && (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw Error("store_unavailable", "Reparse point no permitido.");
        if (createDirectory) Directory.CreateDirectory(directory);
        if (!Directory.Exists(directory)) throw Error("not_found", "No existe el directorio de documentos.");
        var path = Path.Combine(directory, id + ".bin");
        if (File.Exists(path) || Directory.Exists(path))
            if ((File.GetAttributes(path) & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0) throw Error("store_unavailable", "Documento inseguro.");
        return path;
    }

    private void ExpireUploads()
    {
        foreach (var id in uploads.Where(x => DateTimeOffset.UtcNow - x.Value.Touched > TimeSpan.FromMinutes(30)).Select(x => x.Key).ToArray()) { uploads[id].Buffer.Dispose(); uploads.Remove(id); }
    }
    private void Authorize() { if (string.IsNullOrWhiteSpace(identity.Id)) throw Error("unauthorized", "Falta identidad Windows."); }
    private void Staff() { if (identity.Role is not ("admin" or "rrhh" or "it")) throw Error("forbidden", "Operación solo para personal interno."); }
    private JsonObject Metadata(JsonObject result, StoreSnapshot snapshot)
    {
        result["__desktop"] = new JsonObject { ["revision"] = snapshot.Revision, ["readOnly"] = readOnly, ["appliedOperationIds"] = new JsonArray((snapshot.Data["_operations"] as JsonObject ?? new JsonObject()).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray()) }; return result;
    }
    private static string ParsePath(string raw)
    {
        if (raw.Length > 4096 || !raw.StartsWith('/') || raw.StartsWith("//", StringComparison.Ordinal) || raw.Contains('\\') || raw.Contains('#') || raw.Any(char.IsControl)) throw Invalid("Ruta local inválida.");
        var path = raw.Split('?', 2)[0];
        if (Regex.IsMatch(path, @"%(?![0-9a-fA-F]{2})")) throw Invalid("Escape inválido.");
        var segments = path.Split('/').Skip(1).ToList();
        if (segments.LastOrDefault() == "") segments.RemoveAt(segments.Count - 1);
        segments = segments.Select(Uri.UnescapeDataString).ToList();
        if (segments.Any(x => x.Length == 0 || x is "." or ".." || x.Any(c => c is '/' or '\\' or '%' or '?' or '#' or ':' || char.IsControl(c)))) throw Invalid("Traversal o separadores no permitidos.");
        if (segments.FirstOrDefault() == "api") segments.RemoveAt(0);
        return "/" + string.Join('/', segments);
    }
    private static string FileName(string name)
    {
        if (name is "." or ".." || name.EndsWith('.') || name.EndsWith(' ') || name.Any(c => char.IsControl(c) || "<>:\"/\\|?*".Contains(c)) || name.Length > 240) throw Invalid("Nombre de archivo inseguro.");
        var stem = name.Split('.')[0].ToUpperInvariant();
        if (Regex.IsMatch(stem, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$")) throw Invalid("Nombre reservado."); return name;
    }
    private static string Mime(string name, string mime)
    {
        var expected = Path.GetExtension(name).ToLowerInvariant() switch { ".pdf" => "application/pdf", ".doc" => "application/msword", ".docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document", _ => "" };
        if (expected.Length == 0 || mime != expected) throw Invalid("Solo PDF/DOC/DOCX con MIME correspondiente."); return mime;
    }
    private static byte[] Decode(JsonObject payload, int max)
    {
        var text = Required(payload, "base64", ((max + 2) / 3) * 4);
        byte[] bytes; try { bytes = Convert.FromBase64String(text); } catch (FormatException) { throw Invalid("Base64 inválido."); }
        if (bytes.Length == 0 || bytes.Length > max || Convert.ToBase64String(bytes) != text) throw Invalid("Longitud o base64 no canónico."); return bytes;
    }
    private static void VerifyHash(ReadOnlySpan<byte> bytes, string expected)
    {
        if (expected.Length != 64 || !expected.All(Uri.IsHexDigit) || !string.Equals(Convert.ToHexString(SHA256.HashData(bytes)), expected, StringComparison.OrdinalIgnoreCase)) throw Invalid("SHA-256 no coincide.");
    }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));
    private static JsonNode Canonical(JsonNode node) => node switch { JsonObject obj => new JsonObject(obj.OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => new KeyValuePair<string, JsonNode?>(x.Key, x.Value is null ? null : Canonical(x.Value)))), JsonArray arr => new JsonArray(arr.Select(x => x is null ? null : Canonical(x)).ToArray()), _ => node.DeepClone() };
    private static void ValidateCollections(JsonObject data)
    {
        foreach (var key in new[] { "documents", "profile_imports", "candidate_profiles", "candidates", "applications", "listings", "audit_log" })
            if (data.ContainsKey(key) && (data[key] is not JsonArray array || array.Any(x => x is not JsonObject))) throw Error("store_unavailable", "Colección inválida: " + key);
        foreach (var key in new[] { "_operations", "_documentResults" }) if (data.ContainsKey(key) && data[key] is not JsonObject) throw Error("store_unavailable", "Recibos inválidos.");
                if (data["_operations"] is JsonObject receipts && receipts.Any(x => !Guid.TryParseExact(x.Key, "D", out var uuid) || uuid.ToString("D") != x.Key || Text(x.Value) is not { Length: 64 } hash || !hash.All(Uri.IsHexDigit))) throw Error("store_unavailable", "Recibos de operaciones inválidos.");
    }
    private static void MergeCandidates(JsonObject data)
    {
        foreach (var alias in Rows(data, "candidate_profiles").OfType<JsonObject>().ToArray())
        {
            var existing = Rows(data, "candidates").OfType<JsonObject>().FirstOrDefault(x => Text(x["id"]) == Text(alias["id"]));
            if (existing is null) Rows(data, "candidates").Add(alias.DeepClone());
            else foreach (var field in alias) if (!existing.ContainsKey(field.Key)) existing[field.Key] = field.Value?.DeepClone();
        }
    }
    private static JsonObject Candidate(JsonObject data, string id) => Rows(data, "candidates").Concat(Rows(data, "candidate_profiles")).OfType<JsonObject>().FirstOrDefault(x => Text(x["id"]) == id) ?? throw Error("not_found", "Candidato inexistente.");
    private static string CandidateId(JsonObject row) => Text(row["candidateUserId"]) ?? Text(row["candidateId"]) ?? throw Invalid("Referencia de candidato ausente.");
    private static JsonArray Rows(JsonObject data, string name) { data[name] ??= new JsonArray(); return data[name] as JsonArray ?? throw Error("store_unavailable", "Colección inválida."); }
    private static JsonObject Object(JsonObject data, string name) { data[name] ??= new JsonObject(); return data[name] as JsonObject ?? throw Error("store_unavailable", "Objeto inválido."); }
    private static JsonObject Find(JsonObject data, string name, string id) => Rows(data, name).OfType<JsonObject>().FirstOrDefault(x => Text(x["id"]) == id) ?? throw Error("not_found", "Registro inexistente: " + name);
    private static JsonObject NewRecord() => new() { ["id"] = Guid.NewGuid().ToString("D"), ["created"] = Now(), ["updated"] = Now() };
    private static string Now() => DateTimeOffset.UtcNow.ToString("O");
    private static JsonObject Items(IEnumerable<JsonObject> rows) => new() { ["ok"] = true, ["items"] = new JsonArray(rows.Select(x => x.DeepClone()).ToArray()) };
    private static string? Text(JsonNode? node) => node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
    private static string Required(JsonObject obj, string key, int max) { var text = Text(obj[key]); if (string.IsNullOrWhiteSpace(text) || text.Length > max) throw Invalid("Campo inválido: " + key); return text; }
    private static long Integer(JsonObject obj, string key)
        {
            if (obj[key] is JsonValue value)
            {
                if (value.TryGetValue<long>(out var number)) return number;
                if (value.TryGetValue<int>(out var integer)) return integer;
            }
            throw Invalid("Entero obligatorio: " + key);
        }
    private static LegacyApiException Invalid(string message) => Error("invalid_request", message);
    private static LegacyApiException Error(string code, string message) => new(code, message);
}
