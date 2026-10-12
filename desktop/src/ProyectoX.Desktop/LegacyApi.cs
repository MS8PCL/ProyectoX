using System.Globalization;
using System.IO;
using System.Net.Mail;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ProyectoX.Storage;

namespace ProyectoX.Desktop;

public sealed record DesktopIdentity(string Id, string Email, string Role, string DisplayName);

public sealed class LegacyApiException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

/// <summary>Local JSON compatibility API. Windows supplies identity; the host's default rrhh role is an operational role, not strong application authentication. Filesystem ACLs remain the security boundary.</summary>
public sealed class LegacyApi(SharedStore store, bool readOnly, DesktopIdentity identity)
{
    private static readonly string[] Stages = ["nuevo", "revisar", "entrevista", "oferta", "descartado", "hired"];
    private static readonly HashSet<string> StateFields = ["v", "theme", "role", "profile", "favorites", "lists", "listMembers", "candidateFavorites", "homeMode"];

    // DocumentApi must receive the payload first via SupportsPath(path). It owns:
    // /profile/imports[/{file,link}], /company/candidates/:id/cv,
    // /interno/listings/:id/import_candidate, /interno/{applications,listings}/:id/export.zip,
    // /interno/applications/:id/documents[/:importId]. GET documents => {ok,items:[{id,docType,file,created}]}.
    // candidates is the writable canonical collection; candidate_profiles is a legacy alias.
    // candidateUserId/candidateId always reference the PROFILE RECORD id, never its userId.
    // Imported alias records are merged by id on writes, preserving unknown fields and primary IDs.
    public async Task<JsonObject> HandleAsync(JsonObject payload, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(identity.Id)) throw Error("unauthorized", "El host debe proporcionar una identidad Windows.");
        var (path, query) = ParsePath(Text(payload["path"]) ?? throw Invalid("path es obligatorio."));
        var method = (Text(payload["method"]) ?? "GET").ToUpperInvariant();
        if (method is not ("GET" or "POST" or "PUT" or "PATCH" or "DELETE")) throw Invalid("Método no permitido.");
        JsonObject body;
        try
        {
            body = payload["body"] switch
            {
                null => new JsonObject(),
                JsonObject obj => (JsonObject)obj.DeepClone(),
                JsonValue value when value.TryGetValue<string>(out var json) => JsonNode.Parse(json) as JsonObject ?? throw Invalid("body debe ser un objeto JSON."),
                _ => throw Invalid("body debe ser un objeto JSON.")
            };
        }
        catch (JsonException) { throw Invalid("body contiene JSON inválido."); }
        if ((path.StartsWith("/auth/", StringComparison.Ordinal) && !(method == "GET" && path == "/auth/windows")) || path.StartsWith("/apply/", StringComparison.Ordinal) ||
            path.StartsWith("/public/", StringComparison.Ordinal) || path.StartsWith("/mock/", StringComparison.Ordinal) ||
            path.Contains("apply_tokens", StringComparison.Ordinal) || path.EndsWith("/apply", StringComparison.Ordinal) || path.StartsWith("/me/favorites", StringComparison.Ordinal) || path == "/me/applications")
            throw Error("unsupported_local", "El portal público, las contraseñas y los mocks externos no están disponibles en modo local.");
        if (IsDocumentPath(path)) throw Error("document_dispatch_required", "Esta ruta debe ser atendida primero por DocumentApi.SupportsPath(path).");

        if (method == "GET")
        {
            var snapshot = await store.ReadAsync(token);
            var data = Normalize(snapshot.Data);
            SeedCatalogs(data);
            return WithMetadata(Dispatch(data, path, query, method, body, "", false), snapshot.Revision, data);
        }
        if (readOnly) throw Error("read_only", "El almacenamiento está en modo solo lectura.");
        if (path is not ("/profile" or "/state" or "/settings") && !path.StartsWith("/notifications/", StringComparison.Ordinal)) RequireStaff();
        var operationText = Text(payload["operationId"]);
        if (!Guid.TryParseExact(operationText, "D", out var uuid)) throw Invalid("operationId debe ser un UUID.");
        var operationId = uuid.ToString("D");
        if (payload["expectedRevision"] is not JsonValue rv || !rv.TryGetValue<long>(out var revision) || revision < 0)
            throw Invalid("expectedRevision debe ser un entero no negativo.");
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(new JsonObject
        {
            ["method"] = method, ["path"] = path, ["query"] = query.DeepClone(), ["body"] = body.DeepClone(),
            ["identityId"] = identity.Id, ["identityRole"] = identity.Role
        })!.ToJsonString())));
        // Resolve uncertain retries BEFORE checking the stale expectedRevision.
        var before = await store.ReadAsync(token);
        var next = Normalize(before.Data);
        if (HasReceipt(next, operationId, fingerprint))
            return WithMetadata(ReplayResult(next, path, method, body, operationId), before.Revision, next);
        // /state and /settings only replace this identity's own preference record. Requiring the
        // global revision made every theme or language change fail whenever anyone else had saved
        // anything; only a newer save of this same record (another window of this user) conflicts.
        var preferences = method == "PUT" && path is "/state" or "/settings" ? "desktop_user_" + path[1..] : null;
        if (preferences is not null && before.Revision != revision)
        {
            if (DesktopRecord(next, preferences)?["savedRevision"] is JsonValue saved && saved.TryGetValue<long>(out var savedAt) && savedAt > revision)
                throw Error("conflict", "Los datos han cambiado. Recargue antes de guardar.");
            revision = before.Revision;
        }
        MergeCandidateAliases(next);
        SeedCatalogs(next);
        var rowsBefore = EntityRevisions.Rows(next);
        var result = Dispatch(next, path, query, method, body, operationId, false);
        SynchronizeCandidateAliases(next);
        var touched = EntityRevisions.Touched(rowsBefore, next);
        if (before.Revision != revision)
        {
            // A stale edit only touching records nobody changed since the caller's revision cannot
            // lose anyone's update, so it applies; anything else still needs the latest revision.
            if (!EntityRevisions.UnchangedSince(next, touched, revision)) throw Error("conflict", "Los datos han cambiado. Recargue antes de guardar.");
            revision = before.Revision;
        }
        EntityRevisions.Stamp(next, touched, revision + 1);
        if (preferences is not null && DesktopRecord(next, preferences) is { } record) record["savedRevision"] = revision + 1;
        Array(next, "audit_log").Add(new JsonObject
        {
            ["id"] = NewId(operationId, "audit"), ["at"] = Now(), ["action"] = method + " " + AuditRoute(path),
            ["actorType"] = "windows", ["actorUserId"] = ActorHash(identity.Id), ["entityType"] = AuditRoute(path).Split('/').ElementAtOrDefault(1),
            ["timestamp"] = Now(), ["user"] = identity.DisplayName,
            ["entity"] = AuditRoute(path), ["details"] = method + " " + AuditRoute(path), ["correlationId"] = operationId
        });
        ((JsonObject)next["_operations"]!)[operationId] = fingerprint;
        Receipts.Trim(next);
        try
        {
            var committed = await store.CommitAsync(revision, next, identity.Id, token);
            return WithMetadata(result, committed.Revision, committed.Data);
        }
        catch (StoreConflictException)
        {
            var current = await store.ReadAsync(token);
            var data = Normalize(current.Data);
            if (HasReceipt(data, operationId, fingerprint))
                return WithMetadata(ReplayResult(data, path, method, body, operationId), current.Revision, data);
            throw Error("conflict", "Los datos han cambiado durante la escritura.");
        }
    }

    private JsonObject Dispatch(JsonObject data, string path, JsonObject query, string method, JsonObject body, string op, bool replay)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (method == "GET")
        {
            switch (path)
            {
                case "/health": return Ok();
                case "/auth/windows":
                case "/me": return new JsonObject { ["user"] = new JsonObject { ["id"] = identity.Id, ["email"] = identity.Email, ["role"] = identity.Role, ["displayName"] = identity.DisplayName, ["authMode"] = "windows" } };
                case "/profile": return ProfileResponse(data, false);
                case "/onboarding/status": return ProfileResponse(data, true);
                case "/state": return new JsonObject { ["state"] = HydrateState(data) };
                                case "/notifications": return Items(UserNotifications(data).OrderByDescending(Created).Select(NotificationView));
                case "/settings": return new JsonObject { ["ok"] = true, ["settings"] = UserRecord(data, "user_settings")?["settings"]?.DeepClone() ?? new JsonObject() };
                case "/listings":
                case "/listings/feed": return Items(Rows(data, "listings").OrderByDescending(Created));
                case "/candidates": RequireStaff(); return Items(Candidates(data));
                case "/applications": RequireStaff(); return Items(Rows(data, "applications").Select(ApplicationView));
                case "/metrics":
                case "/dashboard/metrics": RequireStaff(); return Metrics(data);
                case "/departments":
                case "/interno/departments": return Catalog(data, "departments", query);
                case "/job_titles":
                case "/interno/job_titles": return Catalog(data, "job_titles", query);
                case "/enterprise/catalog/items": RequireStaff(); return Items(Rows(data, "catalog_items").Where(x => Match(x, "type", query)).OrderBy(x => Text(x["key"]), StringComparer.Ordinal));
                case "/enterprise/rbac/rules": RequireStaff(); return Items(Rows(data, "rbac_rules").OrderBy(x => Number(x["priority"])).ThenBy(Created));
                case "/enterprise/outbox": RequireStaff(); return Items(Rows(data, "integration_outbox").Where(x => Match(x, "status", query)).OrderByDescending(x => Text(x["created_at"])));
                case "/enterprise/hire-profiles": RequireStaff(); return Items(Rows(data, "hire_profiles"));
                case "/enterprise/audit-log": RequireStaff(); return Audit(data, query);
            }
            if (parts is ["listings", var listingId]) return Item(Find(data, "listings", listingId));
            if (parts is ["company", "listings", var offerId, "applications"])
            {
                RequireStaff(); Find(data, "listings", offerId);
                return Items(Rows(data, "applications").Where(x => Text(x["listingId"]) == offerId).Select(ApplicationView));
            }
            if (parts is ["company", "candidates", _, "profile"] or ["candidates", _, "profile"])
            {
                RequireStaff(); return new JsonObject { ["ok"] = true, ["profile"] = Candidate(data, parts[^2]).DeepClone() };
            }
            if (parts is ["outbox", var outboxId, "export"])
            {
                RequireStaff(); var row = Find(data, "integration_outbox", outboxId);
                return new JsonObject { ["ok"] = true, ["export"] = row["export_blob"]?.DeepClone(), ["payload"] = row["payload"]?.DeepClone(), ["outbox"] = row.DeepClone() };
            }
            throw Unsupported(method, path);
        }
        if (path == "/state" && method == "PUT")
        {
            var state = body["state"] as JsonObject ?? throw Invalid("state debe ser un objeto.");
            // Vue sends cached business collections with UI state. Never apply those to shared data.
            var preferences = new JsonObject();
            foreach (var field in state)
                if (StateFields.Contains(field.Key)) preferences[field.Key] = field.Value?.DeepClone();
            foreach (var field in state)
                if (!StateFields.Contains(field.Key) && field.Key is not ("listings" or "applications" or "candidates" or "pipeline"))
                    throw Invalid("state contiene un campo no permitido.");
            if (!replay) SaveUserRecord(data, "user_state", "state", preferences, op);
            return Ok();
        }
        if (path == "/settings" && method == "PUT")
        {
            var settings = body["settings"] as JsonObject ?? throw Invalid("settings debe ser un objeto.");
            if (!replay) SaveUserRecord(data, "user_settings", "settings", settings, op);
            return new JsonObject { ["ok"] = true, ["settings"] = UserRecord(data, "user_settings")?["settings"]?.DeepClone() };
        }
        if (path == "/profile" && method == "PUT")
        {
            var company = identity.Role == "company";
            var fields = company ? new[] { "companyName", "sector", "location" } : new[] { "fullName", "title", "location", "public", "skills", "about" };
            Only(body, fields);
            foreach (var field in fields.Take(3)) Required(body, field, 120, 2);
            OptionalText(body, "about", 2000); Strings(body, "skills"); Boolean(body, "public");
            if (!replay)
            {
                var row = DesktopProfile(data) ?? Add(data, "desktop_profiles", op, "profile");
                Patch(row, body); row["desktopIdentityId"] = identity.Id;
                row["profileKind"] = company ? "company" : "candidate"; Touch(row);
            }
            return ProfileResponse(data, true);
        }
        if (parts is ["notifications", var notificationId] && method == "PATCH")
        {
            Only(body, ["read"]); Boolean(body, "read");
            if (!body.ContainsKey("read")) throw Invalid("read es obligatorio.");
            var row = UserNotifications(data).FirstOrDefault(x => Text(x["id"]) == notificationId)
                ?? throw Error("not_found", "La notificación no existe para esta identidad.");
            row["read"] = body["read"]!.DeepClone(); Touch(row); return Item(NotificationView(row));
        }
        if (path == "/notifications/mark-all-read" && method == "POST")
        {
            Only(body, []);
            foreach (var row in UserNotifications(data)) { row["read"] = true; Touch(row); }
            return Items(UserNotifications(data).OrderByDescending(Created).Select(NotificationView));
        }
        RequireStaff();
        if (path == "/listings" && method == "POST")
        {
            ValidateListing(body, true);
            var row = replay ? Find(data, "listings", NewId(op, "listing")) : Add(data, "listings", op, "listing");
            if (!replay) { Patch(row, body); row["ownerUserId"] = identity.Id; Defaults(row, "pay", "desc"); row["tags"] ??= new JsonArray(); }
            return Item(row);
        }
        if (parts is ["listings", var id] && method is "PATCH" or "PUT" or "DELETE")
        {
            if (method == "DELETE")
            {
                if (!replay)
                {
                    var row = Find(data, "listings", id);
                    if (Rows(data, "applications").Any(a => Text(a["listingId"]) == id)) throw Error("reference_conflict", "La oferta tiene candidaturas asociadas.");
                    Array(data, "listings").Remove(row);
                }
                return Ok();
            }
            ValidateListing(body, method == "PUT"); var existing = Find(data, "listings", id);
            if (!replay) { Patch(existing, body); Touch(existing); } return Item(existing);
        }
        if (path == "/candidates" && method == "POST")
        {
            ValidateCandidate(body, true);
            var row = replay ? Candidate(data, NewId(op, "candidate")) : Add(data, "candidates", op, "candidate");
            if (!replay) { UniqueEmail(data, body, Text(row["id"])!); PatchCandidate(row, body); }
            return new JsonObject { ["ok"] = true, ["item"] = row.DeepClone(), ["profile"] = row.DeepClone() };
        }
        if (parts is ["candidates", var cid] && method is "PATCH" or "PUT" or "DELETE")
        {
            if (method == "DELETE")
            {
                if (!replay)
                {
                    var row = Candidate(data, cid);
                    if (Rows(data, "applications").Any(a => CandidateReference(a) == cid) || Rows(data, "hire_profiles").Any(a => CandidateReference(a) == cid))
                        throw Error("reference_conflict", "El candidato tiene candidaturas o altas asociadas.");
                    Array(data, "candidates").Remove(row);
                }
                return Ok();
            }
            ValidateCandidate(body, method == "PUT"); var existing = Candidate(data, cid);
            if (!replay) { UniqueEmail(data, body, cid); PatchCandidate(existing, body); Touch(existing); } return Item(existing);
        }
        if (path == "/applications" && method == "POST")
        {
            Only(body, ["candidateUserId", "candidateId", "listingId", "stage", "notes", "birthDate", "coverLetter"]);
            var candidateId = Text(body["candidateUserId"]) ?? Required(body, "candidateId", 128);
            if (body.ContainsKey("candidateId") && Required(body, "candidateId", 128) != candidateId)
                throw Invalid("candidateId y candidateUserId deben referenciar el mismo perfil.");
            var listingId = Required(body, "listingId", 128);
            Candidate(data, candidateId); var listing = Find(data, "listings", listingId);
            ValidateStage(body); OptionalText(body, "notes", 2000); OptionalText(body, "coverLetter", 20000);
            var row = Rows(data, "applications").FirstOrDefault(x => CandidateReference(x) == candidateId && Text(x["listingId"]) == listingId);
            var already = row is not null && Text(row["id"]) != NewId(op, "application");
            if (row is null)
            {
                if (replay) throw Error("not_found", "La candidatura aplicada ya no existe.");
                row = Add(data, "applications", op, "application"); Patch(row, body);
                row["candidateId"] = candidateId; row["candidateUserId"] = candidateId;
                row["companyUserId"] = listing["ownerUserId"]?.DeepClone(); row["stage"] ??= "nuevo"; row["notes"] ??= "";
            }
            return new JsonObject { ["ok"] = true, ["already"] = already, ["item"] = ApplicationView(row) };
        }
        if (parts is ["company", "applications", _] or ["applications", _] && method is "PATCH" or "DELETE")
        {
            var aid = parts[^1];
            if (method == "DELETE")
            {
                if (!replay)
                {
                    var row = Find(data, "applications", aid);
                    if (Rows(data, "hire_profiles").Any(x => Text(x["applicationId"]) == aid)) throw Error("reference_conflict", "La candidatura tiene un alta asociada.");
                    // Like the web backend, the application's own imports go with it. Their document
                    // bytes stay on disk: published files are never deleted (see DocumentApi).
                    var imports = Array(data, "profile_imports");
                    foreach (var item in imports.OfType<JsonObject>().Where(x => Text(x["applicationId"]) == aid).ToArray()) imports.Remove(item);
                    Array(data, "applications").Remove(row);
                }
                return Ok();
            }
            Only(body, ["stage", "notes"]); ValidateStage(body); OptionalText(body, "notes", 2000);
            if (body.Count == 0) throw Invalid("Debe indicar stage o notes.");
            var existing = Find(data, "applications", aid);
            if (!replay)
                        {
                            var stageChanged = Text(body["stage"]) is { } stage && stage != LegacyStage(Text(existing["stage"]));
                            Patch(existing, body); Touch(existing);
                            if (stageChanged)
                            {
                                existing["stageChangedAt"] = existing["updated"]!.DeepClone();
                                if (Text(body["stage"]) == "hired") existing["hiredAt"] = existing["updated"]!.DeepClone();
                            }
                        }
            return Item(ApplicationView(existing));
        }
        if (method == "POST" && path is "/interno/hire/enqueue_it_request" or "/enterprise/hire-profiles")
            return Hire(data, body, op, replay, path.StartsWith("/interno/", StringComparison.Ordinal));
        if (parts is ["outbox", var oid, "mark_exported"] && method == "POST")
            return UpdateOutbox(data, oid, "exported_manually", replay);
        if (parts is ["enterprise", "outbox", var outId] && method == "PATCH")
        {
            Only(body, ["status"]); return UpdateOutbox(data, outId, Required(body, "status", 40), replay);
        }
        if (parts is ["enterprise", "outbox", var completeId, "complete"] && method == "POST")
            return UpdateOutbox(data, completeId, "completed", replay);
        throw Unsupported(method, path);
    }

    private JsonObject Hire(JsonObject data, JsonObject body, string op, bool replay, bool moveStage)
    {
        var applicationId = Text(body["applicationId"]);
        var standalone = string.IsNullOrWhiteSpace(applicationId);
        if (moveStage && standalone) throw Invalid("applicationId es obligatorio para confirmar una contratación.");
        Only(body, standalone
            ? ["firstName", "lastName", "email", "departmentId", "jobTitleId", "costCenter", "startDate"]
            : ["applicationId", "startDate", "departmentId", "jobTitleId", "costCenter", "managerEmail", "managerName", "accessProfileId", "hardwareProfile", "notesIT"]);
        var dept = Find(data, "departments", Required(body, "departmentId", 128));
        var job = Find(data, "job_titles", Required(body, "jobTitleId", 128));
        if (dept["isActive"]?.ToJsonString() == "false" || job["isActive"]?.ToJsonString() == "false") throw Invalid("El catálogo seleccionado está inactivo.");
        var date = Required(body, "startDate", 80);
        if (!DateTimeOffset.TryParse(date, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var start)) throw Invalid("startDate no es una fecha válida.");
        Required(body, "costCenter", 80);
        JsonObject? app = null;
        JsonObject candidate;
        if (standalone)
        {
            Required(body, "firstName", 120); Required(body, "lastName", 120); Email(body, "email");
            candidate = Candidates(data).FirstOrDefault(x => string.Equals(Text(x["email"]), Text(body["email"]), StringComparison.OrdinalIgnoreCase))
                ?? (replay ? Candidate(data, NewId(op, "candidate")) : Add(data, "candidates", op, "candidate"));
            if (!replay)
                        {
                            PatchCandidate(candidate, new JsonObject { ["firstName"] = body["firstName"]?.DeepClone(), ["lastName"] = body["lastName"]?.DeepClone(), ["email"] = body["email"]?.DeepClone() });
                            Touch(candidate);
                        }
        }
        else
        {
            app = Find(data, "applications", applicationId!); candidate = Candidate(data, CandidateReference(app)); Find(data, "listings", Required(app, "listingId", 128));
            Email(body, "managerEmail"); Required(body, "accessProfileId", 80);
            OptionalText(body, "managerName", 120); OptionalText(body, "hardwareProfile", 200); OptionalText(body, "notesIT", 2000);
        }
        var profile = standalone ? Rows(data, "hire_profiles").FirstOrDefault(x => Text(x["id"]) == NewId(op, "hire"))
            : Rows(data, "hire_profiles").FirstOrDefault(x => Text(x["applicationId"]) == applicationId);
        if (profile is null) profile = replay ? Find(data, "hire_profiles", NewId(op, "hire")) : Add(data, "hire_profiles", op, "hire");
        var profileId = Text(profile["id"])!;
        var entityId = standalone ? "hire_" + profileId : "hire_app_" + applicationId;
        var idem = "hire/" + entityId + "::alta_it";
        var outbox = Rows(data, "integration_outbox").FirstOrDefault(x => Text(x["idempotency_key"]) == idem);
        var created = outbox is null || Text(outbox["id"]) == NewId(op, "outbox");
        if (!replay)
        {
            var proposed = (JsonObject)profile.DeepClone();
            Patch(proposed, body); proposed["startDate"] = start.ToUniversalTime().ToString("O");
            proposed["candidateUserId"] = Text(candidate["id"]); proposed["candidateId"] = Text(candidate["id"]);
            proposed["companyUserId"] = app?["companyUserId"]?.DeepClone() ?? JsonValue.Create(identity.Id);
            if (outbox is not null && !JsonNode.DeepEquals(outbox["export_blob"]?["hire_profile"], proposed))
                throw Error("reference_conflict", "Ya existe una solicitud IT para esta contratación. No se puede modificar su snapshot silenciosamente.");
            if (outbox is null) { Patch(profile, proposed); Touch(profile); }
            if (outbox is null)
            {
                outbox = Add(data, "integration_outbox", op, "outbox");
                Patch(outbox, new JsonObject
                {
                    ["kind"] = "alta_it", ["entity_type"] = "hire", ["entity_id"] = entityId,
                    ["pinned_workflow_key"] = "portal_mvp", ["pinned_workflow_version"] = 2,
                    ["idempotency_key"] = idem, ["status"] = "pending", ["attempts"] = 0, ["created_at"] = Now(), ["correlation_id"] = op,
                    ["payload"] = new JsonObject { ["mode"] = "manual_export", ["entityType"] = "hire", ["entityId"] = entityId, ["applicationId"] = applicationId, ["hireProfileId"] = profileId, ["departmentId"] = Text(dept["id"]), ["jobTitleId"] = Text(job["id"]) },
                    ["export_blob"] = new JsonObject
                    {
                        ["instructions"] = new JsonArray("Alta IT: exportación manual; no se ha contactado con OTRS."),
                        ["entity"] = new JsonObject { ["entityType"] = "hire", ["entityId"] = entityId },
                        ["source"] = new JsonObject { ["applicationId"] = applicationId, ["hireProfileId"] = profileId },
                        ["hire_profile"] = profile.DeepClone(), ["department"] = dept.DeepClone(), ["jobTitle"] = job.DeepClone(),
                        ["candidate"] = candidate.DeepClone(), ["listing"] = app is null ? null : Find(data, "listings", Text(app["listingId"])!).DeepClone(), ["snapshotAt"] = Now()
                    }
                });
            }

            if (moveStage && app is not null)
                        {
                            var stageChanged = LegacyStage(Text(app["stage"])) != "hired";
                            app["stage"] = "hired"; app["hiredAt"] ??= Now(); Touch(app);
                            if (stageChanged) app["stageChangedAt"] = app["updated"]!.DeepClone();
                        }
        }
        var response = new JsonObject { ["ok"] = true, ["created"] = created, ["hireProfileId"] = profileId, ["outbox"] = outbox?.DeepClone() };
        if (moveStage) response["movedStage"] = "hired";
        else response["hire_profile"] = profile.DeepClone();
        return response;
    }

    // A receipt acknowledges a past commit, even if its entities were subsequently changed/deleted.
    // Return current projections, not a persisted response/body or a second mutation.
    private JsonObject ReplayResult(JsonObject data, string path, string method, JsonObject body, string op)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (method == "DELETE" || path == "/state") return Ok();
        if (path == "/notifications/mark-all-read") return Items(UserNotifications(data).OrderByDescending(Created).Select(NotificationView));
        if (parts is ["notifications", var notificationId])
        {
            var row = UserNotifications(data).FirstOrDefault(x => Text(x["id"]) == notificationId);
            return new JsonObject { ["ok"] = true, ["item"] = row is null ? null : NotificationView(row) };
        }
        if (path == "/profile") return ProfileResponse(data, true);
        if (path == "/settings") return new JsonObject { ["ok"] = true, ["settings"] = UserRecord(data, "user_settings")?["settings"]?.DeepClone() };
        if (path is "/interno/hire/enqueue_it_request" or "/enterprise/hire-profiles")
        {
            var profile = Rows(data, "hire_profiles").FirstOrDefault(x => Text(x["id"]) == NewId(op, "hire"))
                ?? Rows(data, "hire_profiles").FirstOrDefault(x => Text(body["applicationId"]) is { Length: > 0 } id && Text(x["applicationId"]) == id);
            var hireEntityId = Text(body["applicationId"]) is { Length: > 0 } app ? "hire_app_" + app : "hire_" + Text(profile?["id"]);
            var outbox = Rows(data, "integration_outbox").FirstOrDefault(x => Text(x["idempotency_key"]) == "hire/" + hireEntityId + "::alta_it");
            var response = new JsonObject { ["ok"] = true, ["created"] = Text(outbox?["id"]) == NewId(op, "outbox"), ["hireProfileId"] = Text(profile?["id"]), ["outbox"] = outbox?.DeepClone() };
            if (path.StartsWith("/interno/", StringComparison.Ordinal)) response["movedStage"] = "hired";
            else response["hire_profile"] = profile?.DeepClone();
            return response;
        }
        if (parts is ["outbox", _, "mark_exported"] or ["enterprise", "outbox", _] or ["enterprise", "outbox", _, "complete"])
        {
            var id = parts[0] == "outbox" ? parts[1] : parts[2];
            return new JsonObject { ["ok"] = true, ["outbox"] = Rows(data, "integration_outbox").FirstOrDefault(x => Text(x["id"]) == id)?.DeepClone() };
        }
        var collection = parts[0] == "company" ? "applications" : parts[0];
        var kind = collection switch { "listings" => "listing", "candidates" => "candidate", _ => "application" };
        var entityId = method == "POST" ? NewId(op, kind) : parts[^1];
        JsonObject? entity = (collection == "candidates" ? Candidates(data) : Rows(data, collection)).FirstOrDefault(x => Text(x["id"]) == entityId);
        if (collection == "applications" && method == "POST" && entity is null)
            entity = Rows(data, collection).FirstOrDefault(x => CandidateReference(x) == (Text(body["candidateUserId"]) ?? Text(body["candidateId"])) && Text(x["listingId"]) == Text(body["listingId"]));
        var result = new JsonObject { ["ok"] = true, ["item"] = entity is null ? null : collection == "applications" ? ApplicationView(entity) : entity.DeepClone() };
        if (collection == "applications" && method == "POST") result["already"] = entity is not null && Text(entity["id"]) != NewId(op, "application");
        if (collection == "candidates" && method == "POST") result["profile"] = entity?.DeepClone();
        return result;
    }

    private JsonObject ProfileResponse(JsonObject data, bool complete)
    {
        var profile = MyProfile(data);
        var response = new JsonObject { ["ok"] = true, ["role"] = identity.Role, ["profile"] = profile?.DeepClone() };
        if (complete) response["complete"] = profile is not null && (identity.Role == "company" ? new[] { "companyName", "sector", "location" } : new[] { "fullName", "title", "location" }).All(k => !string.IsNullOrWhiteSpace(Text(profile[k])));
        return response;
    }

    // Optional explicit migration mapping: desktop_identity_mappings rows contain
    // {desktopIdentityId: Windows SID, legacyUserId: PocketBase user id}. Never infer by email/name.
    // Writes always use independent desktop_* records; imported legacy records remain untouched.
    private string? MappedLegacyUser(JsonObject data)
    {
        var mappings = Rows(data, "desktop_identity_mappings").Where(x => Text(x["desktopIdentityId"]) == identity.Id).ToArray();
        if (mappings.Length > 1 || (mappings.Length == 1 && string.IsNullOrWhiteSpace(Text(mappings[0]["legacyUserId"]))))
            throw Error("store_unavailable", "El mapping explícito de identidad no es válido.");
        return mappings.Length == 1 ? Text(mappings[0]["legacyUserId"]) : null;
    }
    private JsonObject? DesktopRecord(JsonObject data, string collection) => Rows(data, collection).FirstOrDefault(x => Text(x["desktopIdentityId"]) == identity.Id);
    private JsonObject? DesktopProfile(JsonObject data) => Rows(data, "desktop_profiles").FirstOrDefault(x => Text(x["desktopIdentityId"]) == identity.Id && Text(x["profileKind"]) == (identity.Role == "company" ? "company" : "candidate"));
    private JsonObject? MyProfile(JsonObject data) => DesktopProfile(data) ?? (MappedLegacyUser(data) is { } user
        ? (identity.Role == "company" ? Rows(data, "company_profiles") : Candidates(data)).FirstOrDefault(x => Text(x["userId"]) == user) : null);
    private JsonObject? UserRecord(JsonObject data, string collection) => DesktopRecord(data, "desktop_" + collection)
        ?? (MappedLegacyUser(data) is { } user ? Rows(data, collection).FirstOrDefault(x => Text(x["userId"]) == user) : null);
    private void SaveUserRecord(JsonObject data, string collection, string field, JsonObject value, string op)
    {
        var row = DesktopRecord(data, "desktop_" + collection) ?? Add(data, "desktop_" + collection, op, collection);
        row["desktopIdentityId"] = identity.Id; row[field] = value.DeepClone(); Touch(row);
    }
    private IEnumerable<JsonObject> UserNotifications(JsonObject data)
    {
        var mapped = MappedLegacyUser(data);
        return Rows(data, "notifications").Where(x => Text(x["desktopIdentityId"]) is { } owner
            ? owner == identity.Id
            : Text(x["userId"]) is { } user && (user == identity.Id || (mapped is not null && user == mapped)));
    }

    private JsonObject HydrateState(JsonObject data)
    {
        var state = new JsonObject { ["v"] = 3, ["theme"] = "terminal", ["role"] = identity.Role is "admin" or "rrhh" or "it" or "company" ? "empresa" : "candidato", ["homeMode"] = "workflow" };
        var source = UserRecord(data, "user_state")?["state"];
        if (source is not null && source is not JsonObject) throw Error("store_unavailable", "Las preferencias del usuario no son un objeto.");
        if (source is JsonObject preferences)
            foreach (var field in preferences) if (StateFields.Contains(field.Key)) state[field.Key] = field.Value?.DeepClone();
        state["v"] = 3;
        state["profile"] ??= new JsonObject();
        if (state["profile"] is not JsonObject profiles) throw Error("store_unavailable", "El perfil de preferencias no es un objeto.");
        profiles["candidato"] ??= new JsonObject(); profiles["empresa"] ??= new JsonObject();
        if (MyProfile(data) is { } own)
        {
            var company = identity.Role == "company";
            profiles[company ? "empresa" : "candidato"] = new JsonObject
            {
                ["name"] = Text(own[company ? "companyName" : "fullName"]) ?? Text(own["name"]) ?? "",
                ["title"] = Text(own[company ? "sector" : "title"]) ?? "", ["location"] = Text(own["location"]) ?? "",
                ["skills"] = own["skills"]?.DeepClone() ?? new JsonArray(), ["about"] = Text(own["about"]) ?? "", ["public"] = own["public"]?.DeepClone() ?? JsonValue.Create(true)
            };
        }
        var staff = identity.Role is "admin" or "rrhh" or "it";
        var listings = Rows(data, "listings").OrderByDescending(Created).Select(UiListing).ToArray();
        state["listings"] = new JsonArray(listings.Select(x => (JsonNode?)x).ToArray());
        state["candidates"] = new JsonArray((staff ? Candidates(data) : Enumerable.Empty<JsonObject>()).Select(x => (JsonNode?)UiCandidate(x)).ToArray());
        state["applications"] = new JsonArray((staff ? Rows(data, "applications") : Enumerable.Empty<JsonObject>()).Select(x => (JsonNode?)UiApplication(x)).ToArray());
        state["pipeline"] = new JsonObject();
        state["favorites"] ??= new JsonArray(); state["lists"] ??= new JsonArray(); state["listMembers"] ??= new JsonObject(); state["candidateFavorites"] ??= new JsonObject();
        return state;
    }
    private static JsonObject NotificationView(JsonObject row)
    {
        var view = (JsonObject)row.DeepClone(); view["createdAt"] ??= row["created"]?.DeepClone(); return view;
    }
    private static JsonObject UiListing(JsonObject row)
    {
        var view = (JsonObject)row.DeepClone();
        Defaults(view, "title", "company", "location", "pay", "ownerUserId");
        view["kind"] ??= "empleo"; view["desc"] ??= row["description"]?.DeepClone() ?? JsonValue.Create("");
        view["tags"] ??= new JsonArray(); view["createdBy"] = "empresa"; view["createdAt"] = EpochCreated(row);
        return view;
    }
    private static JsonObject UiCandidate(JsonObject row)
    {
        var view = (JsonObject)row.DeepClone(); view["name"] = Text(row["fullName"]) ?? Text(row["name"]) ?? string.Join(" ", new[] { Text(row["firstName"]), Text(row["lastName"]) }.Where(x => !string.IsNullOrWhiteSpace(x)));
        view["tags"] = row["skills"]?.DeepClone() ?? row["tags"]?.DeepClone() ?? new JsonArray(); Defaults(view, "title", "location", "about", "cvUrl"); view["public"] ??= true; return view;
    }
    private static JsonObject UiApplication(JsonObject row)
    {
        var view = ApplicationView(row); view["candidateId"] = CandidateReference(row); view["createdAt"] = EpochCreated(row);
        view["status"] = LegacyStage(Text(row["stage"])) switch { "entrevista" => "entrevista", "oferta" or "hired" => "oferta", "descartado" => "rechazado", _ => "enviado" }; return view;
    }
    private static long? EpochCreated(JsonObject row)
    {
        if (row["createdAt"] is JsonValue v && v.TryGetValue<long>(out var epoch)) return epoch;
        return DateTimeOffset.TryParse(Created(row), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date.ToUnixTimeMilliseconds() : null;
    }

    private JsonObject Catalog(JsonObject data, string collection, JsonObject query)
    {
        RequireStaff(); var q = Text(query["q"]) ?? "";
        var normalized = new string(q.ToLowerInvariant().Where(c => c is >= 'a' and <= 'z' or >= '0' and <= '9').ToArray());
        return Items(Rows(data, collection).Where(x => (Text(query["active"]) != "1" || x["isActive"]?.ToJsonString() == "true") &&
            (q.Length == 0 || (Text(x["name"]) ?? "").Contains(q, StringComparison.OrdinalIgnoreCase) || (normalized.Length > 0 && (Text(x["normalizedKey"]) ?? "").Contains(normalized, StringComparison.OrdinalIgnoreCase))))
            .OrderBy(x => Text(x["code"]), StringComparer.Ordinal).ThenBy(x => Text(x["name"]), StringComparer.Ordinal));
    }

    private static JsonObject Audit(JsonObject data, JsonObject query)
    {
        var rows = Rows(data, "audit_log").Where(x => (Text(x["action"]) ?? "").Contains(Text(query["action"]) ?? "", StringComparison.OrdinalIgnoreCase));
        foreach (var bound in new[] { "from", "to" })
        {
            if (Text(query[bound]) is not { Length: > 0 } date) continue;
            if (!DateTimeOffset.TryParse(date, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var limit)) throw Invalid($"{bound} no es una fecha válida.");
            rows = rows.Where(x => DateTimeOffset.TryParse(Text(x["at"]), out var at) && (bound == "from" ? at >= limit : at <= limit));
        }
        var list = rows.OrderByDescending(x => Text(x["at"])).ToArray();
        var page = PositiveQuery(query, "page", 1, int.MaxValue); var size = PositiveQuery(query, "perPage", 20, 200);
        var response = Items(list.Skip((int)Math.Min((long)(page - 1) * size, int.MaxValue)).Take(size));
        response["totalItems"] = list.Length; response["page"] = page; response["perPage"] = size; response["totalPages"] = (int)Math.Ceiling((double)list.Length / size);
        return response;
    }

    private static JsonObject Metrics(JsonObject data)
    {
        var apps = Rows(data, "applications").ToArray(); var listings = Rows(data, "listings").ToArray();
        var hired = apps.Where(a => Text(a["stage"]) == "hired").ToArray(); var times = new List<double>();
        foreach (var app in hired)
        {
            var end = Text(app["hiredAt"]);
            if (end is null) end = Rows(data, "hire_profiles").FirstOrDefault(h => Text(h["applicationId"]) == Text(app["id"])) is { } hp ? Created(hp) : null;
            if (DateTimeOffset.TryParse(Created(app), out var from) && DateTimeOffset.TryParse(end, out var to) && to >= from) times.Add((to - from).TotalDays);
        }
        var candidates = Candidates(data).ToArray();
        var activity = apps.Select(a => RecentApplication(a, candidates, listings))
            .OrderByDescending(a => DateTimeOffset.TryParse(Text(a["timestamp"]), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var date) ? date : DateTimeOffset.MinValue)
            .Take(10);
        return new JsonObject
        {
            ["ok"] = true, ["totalListings"] = listings.Length, ["totalApplications"] = apps.Length,
                        ["totalCandidates"] = candidates.Select(c => Text(c["id"])).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct(StringComparer.Ordinal).Count(),
            ["applicationsByStage"] = Counts(apps, a => LegacyStage(Text(a["stage"]))), ["listingsByKind"] = Counts(listings, l => Text(l["kind"]) ?? "empleo"),
            ["recentActivity"] = new JsonArray(activity.Select(a => (JsonNode?)a).ToArray()), ["avgTimeToHire"] = times.Count == 0 ? null : JsonValue.Create(Math.Round(times.Average(), 2)),
            ["conversionRate"] = apps.Length == 0 ? 0 : Math.Round(100.0 * hired.Length / apps.Length, 2)
        };
    }

    private static JsonObject RecentApplication(JsonObject app, JsonObject[] candidates, JsonObject[] listings)
    {
        var candidateId = CandidateReference(app);
        var candidate = candidates.FirstOrDefault(c => Text(c["id"]) == candidateId);
        var name = new[] { Text(candidate?["fullName"]), Text(candidate?["name"]) }.FirstOrDefault(n => !string.IsNullOrWhiteSpace(n))
            ?? string.Join(" ", new[] { Text(candidate?["firstName"]), Text(candidate?["lastName"]) }.Where(n => !string.IsNullOrWhiteSpace(n)).Select(n => n!.Trim()));
        var title = Text(listings.FirstOrDefault(l => Text(l["id"]) == Text(app["listingId"]))?["title"]) ?? "";
        var stage = LegacyStage(Text(app["stage"]));
        var (label, icon) = stage switch
        {
            "nuevo" => ("candidatura recibida", "FileText"),
            "revisar" => ("en revisión", "Clock"),
            "entrevista" => ("en entrevista", "MessageSquare"),
            "oferta" => ("en oferta", "CheckCircle2"),
            "descartado" => ("descartado", "XCircle"),
            "hired" => ("contratado", "UserPlus"),
            _ => (stage, "FileText")
        };
        // Generic updated/updatedAt may just be a notes edit. Only explicit stage timestamps
        // establish movement; imported records without them remain current-stage snapshots.
        var stageDate = Text(app["stageChangedAt"]) ?? Text(app["stageUpdatedAt"])
            ?? (stage == "hired" ? Text(app["hiredAt"]) : null);
        var timestamp = DateTimeOffset.TryParse(stageDate, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out _) ? stageDate : Created(app);
        return new JsonObject
        {
            ["id"] = Text(app["id"]), ["stage"] = stage, ["createdAt"] = Created(app),
            ["candidateName"] = name, ["listingTitle"] = title, ["listTitle"] = title,
            ["candidateId"] = candidateId, ["candidateUserId"] = candidateId, ["listingId"] = Text(app["listingId"]),
            ["name"] = name, ["action"] = "etapa actual: " + label, ["detail"] = title,
            ["timestamp"] = timestamp, ["icon"] = icon
        };
    }

    private static JsonObject Counts(IEnumerable<JsonObject> rows, Func<JsonObject, string> key) => new(rows.GroupBy(key).Select(g => new KeyValuePair<string, JsonNode?>(g.Key, JsonValue.Create(g.Count()))));
    private static JsonObject UpdateOutbox(JsonObject data, string id, string status, bool replay)
    {
        if (status is not ("pending" or "completed" or "exported_manually")) throw Invalid("status debe ser pending, completed o exported_manually.");
        var row = Find(data, "integration_outbox", id);
        if (!replay) { row["status"] = status; Touch(row); }
        return new JsonObject { ["ok"] = true, ["outbox"] = row.DeepClone() };
    }

    private static void ValidateListing(JsonObject body, bool full)
    {
        Only(body, ["kind", "title", "company", "location", "pay", "tags", "desc", "department", "description"]);
        if (full || body.ContainsKey("kind"))
            if (Required(body, "kind", 32) is not ("empleo" or "ett" or "becario" or "freelance")) throw Invalid("kind debe ser empleo, ett, becario o freelance.");
        foreach (var (key, max, min) in new[] { ("title", 180, 2), ("company", 120, 1), ("location", 120, 1) })
            if (full || body.ContainsKey(key)) Required(body, key, max, min);
        OptionalText(body, "pay", 40); OptionalText(body, "desc", 5000); OptionalText(body, "department", 300); OptionalText(body, "description", 20000); Strings(body, "tags");
        if (body.Count == 0) throw Invalid("La actualización está vacía.");
    }

    private static void ValidateCandidate(JsonObject body, bool full)
    {
        Only(body, ["name", "fullName", "firstName", "lastName", "email", "phone", "title", "location", "public", "skills", "about"]);
        if (full && string.IsNullOrWhiteSpace(Text(body["fullName"]) ?? Text(body["name"]) ?? Text(body["firstName"]))) throw Invalid("El nombre del candidato es obligatorio.");
        foreach (var key in new[] { "name", "fullName", "firstName", "lastName", "title", "location" }) OptionalText(body, key, 120);
        if (full || body.ContainsKey("email")) Email(body, "email");
        OptionalText(body, "phone", 80); OptionalText(body, "about", 2000); Strings(body, "skills"); Boolean(body, "public");
        if (body.Count == 0) throw Invalid("La actualización está vacía.");
    }
    private static void PatchCandidate(JsonObject row, JsonObject body)
    {
        Patch(row, body);
        var name = Text(body["fullName"]) ?? Text(body["name"]);
        if (name is null && (body.ContainsKey("firstName") || body.ContainsKey("lastName")))
            name = string.Join(" ", new[] { Text(row["firstName"]), Text(row["lastName"]) }.Where(x => !string.IsNullOrWhiteSpace(x)));
        name ??= Text(row["fullName"]) ?? Text(row["name"]) ?? "";
        row["fullName"] = name; row["name"] = name;
    }
    private static void UniqueEmail(JsonObject data, JsonObject body, string id)
    {
        if (Text(body["email"]) is { } email && Candidates(data).Any(x => Text(x["id"]) != id && string.Equals(Text(x["email"]), email, StringComparison.OrdinalIgnoreCase)))
            throw Error("reference_conflict", "Ya existe un candidato con ese email.");
    }
    private static void ValidateStage(JsonObject body)
    {
        if (body.ContainsKey("stage") && !Stages.Contains(Text(body["stage"]))) throw Invalid("stage debe ser nuevo, revisar, entrevista, oferta, descartado o hired.");
    }
    private static string LegacyStage(string? stage) => stage switch { "applied" => "nuevo", "screening" => "revisar", "interview" => "entrevista", "offer" => "oferta", "rejected" => "descartado", null or "" => "nuevo", _ => stage };
    private static JsonObject ApplicationView(JsonObject row)
    {
        var view = (JsonObject)row.DeepClone(); view["candidateUserId"] = CandidateReference(row); view["stage"] = LegacyStage(Text(row["stage"])); view["created"] ??= row["createdAt"]?.DeepClone(); return view;
    }
    private static string CandidateReference(JsonObject row) => Text(row["candidateUserId"]) ?? Text(row["candidateId"]) ?? "";
    private void RequireStaff()
    {
        if (identity.Role is not ("admin" or "rrhh" or "it")) throw Error("forbidden", "Esta operación requiere un rol interno autorizado por el host.");
    }

    // A new store has no departments or job titles, which made every IT onboarding impossible.
    // The official lists the web backend seeded are embedded unchanged; stable ids let a GET
    // show the same rows that the next write persists. Existing catalogs are never touched.
    private static readonly Dictionary<string, JsonObject[]> CatalogSeeds = new[] { "departments", "job_titles" }
        .ToDictionary(collection => collection, LoadCatalogSeed);
    private static JsonObject[] LoadCatalogSeed(string collection)
    {
        using var stream = typeof(LegacyApi).Assembly.GetManifestResourceStream($"ProyectoX.Seeds/{collection}.seed.cjs");
        if (stream is null) return [];
        var rows = new List<JsonObject>(); var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var line in new StreamReader(stream).ReadToEnd().Split('\n'))
        {
            var match = System.Text.RegularExpressions.Regex.Match(line, @"^\s*'([^']+)',?\s*$");
            if (!match.Success) continue;
            var name = match.Groups[1].Value.Trim();
            var key = new string(name.ToLowerInvariant().Where(c => c is >= 'a' and <= 'z' or >= '0' and <= '9').ToArray());
            if (key.Length == 0 || !seen.Add(key)) continue;
            var separator = name.IndexOf(" - ", StringComparison.Ordinal);
            rows.Add(new JsonObject { ["id"] = $"seed-{collection}-{key}", ["code"] = separator >= 0 ? name[..separator].Trim() : name, ["name"] = name, ["normalizedKey"] = key, ["isActive"] = true });
        }
        return rows.ToArray();
    }
    private static void SeedCatalogs(JsonObject data)
    {
        foreach (var (collection, seeds) in CatalogSeeds)
            if (seeds.Length > 0 && (data[collection] is not JsonArray existing || existing.Count == 0))
                data[collection] = new JsonArray(seeds.Select(row => (JsonNode?)row.DeepClone()).ToArray());
    }

    private static JsonObject Normalize(JsonObject source)
    {
        var data = (JsonObject)source.DeepClone();
        foreach (var key in new[] { "listings", "candidates", "applications", "candidate_profiles", "company_profiles", "user_state", "user_settings", "departments", "job_titles", "catalog_items", "rbac_rules", "integration_outbox", "hire_profiles", "audit_log", "profile_imports", "notifications", "desktop_profiles", "desktop_user_state", "desktop_user_settings", "desktop_identity_mappings" })
        {
            if (data[key] is null && !data.ContainsKey(key)) continue;
            if (data[key] is not JsonArray array || array.Any(x => x is not JsonObject)) throw Error("store_unavailable", $"La colección {key} no es un array de objetos.");
        }
        data["_operations"] ??= new JsonObject();
        if (data["_operations"] is not JsonObject receipts || receipts.Any(r => !Guid.TryParseExact(r.Key, "D", out var uuid) || uuid.ToString("D") != r.Key || Text(r.Value) is not { Length: 64 } hash || !hash.All(Uri.IsHexDigit)))
            throw Error("store_unavailable", "Los recibos de operaciones no son válidos.");
        return data;
    }
    private static bool HasReceipt(JsonObject data, string op, string hash)
    {
        if (!((JsonObject)data["_operations"]!).TryGetPropertyValue(op, out var previous)) return false;
        if (Text(previous) != hash) throw Invalid("operationId ya se ha utilizado para una solicitud diferente.");
        return true;
    }
    private JsonObject WithMetadata(JsonObject response, long revision, JsonObject data)
    {
        response["__desktop"] = new JsonObject { ["revision"] = revision, ["readOnly"] = readOnly, ["appliedOperationIds"] = new JsonArray(((JsonObject)data["_operations"]!).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray()) };
        return response;
    }
    private static IEnumerable<JsonObject> Candidates(JsonObject data) => Rows(data, "candidates").Concat(Rows(data, "candidate_profiles")).GroupBy(x => Text(x["id"]), StringComparer.Ordinal).Select(g => g.First());
    private static JsonObject Candidate(JsonObject data, string id) => Candidates(data).FirstOrDefault(x => Text(x["id"]) == id) ?? throw Error("not_found", "El perfil de candidato no existe.");
    private static void MergeCandidateAliases(JsonObject data)
    {
        var canonical = Array(data, "candidates");
        foreach (var alias in Rows(data, "candidate_profiles"))
        {
            var existing = canonical.OfType<JsonObject>().FirstOrDefault(x => Text(x["id"]) == Text(alias["id"]));
            if (existing is null) canonical.Add(alias.DeepClone());
            else foreach (var field in alias) if (!existing.ContainsKey(field.Key)) existing[field.Key] = field.Value?.DeepClone();
        }
    }
    private static void SynchronizeCandidateAliases(JsonObject data)
    {
        if (data.ContainsKey("candidate_profiles")) data["candidate_profiles"] = Array(data, "candidates").DeepClone();
    }
    private static IEnumerable<JsonObject> Rows(JsonObject data, string collection) => data[collection] is JsonArray a ? a.OfType<JsonObject>() : [];
    private static JsonArray Array(JsonObject data, string collection)
    {
        data[collection] ??= new JsonArray(); return (JsonArray)data[collection]!;
    }
    private static JsonObject Find(JsonObject data, string collection, string id) => Rows(data, collection).FirstOrDefault(x => Text(x["id"]) == id) ?? throw Error("not_found", "La entidad solicitada no existe.");
    private static JsonObject Add(JsonObject data, string collection, string op, string kind)
    {
        var row = new JsonObject { ["id"] = NewId(op, kind), ["created"] = Now(), ["createdAt"] = Now() }; Touch(row); Array(data, collection).Add(row); return row;
    }
    private static string NewId(string op, string kind) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(op + ":" + kind))).ToLowerInvariant()[..24];
    private static void Touch(JsonObject row) { row["updated"] = Now(); row["updatedAt"] = row["updated"]!.DeepClone(); }
    private static string Now() => DateTimeOffset.UtcNow.ToString("O");
    private static string? Created(JsonObject row) => Text(row["created"]) ?? Text(row["createdAt"]);
    private static void Patch(JsonObject row, JsonObject body) { foreach (var field in body) row[field.Key] = field.Value?.DeepClone(); }
    private static void Defaults(JsonObject row, params string[] keys) { foreach (var key in keys) row[key] ??= ""; }
    private static JsonObject Ok() => new() { ["ok"] = true };
    private static JsonObject Item(JsonObject row) => new() { ["ok"] = true, ["item"] = row.DeepClone() };
    private static JsonObject Items(IEnumerable<JsonObject> rows) => new() { ["ok"] = true, ["items"] = new JsonArray(rows.Select(x => x.DeepClone()).ToArray()) };
    private static string? Text(JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;
    private static double Number(JsonNode? node) => node is JsonValue v && v.TryGetValue<double>(out var number) ? number : 0;
    private static string Required(JsonObject obj, string key, int max, int min = 1)
    {
        var text = Text(obj[key]); if (text is null || text.Trim().Length < min || text.Length > max) throw Invalid($"{key} debe ser un texto de {min} a {max} caracteres."); return text.Trim();
    }
    private static void OptionalText(JsonObject body, string key, int max)
    {
        if (body.ContainsKey(key) && (Text(body[key]) is not { } text || text.Length > max)) throw Invalid($"{key} debe ser un texto de hasta {max} caracteres.");
    }
    private static void Email(JsonObject body, string key)
    {
        var email = Required(body, key, 320);
        if (!MailAddress.TryCreate(email, out var address) || address.Address != email || !email.Contains('@') || email.Any(char.IsWhiteSpace)) throw Invalid($"{key} no es un email válido.");
    }
    private static void Strings(JsonObject body, string key)
    {
        if (body.ContainsKey(key) && (body[key] is not JsonArray a || a.Count > 500 || a.Any(x => Text(x) is not { Length: <= 300 }))) throw Invalid($"{key} debe ser un array de textos.");
    }
    private static void Boolean(JsonObject body, string key)
    {
        if (body.ContainsKey(key) && (body[key] is not JsonValue v || !v.TryGetValue<bool>(out _))) throw Invalid($"{key} debe ser booleano.");
    }
    private static void Only(JsonObject body, string[] fields)
    {
        foreach (var field in body) if (!fields.Contains(field.Key)) throw Invalid("La solicitud contiene un campo no permitido.");
    }
    private static bool Match(JsonObject row, string key, JsonObject query) => Text(query[key]) is not { Length: > 0 } value || Text(row[key]) == value;
    private static int PositiveQuery(JsonObject query, string key, int fallback, int max) => int.TryParse(Text(query[key]), NumberStyles.None, CultureInfo.InvariantCulture, out var value) ? Math.Clamp(value, 1, max) : fallback;
    private static JsonNode? Canonical(JsonNode? node) => node switch
    {
        JsonObject obj => new JsonObject(obj.OrderBy(x => x.Key, StringComparer.Ordinal).Select(x => new KeyValuePair<string, JsonNode?>(x.Key, Canonical(x.Value)))),
        JsonArray a => new JsonArray(a.Select(Canonical).ToArray()), _ => node?.DeepClone()
    };
    private static (string Path, JsonObject Query) ParsePath(string raw)
    {
        if (raw.Length > 4096 || !raw.StartsWith('/') || raw.StartsWith("//", StringComparison.Ordinal) || raw.Contains('\\') || raw.Contains('#') || raw.Any(char.IsControl)) throw Invalid("path debe ser una ruta local absoluta.");
        var split = raw.Split('?', 2); var segments = split[0].Split('/', StringSplitOptions.RemoveEmptyEntries);
        var decoded = new List<string>();
        foreach (var segment in segments)
        {
            for (var i = 0; i < segment.Length; i++) if (segment[i] == '%' && (i + 2 >= segment.Length || !Uri.IsHexDigit(segment[i + 1]) || !Uri.IsHexDigit(segment[i + 2]))) throw Invalid("Escape inválido en path.");
            var value = Uri.UnescapeDataString(segment);
            if (value is "." or ".." || value.Any(c => c is '/' or '\\' or '%' or '?' or '#' || char.IsControl(c))) throw Invalid("path no permite traversal ni separadores codificados.");
            decoded.Add(value);
        }
        if (decoded.FirstOrDefault() == "api") decoded.RemoveAt(0);
        var query = new JsonObject();
        if (split.Length == 2) foreach (var entry in split[1].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = entry.Split('=', 2); var key = Uri.UnescapeDataString(pair[0].Replace('+', ' '));
            if (query.ContainsKey(key)) throw Invalid("Parámetro query duplicado.");
            query[key] = Uri.UnescapeDataString((pair.Length == 2 ? pair[1] : "").Replace('+', ' '));
        }
        return ("/" + string.Join('/', decoded), query);
    }
    private static bool IsDocumentPath(string path) => path.StartsWith("/profile/imports", StringComparison.Ordinal) || path.EndsWith("/cv", StringComparison.Ordinal) || path.EndsWith("/import_candidate", StringComparison.Ordinal) || path.EndsWith("/export.zip", StringComparison.Ordinal) || path.Contains("/documents", StringComparison.Ordinal);
    private static string ActorHash(string actor) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(actor)));
    private static string AuditRoute(string path)
    {
        var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return parts switch
        {
            ["listings", _] => "/listings/:id",
            ["candidates", _] => "/candidates/:id",
            ["applications", _] => "/applications/:id",
            ["company", "applications", _] => "/company/applications/:id",
            ["notifications", "mark-all-read"] => "/notifications/mark-all-read",
            ["notifications", _] => "/notifications/:id",
            ["outbox", _, "mark_exported"] => "/outbox/:id/mark_exported",
            ["enterprise", "outbox", _] => "/enterprise/outbox/:id",
            ["enterprise", "outbox", _, "complete"] => "/enterprise/outbox/:id/complete",
            _ => path
        };
    }
    private static LegacyApiException Unsupported(string method, string path) => Error("unsupported_operation", "Operación local no implementada para esta ruta y método.");
    private static LegacyApiException Invalid(string message) => Error("invalid_request", message);
    private static LegacyApiException Error(string code, string message) => new(code, message);
}

/// <summary>
/// Per-record optimistic concurrency on top of the store's global revision. Each write records
/// the revision at which every business record it touched last changed (in "_revisions", never
/// inside the records, so snapshots and exports are unchanged). Records without a stamp were last
/// written by an older host or another path, so they never qualify for a stale write.
/// </summary>
internal static class EntityRevisions
{
    private const string Key = "_revisions";
    private static readonly string[] Collections = ["listings", "candidates", "applications", "hire_profiles", "integration_outbox", "notifications", "profile_imports", "documents", "desktop_profiles"];

    internal sealed record Change(IReadOnlyList<string> Existing, IReadOnlyList<string> Created);

    internal static Dictionary<string, JsonNode> Rows(JsonObject data)
    {
        var rows = new Dictionary<string, JsonNode>(StringComparer.Ordinal);
        foreach (var collection in Collections)
            if (data[collection] is JsonArray array)
                foreach (var row in array.OfType<JsonObject>())
                    if (row["id"] is JsonValue id && id.TryGetValue<string>(out var text)) rows.TryAdd(collection + "/" + text, row.DeepClone());
        return rows;
    }

    internal static Change Touched(Dictionary<string, JsonNode> before, JsonObject after)
    {
        var current = Rows(after);
        var existing = before.Where(row => !current.TryGetValue(row.Key, out var now) || !JsonNode.DeepEquals(row.Value, now)).Select(row => row.Key).ToList();
        return new Change(existing, current.Keys.Where(key => !before.ContainsKey(key)).ToList());
    }

    internal static bool UnchangedSince(JsonObject data, Change change, long revision) =>
        change.Created.Count == 0 && change.Existing.All(key =>
            data[Key] is JsonObject stamps && stamps[key] is JsonValue value && value.TryGetValue<long>(out var at) && at <= revision);

    internal static void Stamp(JsonObject data, Change change, long revision)
    {
        if (data[Key] is not JsonObject stamps) data[Key] = stamps = new JsonObject();
        foreach (var key in change.Existing.Concat(change.Created)) stamps[key] = revision;
        var current = Rows(data);
        foreach (var removed in change.Existing.Where(key => !current.ContainsKey(key))) stamps.Remove(removed);
    }

    /// <summary>For writers that do not stamp: the record falls back to the global revision.</summary>
    internal static void Invalidate(JsonObject data, string collection, string id) => (data[Key] as JsonObject)?.Remove(collection + "/" + id);
}

/// <summary>
/// Receipts only let a retry of an uncertain write resolve to the original commit; the renderer
/// forgets its pending operations when it closes. Unbounded, they grew state.json on every write
/// and were all sent back in every response, so only the most recent ones are kept.
/// </summary>
internal static class Receipts
{
    internal const int Max = 2000;

    internal static void Trim(JsonObject data)
    {
        if (data["_operations"] is not JsonObject receipts || receipts.Count <= Max) return;
        var results = data["_documentResults"] as JsonObject;
        foreach (var oldest in receipts.Take(receipts.Count - Max).Select(receipt => receipt.Key).ToArray())
        {
            receipts.Remove(oldest);
            results?.Remove(oldest);
        }
    }
}
