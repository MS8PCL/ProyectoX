// Bootstrap PocketBase collections required by Proyecto X.
// Usage (inside api container): bun src/bootstrap-pocketbase.cjs

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  return `${b}${p.startsWith("/") ? "" : "/"}${p}`;
}

async function req(url, init) {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, text, json };
}

async function adminToken(baseUrl, email, password) {
  const payload = JSON.stringify({ identity: email, password });

  let r = await req(
    joinUrl(baseUrl, "/api/collections/_superusers/auth-with-password"),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    },
  );

  if (r.res.status === 404) {
    r = await req(joinUrl(baseUrl, "/api/admins/auth-with-password"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
  }

  if (!r.res.ok)
    throw new Error(`Admin auth failed: ${r.res.status} ${r.text}`);
  return r.json.token;
}

async function ensureCollection(baseUrl, token, schema) {
  const hdr = { Authorization: `Bearer ${token}` };

  const check = await req(joinUrl(baseUrl, `/api/collections/${schema.name}`), {
    headers: hdr,
  });
  if (check.res.ok) return { ok: true, existed: true, id: check.json.id };
  if (check.res.status !== 404)
    throw new Error(
      `Unexpected status checking ${schema.name}: ${check.res.status} ${check.text}`,
    );

  const created = await req(joinUrl(baseUrl, "/api/collections"), {
    method: "POST",
    headers: { "content-type": "application/json", ...hdr },
    body: JSON.stringify(schema),
  });

  if (!created.res.ok)
    throw new Error(
      `Create failed (${schema.name}): ${created.res.status} ${created.text}`,
    );
  return { ok: true, existed: false, id: created.json.id };
}

async function patchProfileImports(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` };

  const col = await req(joinUrl(baseUrl, "/api/collections/profile_imports"), {
    headers: hdr,
  });
  if (!col.res.ok)
    throw new Error(
      `Fetch profile_imports failed: ${col.res.status} ${col.text}`,
    );

  const fields = col.json.fields || [];

  // Helper: upsert field by name (preserve id when present)
  function upsertField(next) {
    const idx = fields.findIndex((f) => f.name === next.name);
    if (idx >= 0) fields[idx] = { ...fields[idx], ...next, id: fields[idx].id };
    else fields.push(next);
  }

  const kind = fields.find((f) => f.name === "kind");
  if (kind) {
    kind.values = ["document", "portfolio", "behance", "dribbble"];
    kind.options = kind.options || { maxSelect: 1 };
    kind.options.maxSelect = 1;
  }

  let docType = fields.find((f) => f.name === "docType");
  if (!docType) {
    docType = {
      type: "select",
      name: "docType",
      required: false,
      system: false,
      values: ["cv", "certificate", "portfolio", "linkedin", "other"],
      options: { maxSelect: 1 },
    };
    fields.push(docType);
  } else {
    docType.values = ["cv", "certificate", "portfolio", "linkedin", "other"];
    docType.options = docType.options || { maxSelect: 1 };
    docType.options.maxSelect = 1;
  }

  const file = fields.find((f) => f.name === "file");
  if (file && file.type === "file") {
    file.options = file.options || {};
    file.options.maxSelect = 1;
    file.options.mimeTypes = Array.from(
      new Set([
        ...(file.options.mimeTypes || []),
        "application/pdf",
        "image/png",
        "image/jpeg",
        "image/webp",
      ]),
    );
  }

  // FASE 5 (Plan A): link documents to a specific application (ATS) for export.
  // Use TEXT field to avoid PocketBase relation patch validation issues.
  upsertField({
    type: "text",
    name: "applicationId",
    required: false,
    system: false,
    options: { max: 60, min: 0, pattern: "" },
  });

  // Performance: index on applicationId for export filtering.
  // Best-effort (non-unique).
  const indexes = Array.isArray(col.json.indexes) ? col.json.indexes : [];
  if (
    !indexes.some((s) =>
      String(s).includes("idx_profile_imports_applicationId"),
    )
  ) {
    indexes.push(
      "CREATE INDEX IF NOT EXISTS idx_profile_imports_applicationId ON profile_imports (applicationId)",
    );
  }
  col.json.indexes = indexes;

  const patch = { ...col.json, fields };

  const updated = await req(
    joinUrl(baseUrl, `/api/collections/${col.json.id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...hdr },
      body: JSON.stringify(patch),
    },
  );

  if (!updated.res.ok)
    throw new Error(`Patch failed: ${updated.res.status} ${updated.text}`);
  return true;
}

async function patchApplyTokens(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` };
  const col = await req(joinUrl(baseUrl, "/api/collections/apply_tokens"), {
    headers: hdr,
  });
  if (!col.res.ok)
    throw new Error(`Fetch apply_tokens failed: ${col.res.status} ${col.text}`);

  const fields = col.json.fields || [];
  function upsertField(next) {
    const idx = fields.findIndex((f) => f.name === next.name);
    if (idx >= 0) fields[idx] = { ...fields[idx], ...next, id: fields[idx].id };
    else fields.push(next);
  }

  // Ensure active is not required (PocketBase treats false as blank when required)
  const active = fields.find((f) => f.name === "active");
  if (active && active.type === "bool") active.required = false;

  // Ensure usedByEmail is optional (do not change field type if it already exists)
  const used = fields.find((f) => f.name === "usedByEmail");
  if (used) {
    used.required = false;
  } else {
    upsertField({
      type: "text",
      name: "usedByEmail",
      required: false,
      system: false,
      options: { max: 120, min: 0, pattern: "" },
    });
  }

  const patch = { ...col.json, fields };
  const updated = await req(
    joinUrl(baseUrl, `/api/collections/${col.json.id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...hdr },
      body: JSON.stringify(patch),
    },
  );
  if (!updated.res.ok)
    throw new Error(
      `Patch apply_tokens failed: ${updated.res.status} ${updated.text}`,
    );
  return true;
}

async function patchApplications(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` };
  const col = await req(joinUrl(baseUrl, "/api/collections/applications"), {
    headers: hdr,
  });
  if (!col.res.ok)
    throw new Error(`Fetch applications failed: ${col.res.status} ${col.text}`);

  const fields = col.json.fields || [];

  // Helper: upsert field by name (preserve id when present)
  function upsertField(next) {
    const idx = fields.findIndex((f) => f.name === next.name);
    if (idx >= 0) fields[idx] = { ...fields[idx], ...next, id: fields[idx].id };
    else fields.push(next);
  }

  const stage = fields.find((f) => f.name === "stage");
  if (stage && stage.type === "select") {
    stage.values = Array.from(new Set([...(stage.values || []), "hired"]));
    stage.options = stage.options || { maxSelect: 1 };
    stage.options.maxSelect = 1;
  }

  // FASE 5: public apply fields (required)
  upsertField({
    type: "date",
    name: "birthDate",
    required: true,
    system: false,
    options: { min: "", max: "" },
  });
  upsertField({
    type: "text",
    name: "coverLetter",
    required: true,
    system: false,
    options: { max: 5000, min: 1, pattern: "" },
  });

  // candidateUserId is now allowed to be empty before apply
  const cand = fields.find((f) => f.name === "candidateUserId");
  if (cand && cand.type === "text") {
    cand.required = false;
    cand.options = cand.options || {};
    cand.options.min = 0;
    cand.options.max = cand.options.max || 60;
  }

  const patch = { ...col.json, fields };
  const updated = await req(
    joinUrl(baseUrl, `/api/collections/${col.json.id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...hdr },
      body: JSON.stringify(patch),
    },
  );
  if (!updated.res.ok)
    throw new Error(
      `Patch applications failed: ${updated.res.status} ${updated.text}`,
    );
  return true;
}

async function patchCandidateProfiles(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` };
  const col = await req(
    joinUrl(baseUrl, "/api/collections/candidate_profiles"),
    { headers: hdr },
  );
  if (!col.res.ok)
    throw new Error(
      `Fetch candidate_profiles failed: ${col.res.status} ${col.text}`,
    );

  const fields = col.json.fields || [];

  function upsertField(next) {
    const idx = fields.findIndex((f) => f.name === next.name);
    if (idx >= 0) fields[idx] = { ...fields[idx], ...next, id: fields[idx].id };
    else fields.push(next);
  }

  upsertField({
    type: "email",
    name: "email",
    required: true,
    system: false,
    options: { exceptDomains: [], onlyDomains: [] },
  });
  upsertField({
    type: "text",
    name: "firstName",
    required: true,
    system: false,
    options: { max: 80, min: 1, pattern: "" },
  });
  upsertField({
    type: "text",
    name: "lastName",
    required: true,
    system: false,
    options: { max: 120, min: 1, pattern: "" },
  });

  // Make title/location optional (no invented values)
  const title = fields.find((f) => f.name === "title");
  if (title && title.type === "text") {
    title.required = false;
    title.options = title.options || {};
    title.options.min = 0;
    title.options.max = title.options.max || 120;
  }

  const location = fields.find((f) => f.name === "location");
  if (location && location.type === "text") {
    location.required = false;
    location.options = location.options || {};
    location.options.min = 0;
    location.options.max = location.options.max || 120;
  }

  // userId becomes optional in public-apply mode
  const userId = fields.find((f) => f.name === "userId");
  if (userId && userId.type === "text") {
    userId.required = false;
    userId.options = userId.options || {};
    userId.options.min = 0;
    userId.options.max = userId.options.max || 60;
  }

  // Ensure NON-UNIQUE index on email (best-effort)
  // Unique cannot be guaranteed due to existing legacy records / empty emails.
  const indexes = Array.isArray(col.json.indexes) ? col.json.indexes : [];
  if (
    !indexes.some((s) => String(s).includes("idx_candidate_profiles_email"))
  ) {
    indexes.push(
      "CREATE INDEX IF NOT EXISTS idx_candidate_profiles_email ON candidate_profiles (email)",
    );
  }

  const patch = { ...col.json, fields, indexes };
  const updated = await req(
    joinUrl(baseUrl, `/api/collections/${col.json.id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...hdr },
      body: JSON.stringify(patch),
    },
  );
  if (!updated.res.ok)
    throw new Error(
      `Patch candidate_profiles failed: ${updated.res.status} ${updated.text}`,
    );
  return true;
}

async function patchHireProfiles(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` };
  const col = await req(joinUrl(baseUrl, "/api/collections/hire_profiles"), {
    headers: hdr,
  });
  if (!col.res.ok)
    throw new Error(
      `Fetch hire_profiles failed: ${col.res.status} ${col.text}`,
    );

  const fields = col.json.fields || [];

  // Helper: upsert field by name (preserve id when present)
  function upsertField(next) {
    const idx = fields.findIndex((f) => f.name === next.name);
    if (idx >= 0) fields[idx] = { ...fields[idx], ...next, id: fields[idx].id };
    else fields.push(next);
  }

  upsertField({
    type: "date",
    name: "startDate",
    required: true,
    system: false,
    options: { min: "", max: "" },
  });
  upsertField({
    type: "text",
    name: "departmentId",
    required: true,
    system: false,
    options: { max: 60, min: 1, pattern: "" },
  });
  upsertField({
    type: "text",
    name: "jobTitleId",
    required: true,
    system: false,
    options: { max: 60, min: 1, pattern: "" },
  });
  upsertField({
    type: "text",
    name: "costCenter",
    required: true,
    system: false,
    options: { max: 80, min: 1, pattern: "" },
  });
  upsertField({
    type: "email",
    name: "managerEmail",
    required: true,
    system: false,
    options: { exceptDomains: [], onlyDomains: [] },
  });
  upsertField({
    type: "text",
    name: "managerName",
    required: false,
    system: false,
    options: { max: 120, min: 0, pattern: "" },
  });
  upsertField({
    type: "text",
    name: "accessProfileId",
    required: true,
    system: false,
    options: { max: 80, min: 1, pattern: "" },
  });
  upsertField({
    type: "text",
    name: "hardwareProfile",
    required: false,
    system: false,
    options: { max: 200, min: 0, pattern: "" },
  });
  upsertField({
    type: "text",
    name: "notesIT",
    required: false,
    system: false,
    options: { max: 2000, min: 0, pattern: "" },
  });

  // Remove legacy field if present
  const legacyIdx = fields.findIndex((f) => f.name === "departmentLegacyText");
  if (legacyIdx >= 0) fields.splice(legacyIdx, 1);

  const patch = { ...col.json, fields };
  const updated = await req(
    joinUrl(baseUrl, `/api/collections/${col.json.id}`),
    {
      method: "PATCH",
      headers: { "content-type": "application/json", ...hdr },
      body: JSON.stringify(patch),
    },
  );
  if (!updated.res.ok)
    throw new Error(
      `Patch hire_profiles failed: ${updated.res.status} ${updated.text}`,
    );
  return true;
}

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || "http://pocketbase:8090";
  const email = process.env.PB_ADMIN_EMAIL;
  const password = process.env.PB_ADMIN_PASSWORD;
  if (!email || !password)
    throw new Error("Missing PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD");

  const token = await adminToken(baseUrl, email, password);

  // user_state

  // apply_tokens (FASE 5: public apply by link, single-use + expiry required)
  await ensureCollection(baseUrl, token, {
    name: "apply_tokens",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "jobId",
        required: false,
        system: false,
        options: { max: 60, min: 0, pattern: "" },
      },
      {
        type: "text",
        name: "applicationId",
        required: true,
        system: false,
        options: { max: 60, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "tokenHash",
        required: true,
        system: false,
        options: { max: 200, min: 10, pattern: "" },
      },
      {
        type: "date",
        name: "expiresAt",
        required: true,
        system: false,
        options: { min: "", max: "" },
      },
      // NOTE: required=false because PB treats false as blank when required=true.
      {
        type: "bool",
        name: "active",
        required: false,
        system: false,
        options: {},
      },
      {
        type: "date",
        name: "usedAt",
        required: false,
        system: false,
        options: { min: "", max: "" },
      },
      {
        type: "text",
        name: "usedByEmail",
        required: false,
        system: false,
        options: { max: 120, min: 0, pattern: "" },
      },
      {
        type: "date",
        name: "createdAt",
        required: true,
        system: false,
        options: { min: "", max: "" },
      },
      {
        type: "text",
        name: "createdByUserId",
        required: false,
        system: false,
        options: { max: 60, min: 0, pattern: "" },
      },
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_apply_tokens_tokenHash ON apply_tokens (tokenHash)",
      "CREATE INDEX IF NOT EXISTS idx_apply_tokens_applicationId ON apply_tokens (applicationId)",
    ],
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '@request.auth.id != ""',
    updateRule: '@request.auth.id != ""',
    deleteRule: '@request.auth.id != ""',
    options: {},
  });

  await ensureCollection(baseUrl, token, {
    name: "user_state",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "userId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      {
        type: "json",
        name: "state",
        required: true,
        system: false,
        options: { maxSize: 0 },
      },
    ],
    indexes: [],
    listRule: "userId = @request.auth.id",
    viewRule: "userId = @request.auth.id",
    createRule: "userId = @request.auth.id",
    updateRule: "userId = @request.auth.id",
    deleteRule: "userId = @request.auth.id",
    options: {},
  });

  // profile_imports (latest schema)
  await ensureCollection(baseUrl, token, {
    name: "profile_imports",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "userId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      {
        type: "select",
        name: "kind",
        required: true,
        system: false,
        values: ["document", "portfolio", "behance", "dribbble"],
        options: { maxSelect: 1 },
      },
      {
        type: "select",
        name: "docType",
        required: false,
        system: false,
        values: ["cv", "certificate", "portfolio", "linkedin", "other"],
        options: { maxSelect: 1 },
      },
      {
        type: "text",
        name: "url",
        required: false,
        system: false,
        options: { max: 2048, min: 0, pattern: "" },
      },
      {
        type: "file",
        name: "file",
        required: false,
        system: false,
        options: {
          maxSelect: 1,
          maxSize: 0,
          mimeTypes: [
            "application/pdf",
            "image/png",
            "image/jpeg",
            "image/webp",
          ],
          thumbs: null,
          protected: false,
        },
      },
      {
        type: "text",
        name: "consentText",
        required: true,
        system: false,
        options: { max: 2048, min: 0, pattern: "" },
      },
      {
        type: "text",
        name: "rawText",
        required: false,
        system: false,
        options: { max: 50000, min: 0, pattern: "" },
      },
    ],
    indexes: [],
    listRule: "userId = @request.auth.id",
    viewRule: "userId = @request.auth.id",
    createRule: "userId = @request.auth.id",
    updateRule: "userId = @request.auth.id",
    deleteRule: "userId = @request.auth.id",
    options: {},
  });

  // FASE 5: patch applications stages/fields if collection existed already.
  // (moved to end — run after all collections are created)

  // candidate_profiles
  // FASE 5: allow public apply without candidate accounts.
  // - userId becomes optional (kept for legacy)
  // - email/firstName/lastName become required for ATS cards/export
  // - title/location become optional (no invented values)
  await ensureCollection(baseUrl, token, {
    name: "candidate_profiles",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "userId",
        required: false,
        system: false,
        options: { max: 60, min: 0, pattern: "" },
      },
      {
        type: "email",
        name: "email",
        required: true,
        system: false,
        options: { exceptDomains: [], onlyDomains: [] },
      },
      {
        type: "text",
        name: "firstName",
        required: true,
        system: false,
        options: { max: 80, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "lastName",
        required: true,
        system: false,
        options: { max: 120, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "fullName",
        required: true,
        system: false,
        options: { max: 200, min: 2, pattern: "" },
      },
      {
        type: "text",
        name: "title",
        required: false,
        system: false,
        options: { max: 120, min: 0, pattern: "" },
      },
      {
        type: "text",
        name: "location",
        required: false,
        system: false,
        options: { max: 120, min: 0, pattern: "" },
      },
      {
        type: "bool",
        name: "public",
        required: false,
        system: false,
        options: {},
      },
      {
        type: "json",
        name: "skills",
        required: false,
        system: false,
        options: { maxSize: 0 },
      },
      {
        type: "text",
        name: "about",
        required: false,
        system: false,
        options: { max: 2000, min: 0, pattern: "" },
      },
    ],
    indexes: [
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_profiles_email ON candidate_profiles (email)",
    ],
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    options: {},
  });

  // company_profiles
  await ensureCollection(baseUrl, token, {
    name: "company_profiles",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "userId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "companyName",
        required: true,
        system: false,
        options: { max: 120, min: 2, pattern: "" },
      },
      {
        type: "text",
        name: "sector",
        required: true,
        system: false,
        options: { max: 120, min: 2, pattern: "" },
      },
      {
        type: "text",
        name: "location",
        required: true,
        system: false,
        options: { max: 120, min: 2, pattern: "" },
      },
    ],
    indexes: [],
    listRule: "userId = @request.auth.id",
    viewRule: "userId = @request.auth.id",
    createRule: "userId = @request.auth.id",
    updateRule: "userId = @request.auth.id",
    deleteRule: "userId = @request.auth.id",
    options: {},
  });

  // listings (server-side)
  await ensureCollection(baseUrl, token, {
    name: "listings",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "ownerUserId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      {
        type: "select",
        name: "kind",
        required: true,
        system: false,
        values: ["empleo", "freelance"],
        options: { maxSelect: 1 },
      },
      {
        type: "text",
        name: "title",
        required: true,
        system: false,
        options: { max: 180, min: 2, pattern: "" },
      },
      {
        type: "text",
        name: "company",
        required: true,
        system: false,
        options: { max: 120, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "location",
        required: true,
        system: false,
        options: { max: 120, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "pay",
        required: false,
        system: false,
        options: { max: 40, min: 0, pattern: "" },
      },
      {
        type: "json",
        name: "tags",
        required: false,
        system: false,
        options: { maxSize: 0 },
      },
      {
        type: "text",
        name: "desc",
        required: false,
        system: false,
        options: { max: 5000, min: 0, pattern: "" },
      },
    ],
    indexes: [],
    // we'll enforce access in backend using admin token
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    options: {},
  });

  // applications (server-side)
  await ensureCollection(baseUrl, token, {
    name: "applications",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "listingId",
        required: true,
        system: false,
        options: { max: 60, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "companyUserId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      // FASE 5: this now stores candidate_profiles.id (legacy name kept)
      {
        type: "text",
        name: "candidateUserId",
        required: false,
        system: false,
        options: { max: 60, min: 0, pattern: "" },
      },
      {
        type: "select",
        name: "stage",
        required: true,
        system: false,
        values: [
          "nuevo",
          "revisar",
          "entrevista",
          "oferta",
          "descartado",
          "hired",
        ],
        options: { maxSelect: 1 },
      },
      {
        type: "text",
        name: "notes",
        required: false,
        system: false,
        options: { max: 2000, min: 0, pattern: "" },
      },
      // FASE 5: public apply fields (per-application)
      {
        type: "date",
        name: "birthDate",
        required: true,
        system: false,
        options: { min: "", max: "" },
      },
      {
        type: "text",
        name: "coverLetter",
        required: true,
        system: false,
        options: { max: 5000, min: 1, pattern: "" },
      },
    ],
    indexes: [],
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    options: {},
  });

  // FASE 5: patch profile_imports now that applications exists (needs relation collectionId)
  await patchProfileImports(baseUrl, token);

  // listing_favorites
  await ensureCollection(baseUrl, token, {
    name: "listing_favorites",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "userId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "listingId",
        required: true,
        system: false,
        options: { max: 60, min: 1, pattern: "" },
      },
    ],
    indexes: [],
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    options: {},
  });

  // hire_profiles (portal hiring profile)
  await ensureCollection(baseUrl, token, {
    name: "hire_profiles",
    type: "base",
    system: false,
    fields: [
      {
        type: "text",
        name: "applicationId",
        required: true,
        system: false,
        options: { max: 60, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "companyUserId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "candidateUserId",
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: "" },
      },
      // hire-only fields (Alta IT). Stored as text ids (no PB relations) to avoid cross-version bootstrap issues.
      {
        type: "date",
        name: "startDate",
        required: true,
        system: false,
        options: { min: "", max: "" },
      },
      {
        type: "text",
        name: "departmentId",
        required: true,
        system: false,
        options: { max: 60, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "jobTitleId",
        required: true,
        system: false,
        options: { max: 60, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "costCenter",
        required: true,
        system: false,
        options: { max: 80, min: 1, pattern: "" },
      },
      {
        type: "email",
        name: "managerEmail",
        required: true,
        system: false,
        options: { exceptDomains: [], onlyDomains: [] },
      },
      {
        type: "text",
        name: "managerName",
        required: false,
        system: false,
        options: { max: 120, min: 0, pattern: "" },
      },
      {
        type: "text",
        name: "accessProfileId",
        required: true,
        system: false,
        options: { max: 80, min: 1, pattern: "" },
      },
      {
        type: "text",
        name: "hardwareProfile",
        required: false,
        system: false,
        options: { max: 200, min: 0, pattern: "" },
      },
      {
        type: "text",
        name: "notesIT",
        required: false,
        system: false,
        options: { max: 2000, min: 0, pattern: "" },
      },
      {
        type: "date",
        name: "createdAt",
        required: true,
        system: false,
        options: { min: "", max: "" },
      },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_hire_profiles_application_unique ON hire_profiles (applicationId)",
      "CREATE INDEX idx_hire_profiles_company ON hire_profiles (companyUserId)",
      "CREATE INDEX idx_hire_profiles_candidate ON hire_profiles (candidateUserId)",
    ],
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
    options: {},
  });

  // Force-patch to evolve existing collections safely.
  await patchApplyTokens(baseUrl, token);
  await patchCandidateProfiles(baseUrl, token);
  await patchApplications(baseUrl, token);
  await patchHireProfiles(baseUrl, token);

  console.log(
    "[bootstrap] ok: ensured user_state + profile_imports + candidate_profiles + company_profiles + listings + applications + listing_favorites + hire_profiles (patched)",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
