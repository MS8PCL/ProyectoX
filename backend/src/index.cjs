const { serve } = require("@hono/node-server");
const { Hono } = require("hono");
const { z } = require("zod");
const Redis = require("ioredis");
const {
  pbAuthWithPassword,
  pbAdminAuth,
  pbCreateUser,
  pbRequestAuthed,
} = require("./pb.cjs");

// Enterprise helpers (correlation/audit/idempotency)
const { attachCorrelation } = require("./enterprise/correlation.cjs");
const { pbAdminRequest } = require("./enterprise/pbAdmin.cjs");
const { audit, wfEvent } = require("./enterprise/audit.cjs");
const { createOrGetByUnique } = require("./enterprise/idempotency.cjs");

const env = {
  PORT: Number(process.env.PORT ?? 8787),
  // When served behind Caddy on :8787, this becomes the same-origin.
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:8787",
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? "false") === "true",

  KEYDB_URL: process.env.KEYDB_URL ?? "redis://127.0.0.1:6379",
  POCKETBASE_URL: process.env.POCKETBASE_URL ?? "http://127.0.0.1:8090",

  // Session TTL in KeyDB (cookie Max-Age matches this)
  SESSION_TTL_SECONDS: Number(
    process.env.SESSION_TTL_SECONDS ?? 60 * 60 * 24 * 30,
  ),
  PB_ADMIN_EMAIL: process.env.PB_ADMIN_EMAIL ?? "",
  PB_ADMIN_PASSWORD: process.env.PB_ADMIN_PASSWORD ?? "",
};

const redis = new Redis(env.KEYDB_URL, {
  lazyConnect: true,
  retryStrategy(times) {
    return Math.min(times * 200, 3000);
  },
});
redis.on("error", (e) => {
  console.error("[redis] error", e);
});

const app = new Hono();
attachCorrelation(app);

// CORS for local dev when not using Caddy.
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", env.WEB_ORIGIN);
  c.header("Access-Control-Allow-Credentials", "true");
  c.header("Access-Control-Allow-Headers", "content-type");
  c.header("Access-Control-Expose-Headers", "x-correlation-id");
  c.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));

function getCookie(req, name) {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  const parts = cookie.split(";").map((p) => p.trim());
  const hit = parts.find((p) => p.startsWith(`${name}=`));
  if (!hit) return null;
  return decodeURIComponent(hit.slice(name.length + 1));
}

function setSidCookie(c, sid) {
  const attrs = [
    `sid=${encodeURIComponent(sid)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    env.COOKIE_SECURE ? "Secure" : "",
    `Max-Age=${env.SESSION_TTL_SECONDS}`,
  ].filter(Boolean);
  c.header("Set-Cookie", attrs.join("; "));
}

function clearSidCookie(c) {
  const attrs = [
    "sid=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    env.COOKIE_SECURE ? "Secure" : "",
    "Max-Age=0",
  ].filter(Boolean);
  c.header("Set-Cookie", attrs.join("; "));
}

function sessKey(sid) {
  return `px:sess:${sid}`;
}

function stateKey(userId) {
  return `px:state:user:${userId}`;
}

function stateCacheKey(userId) {
  return `px:cache:state:user:${userId}`;
}

async function getSession(c) {
  const sid = getCookie(c.req.raw, "sid");
  if (!sid) return null;
  const raw = await redis.get(sessKey(sid));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function requireUser(c) {
  const sess = await getSession(c);
  if (!sess || !sess.userId) return null;
  return sess;
}

const AuthSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

app.get("/me", async (c) => {
  const sess = await getSession(c);
  if (!sess) return c.json({ user: null });
  return c.json({
    user: { id: sess.userId, email: sess.email, role: sess.role || "" },
  });
});

app.post("/auth/register", async (c) => {
  // HOTFIX: no public signup.
  return c.json(
    { error: "gone", message: "Public registration is disabled." },
    410,
  );
});

app.post("/auth/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = AuthSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  let auth;
  try {
    auth = await pbAuthWithPassword(
      env.POCKETBASE_URL,
      parsed.data.email,
      parsed.data.password,
    );
  } catch {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  // Internal-only roles: admin | rrhh | it
  const rawRole = String(
    auth.record?.corpRole || auth.record?.role || "",
  ).toUpperCase();
  const role =
    rawRole === "ADMIN"
      ? "admin"
      : rawRole === "HR" || rawRole === "RRHH"
        ? "rrhh"
        : rawRole === "IT"
          ? "it"
          : "";
  if (!role)
    return c.json(
      {
        error: "forbidden",
        message: "User is not enabled for internal access.",
      },
      403,
    );

  const sid = `sess_${crypto.randomUUID()}`;
  setSidCookie(c, sid);

  const session = {
    userId: auth.record?.id,
    email: auth.record?.email,
    role,
    pbToken: auth.token,
    createdAt: Date.now(),
  };

  await redis.set(
    sessKey(sid),
    JSON.stringify(session),
    "EX",
    env.SESSION_TTL_SECONDS,
  );

  return c.json({
    ok: true,
    user: { id: session.userId, email: session.email, role: session.role },
  });
});

app.post("/auth/logout", async (c) => {
  const sid = getCookie(c.req.raw, "sid");
  if (sid) await redis.del(sessKey(sid));
  clearSidCookie(c);
  return c.json({ ok: true });
});

// ---- Profiles (PocketBase source of truth) ----

const CandidateProfileSchema = z.object({
  fullName: z.string().min(2).max(120),
  title: z.string().min(2).max(120),
  location: z.string().min(2).max(120),
  public: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  about: z.string().max(2000).optional(),
});

const CompanyProfileSchema = z.object({
  companyName: z.string().min(2).max(120),
  sector: z.string().min(2).max(120),
  location: z.string().min(2).max(120),
});

async function getMyProfile(sess) {
  const col =
    sess.role === "company" ? "company_profiles" : "candidate_profiles";
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `userId="${sess.userId}"`,
  });
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    sess.pbToken,
    `/api/collections/${col}/records?${params.toString()}`,
  );
  return { col, record: list?.items?.[0] || null };
}

async function upsertMyProfile(sess, data) {
  const { col, record } = await getMyProfile(sess);
  const payload = { userId: sess.userId, ...data };

  if (record?.id) {
    return await pbRequestAuthed(
      env.POCKETBASE_URL,
      sess.pbToken,
      `/api/collections/${col}/records/${record.id}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  }

  return await pbRequestAuthed(
    env.POCKETBASE_URL,
    sess.pbToken,
    `/api/collections/${col}/records`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

function isProfileComplete(sess, rec) {
  if (!rec) return false;
  if (sess.role === "company") {
    return (
      !!String(rec.companyName || "").trim() &&
      !!String(rec.sector || "").trim() &&
      !!String(rec.location || "").trim()
    );
  }
  return (
    !!String(rec.fullName || "").trim() &&
    !!String(rec.title || "").trim() &&
    !!String(rec.location || "").trim()
  );
}

app.get("/profile", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  const { record } = await getMyProfile(sess);
  return c.json({ ok: true, role: sess.role || "worker", profile: record });
});

app.put("/profile", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = (
    sess.role === "company" ? CompanyProfileSchema : CandidateProfileSchema
  ).safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const updated = await upsertMyProfile(sess, parsed.data);
  return c.json({
    ok: true,
    profile: updated,
    complete: isProfileComplete(sess, updated),
  });
});

app.get("/onboarding/status", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  const { record } = await getMyProfile(sess);
  return c.json({
    ok: true,
    role: sess.role || "worker",
    complete: isProfileComplete(sess, record),
    profile: record,
  });
});

// ---- Server-side listings & applications (for multi-session demo) ----

const ListingSchema = z.object({
  kind: z.enum(["empleo", "ett", "becario"]),
  title: z.string().min(2).max(180),
  company: z.string().min(1).max(120),
  location: z.string().min(1).max(120),
  pay: z.string().max(40).optional(),
  tags: z.array(z.string()).optional(),
  desc: z.string().max(5000).optional(),
});

// adminPbToken is now provided by enterprise/pbAdmin.cjs (cached, 5 min TTL).
// Kept as a thin wrapper for callers that pass no env override.
async function adminPbToken() {
  return await require("./enterprise/pbAdmin.cjs").adminPbToken(env);
}

app.get("/listings", async (c) => {
  // public feed (no auth required)
  const params = new URLSearchParams({ perPage: "50", page: "1" });
  const token = await adminPbToken();
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/listings/records?${params.toString()}`,
  );
  return c.json({ ok: true, items: list?.items || [] });
});

app.post("/listings", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  const parsed = ListingSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const token = await adminPbToken();
  const created = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    "/api/collections/listings/records",
    {
      method: "POST",
      body: JSON.stringify({
        ownerUserId: sess.userId,
        kind: parsed.data.kind,
        title: parsed.data.title,
        company: parsed.data.company,
        location: parsed.data.location,
        pay: parsed.data.pay || "",
        tags: parsed.data.tags || [],
        desc: parsed.data.desc || "",
      }),
    },
  );

  return c.json({ ok: true, item: created });
});

app.post("/listings/:id/apply", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  // Public apply is disabled in internal-only mode.
  return c.json({ error: "gone", message: "Public apply is disabled." }, 410);

  const listingId = String(c.req.param("id") || "");
  if (!listingId) return c.json({ error: "invalid_listing" }, 400);

  const token = await adminPbToken();
  const listing = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/listings/records/${listingId}`,
  );
  const companyUserId = listing?.ownerUserId;
  if (!companyUserId) return c.json({ error: "invalid_listing" }, 400);

  // prevent duplicates
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `listingId="${listingId}" && candidateUserId="${sess.userId}"`,
  });
  const existing = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records?${params.toString()}`,
  );
  if ((existing?.items || []).length)
    return c.json({ ok: true, already: true, item: existing.items[0] });

  const created = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    "/api/collections/applications/records",
    {
      method: "POST",
      body: JSON.stringify({
        listingId,
        companyUserId,
        candidateUserId: sess.userId,
        stage: "nuevo",
        notes: "",
      }),
    },
  );

  return c.json({ ok: true, item: created });
});

app.get("/me/applications", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  return c.json(
    { error: "gone", message: "Candidate portal is disabled." },
    410,
  );

  const token = await adminPbToken();

  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    filter: `candidateUserId="${sess.userId}"`,
  });
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records?${params.toString()}`,
  );
  const items = Array.isArray(list?.items) ? list.items : [];

  const listingIds = Array.from(
    new Set(items.map((x) => x.listingId).filter(Boolean)),
  );
  const listingsById = {};
  for (const id of listingIds) {
    try {
      const l = await pbRequestAuthed(
        env.POCKETBASE_URL,
        token,
        `/api/collections/listings/records/${id}`,
      );
      listingsById[id] = l;
    } catch {
      listingsById[id] = null;
    }
  }

  const mapped = items.map((a) => ({
    id: a.id,
    listingId: a.listingId,
    companyUserId: a.companyUserId,
    candidateUserId: a.candidateUserId,
    stage: a.stage,
    status:
      a.stage === "entrevista"
        ? "entrevista"
        : a.stage === "oferta"
          ? "oferta"
          : a.stage === "descartado"
            ? "rechazado"
            : "enviado",
    notes: a.notes || "",
    createdAt: a.created ? Date.parse(a.created) : Date.now(),
  }));

  const listings = Object.fromEntries(
    listingIds
      .map((id) => {
        const l = listingsById[id];
        if (!l) return null;
        return [
          id,
          {
            id,
            kind: l.kind,
            title: l.title,
            company: l.company,
            location: l.location,
            pay: l.pay,
            tags: l.tags || [],
            desc: l.desc || "",
            createdAt: l.created ? Date.parse(l.created) : Date.now(),
            createdBy: "empresa",
            ownerUserId: l.ownerUserId || "",
          },
        ];
      })
      .filter(Boolean),
  );

  return c.json({ ok: true, items: mapped, listings });
});

// ---- Candidate listing favorites (server-side) ----

app.get("/me/favorites", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  return c.json(
    { error: "gone", message: "Candidate portal is disabled." },
    410,
  );

  const token = await adminPbToken();
  const params = new URLSearchParams({
    perPage: "500",
    page: "1",
    filter: `userId="${sess.userId}"`,
  });
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/listing_favorites/records?${params.toString()}`,
  );
  const items = Array.isArray(list?.items) ? list.items : [];
  const listingIds = items.map((x) => x.listingId).filter(Boolean);
  return c.json({ ok: true, listingIds });
});

app.post("/me/favorites/:listingId/toggle", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  return c.json(
    { error: "gone", message: "Candidate portal is disabled." },
    410,
  );

  const listingId = String(c.req.param("listingId") || "");
  if (!listingId) return c.json({ error: "invalid_listing" }, 400);

  const token = await adminPbToken();

  const p = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `userId="${sess.userId}" && listingId="${listingId}"`,
  });
  const existing = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/listing_favorites/records?${p.toString()}`,
  );
  const row = existing?.items?.[0];

  if (row?.id) {
    await pbRequestAuthed(
      env.POCKETBASE_URL,
      token,
      `/api/collections/listing_favorites/records/${row.id}`,
      { method: "DELETE" },
    );
    return c.json({ ok: true, favorited: false });
  }

  await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    "/api/collections/listing_favorites/records",
    {
      method: "POST",
      body: JSON.stringify({ userId: sess.userId, listingId }),
    },
  );

  return c.json({ ok: true, favorited: true });
});

app.get("/company/listings/:id/applications", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const listingId = String(c.req.param("id") || "");

  const token = await adminPbToken();
  await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/listings/records/${listingId}`,
  );
  // Internal RRHH/IT/Admin can view applications regardless of listing owner.

  // NOTE: archivedAt may exist in PB, but UI/ATS flow uses hard delete.
  const filter = `listingId="${listingId}"`;

  const params = new URLSearchParams({ perPage: "200", page: "1", filter });
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records?${params.toString()}`,
  );
  return c.json({ ok: true, items: list?.items || [] });
});

const UpdateApplicationSchema = z.object({
  stage: z
    .enum(["nuevo", "revisar", "entrevista", "oferta", "descartado", "hired"])
    .optional(),
  notes: z.string().max(2000).optional(),
});

app.patch("/company/applications/:id", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const appId = String(c.req.param("id") || "");
  const body = await c.req.json().catch(() => null);
  const parsed = UpdateApplicationSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const token = await adminPbToken();
  const rec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${appId}`,
  );
  // Internal RRHH/IT/Admin can update stages/notes regardless of companyUserId.

  const updated = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${appId}`,
    {
      method: "PATCH",
      body: JSON.stringify(parsed.data),
    },
  );

  return c.json({ ok: true, item: updated });
});

// Hard delete application (internal only) — irreversible
app.delete("/company/applications/:id", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const applicationId = String(c.req.param("id") || "");
  if (!applicationId) return c.json({ error: "invalid_application" }, 400);

  const token = await adminPbToken();

  // Ensure exists
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${applicationId}`,
  ).catch(() => null);
  if (!appRec?.id) return c.json({ error: "not_found" }, 404);

  // Delete related profile_imports (by applicationId TEXT)
  const safeId = applicationId.replace(/"/g, '\\"');
  const p = new URLSearchParams({
    perPage: "200",
    page: "1",
    filter: `applicationId="${safeId}"`,
  });
  const imps = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/profile_imports/records?${p.toString()}`,
  ).catch(() => null);
  const items = Array.isArray(imps?.items) ? imps.items : [];
  for (const r of items) {
    if (r?.id)
      await pbRequestAuthed(
        env.POCKETBASE_URL,
        token,
        `/api/collections/profile_imports/records/${r.id}`,
        { method: "DELETE" },
      ).catch(() => {});
  }

  // Delete related apply_tokens
  const p2 = new URLSearchParams({
    perPage: "200",
    page: "1",
    filter: `applicationId="${safeId}"`,
  });
  const toks = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/apply_tokens/records?${p2.toString()}`,
  ).catch(() => null);
  const titems = Array.isArray(toks?.items) ? toks.items : [];
  for (const r of titems) {
    if (r?.id)
      await pbRequestAuthed(
        env.POCKETBASE_URL,
        token,
        `/api/collections/apply_tokens/records/${r.id}`,
        { method: "DELETE" },
      ).catch(() => {});
  }

  // Delete application
  await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${applicationId}`,
    { method: "DELETE" },
  );

  return c.json({ ok: true });
});

app.get("/company/candidates/:candidateUserId/profile", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  // NOTE (FASE 5): applications.candidateUserId now stores the candidate_profiles RECORD ID
  // (not a userId). This endpoint returns the candidate_profiles record by id.
  const candidateProfileId = String(c.req.param("candidateUserId") || "");
  if (!candidateProfileId) return c.json({ error: "invalid_candidate" }, 400);

  const token = await adminPbToken();

  // Internal RRHH/IT/Admin: allow access if candidate appears in any application.
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `candidateUserId="${candidateProfileId}"`,
  });
  const rel = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records?${params.toString()}`,
  );
  if (!(rel?.items || []).length) return c.json({ error: "forbidden" }, 403);

  const prof = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/candidate_profiles/records/${candidateProfileId}`,
  ).catch(() => null);
  return c.json({ ok: true, profile: prof });
});

app.get("/company/candidates/:candidateUserId/cv", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const candidateUserId = String(c.req.param("candidateUserId") || "");
  if (!candidateUserId) return c.json({ error: "invalid_candidate" }, 400);

  const token = await adminPbToken();

  // Internal RRHH/IT/Admin: allow access if candidate appears in any application.
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `candidateUserId="${candidateUserId}"`,
  });
  const rel = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records?${params.toString()}`,
  );
  if (!(rel?.items || []).length) return c.json({ error: "forbidden" }, 403);

  // Return latest CV import record (docType=cv)
  const p2 = new URLSearchParams({
    perPage: "50",
    page: "1",
    filter: `userId="${candidateUserId}" && kind="document" && docType="cv"`,
  });
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/profile_imports/records?${p2.toString()}`,
  );
  const items = list?.items || [];
  const item = items.sort((a, b) =>
    String(b.created || "").localeCompare(String(a.created || "")),
  )[0];
  const fn = item?.file;
  if (!item?.id || !fn) return c.json({ ok: true, url: "" });

  const pb = env.POCKETBASE_URL.replace(/\/+$/, "");
  const url = `${pb}/api/files/profile_imports/${encodeURIComponent(item.id)}/${encodeURIComponent(fn)}`;
  return c.json({ ok: true, url });
});

async function requireCompleteProfile(c) {
  const sess = await requireUser(c);
  if (!sess)
    return { error: c.json({ error: "unauthorized" }, 401), sess: null };

  // Internal-only mode: internal roles do not require onboarding profiles.
  if (["admin", "rrhh", "it"].includes(sess.role)) {
    return { error: null, sess };
  }

  const { record } = await getMyProfile(sess);
  if (!isProfileComplete(sess, record)) {
    return { error: c.json({ error: "profile_incomplete" }, 403), sess };
  }
  return { error: null, sess };
}

// ---- App state (backend-first, per-user) ----

const PutStateSchema = z.object({
  state: z.any(),
});

app.get("/state", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;

  // 1) KeyDB cache
  const cached = await redis.get(stateCacheKey(sess.userId));
  if (cached) {
    try {
      return c.json({ state: JSON.parse(cached) });
    } catch {
      // ignore
    }
  }

  // 2) PocketBase source of truth
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `userId=\"${sess.userId}\"`,
  });

  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    sess.pbToken,
    `/api/collections/user_state/records?${params.toString()}`,
  );
  const rec = list?.items?.[0];
  const state = rec?.state ?? null;

  if (state) {
    await redis.set(
      stateCacheKey(sess.userId),
      JSON.stringify(state),
      "EX",
      60 * 10,
    );
  }

  return c.json({ state });
});

app.put("/state", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;

  const body = await c.req.json().catch(() => null);
  const parsed = PutStateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  // Upsert into PocketBase
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `userId=\"${sess.userId}\"`,
  });

  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    sess.pbToken,
    `/api/collections/user_state/records?${params.toString()}`,
  );
  const rec = list?.items?.[0];

  const payload = { userId: sess.userId, state: parsed.data.state };

  if (rec?.id) {
    await pbRequestAuthed(
      env.POCKETBASE_URL,
      sess.pbToken,
      `/api/collections/user_state/records/${rec.id}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );
  } else {
    await pbRequestAuthed(
      env.POCKETBASE_URL,
      sess.pbToken,
      "/api/collections/user_state/records",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
  }

  // Update cache (10 min)
  await redis.set(
    stateCacheKey(sess.userId),
    JSON.stringify(parsed.data.state),
    "EX",
    60 * 10,
  );

  return c.json({ ok: true });
});

// ---- Profile imports (PocketBase storage; backend-only) ----

const ImportLinkSchema = z.object({
  kind: z.enum(["portfolio", "behance", "dribbble"]),
  url: z.string().url(),
});

app.get("/profile/imports", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const perPage = 50;
  const params = new URLSearchParams({
    perPage: String(perPage),
    page: "1",
    filter: `userId="${sess.userId}"`,
  });
  const url = `/api/collections/profile_imports/records?${params.toString()}`;

  const res = await pbRequestAuthed(env.POCKETBASE_URL, sess.pbToken, url);
  return c.json({ items: res?.items || [] });
});

app.post("/profile/imports/link", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json().catch(() => null);
  const parsed = ImportLinkSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const consentText =
    "He revisado y apruebo importar y almacenar estos datos en mi cuenta.";

  const created = await pbRequestAuthed(
    env.POCKETBASE_URL,
    sess.pbToken,
    "/api/collections/profile_imports/records",
    {
      method: "POST",
      body: JSON.stringify({
        userId: sess.userId,
        kind: parsed.data.kind,
        url: parsed.data.url,
        consentText,
      }),
    },
  );

  return c.json({ ok: true, item: created });
});

const ImportFileSchema = z.object({
  docType: z.enum(["cv", "certificate", "portfolio", "linkedin", "other"]),
});

app.post("/profile/imports/file", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.parseBody().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const docType = body.docType;
  const parsed = ImportFileSchema.safeParse({ docType });
  if (!parsed.success) return c.json({ error: "invalid_body" }, 400);

  const file = body.file;
  if (!file) return c.json({ error: "missing_file" }, 400);

  // Hono parseBody may return a File/Blob-like object.
  const isFileLike =
    typeof file === "object" && file && typeof file.arrayBuffer === "function";
  if (!isFileLike) {
    return c.json(
      { error: "invalid_file", hint: 'Expected multipart file field "file".' },
      400,
    );
  }

  const consentText =
    "He revisado y apruebo importar y almacenar estos datos en mi cuenta.";

  const fd = new FormData();
  fd.set("userId", sess.userId);
  fd.set("kind", "document");
  fd.set("docType", parsed.data.docType);
  fd.set("consentText", consentText);
  const filename =
    typeof file.name === "string" && file.name
      ? file.name
      : `upload-${parsed.data.docType}.pdf`;
  fd.set("file", file, filename);

  const url = `${env.POCKETBASE_URL.replace(/\/+$/, "")}/api/collections/profile_imports/records`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${sess.pbToken}` },
    body: fd,
  });

  const text = await r.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!r.ok)
    return c.json(
      {
        error: "pb_upload_failed",
        status: r.status,
        body: json || text,
        debug: {
          docType: parsed.data.docType,
          filename,
          size: typeof file.size === "number" ? file.size : null,
          type: typeof file.type === "string" ? file.type : null,
        },
      },
      400,
    );

  return c.json({ ok: true, item: json });
});

// ---- Workflow engine (enterprise, MVP) ----

async function getWorkflowInstance(id) {
  return await pbAdminRequest(
    env,
    `/api/collections/workflow_instances/records/${id}`,
  );
}

async function findTransition(defId, fromKey, toKey) {
  const filter = encodeURIComponent(
    `workflow_definition="${defId}" && from_state_key="${fromKey}" && to_state_key="${toKey}"`,
  );
  const params = new URLSearchParams({ perPage: "1", page: "1", filter });
  const res = await pbAdminRequest(
    env,
    `/api/collections/workflow_transitions/records?${params.toString()}`,
  );
  return (res?.items || [])[0] || null;
}

async function getState(defId, stateKey) {
  const filter = encodeURIComponent(
    `workflow_definition="${defId}" && state_key="${stateKey}"`,
  );
  const params = new URLSearchParams({ perPage: "1", page: "1", filter });
  const res = await pbAdminRequest(
    env,
    `/api/collections/workflow_states/records?${params.toString()}`,
  );
  return (res?.items || [])[0] || null;
}

function normalizeGuardList(guards) {
  if (!guards) return [];
  if (Array.isArray(guards)) return guards.map(String);
  if (Array.isArray(guards.all)) return guards.all.map(String);
  return [];
}

async function latestPermissionPreview(entityType, entityId) {
  const filter = encodeURIComponent(
    `entity_type="${entityType}" && entity_id="${String(entityId).replace(/"/g, '\\"')}"`,
  );
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    sort: "-computed_at",
    filter,
  });
  const res = await pbAdminRequest(
    env,
    `/api/collections/permission_previews/records?${params.toString()}`,
  );
  return (res?.items || [])[0] || null;
}

async function latestApprovalInstance(entityType, entityId) {
  const filter = encodeURIComponent(
    `entity_type="${entityType}" && entity_id="${String(entityId).replace(/"/g, '\\"')}"`,
  );
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    sort: "-created_at",
    filter,
  });
  const res = await pbAdminRequest(
    env,
    `/api/collections/approval_instances/records?${params.toString()}`,
  );
  return (res?.items || [])[0] || null;
}

async function evalGuards(guards, ctx) {
  const failures = [];
  const list = normalizeGuardList(guards);

  for (const g of list) {
    if (g === "permission_preview_exists") {
      const prev = await latestPermissionPreview(ctx.entityType, ctx.entityId);
      if (!prev)
        failures.push({ guard: g, error: "missing_permission_preview" });
      continue;
    }

    if (g === "approvals_completed") {
      const a = await latestApprovalInstance(ctx.entityType, ctx.entityId);
      if (a && a.status !== "approved")
        failures.push({
          guard: g,
          error: "approvals_not_approved",
          status: a.status,
        });
      continue;
    }

    if (g === "hire_profile_complete") {
      // MVP heuristic: require that the latest permission preview inputs include key attributes.
      const prev = await latestPermissionPreview(ctx.entityType, ctx.entityId);
      const snap = prev?.inputs_snapshot || {};
      const ok =
        !!normStr(snap.departmentKey) &&
        !!normStr(snap.jobTitleKey) &&
        !!normStr(snap.costCenterKey);
      if (!ok)
        failures.push({
          guard: g,
          error: "hire_profile_incomplete",
          required: ["departmentKey", "jobTitleKey", "costCenterKey"],
        });
      continue;
    }

    // Unknown guard => fail safe
    failures.push({ guard: g, error: "unknown_guard" });
  }

  return { ok: failures.length === 0, failures };
}

app.post("/wf/transition", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const workflowInstanceId = normStr(body.workflowInstanceId);
  const toStateKey = normStr(body.toStateKey);
  if (!workflowInstanceId || !toStateKey)
    return c.json({ error: "missing_fields" }, 400);

  const correlationId = c.get("correlationId");

  const inst = await getWorkflowInstance(workflowInstanceId);
  const defId = inst.workflow_definition;
  const fromStateKey = inst.current_state_key;

  await wfEvent(env, {
    workflowInstanceId,
    eventType: "transition_requested",
    fromStateKey,
    toStateKey,
    payload: { by: sess.userId },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  const transition = await findTransition(defId, fromStateKey, toStateKey);
  if (!transition) {
    await wfEvent(env, {
      workflowInstanceId,
      eventType: "validation_failed",
      fromStateKey,
      toStateKey,
      payload: { error: "invalid_transition" },
      actorType: "user",
      actorUserId: sess.userId,
      correlationId,
    });
    return c.json({ error: "invalid_transition" }, 400);
  }

  const ctx = { entityType: inst.entity_type, entityId: inst.entity_id };
  const guardRes = await evalGuards(transition.guards, ctx);
  if (!guardRes.ok) {
    await wfEvent(env, {
      workflowInstanceId,
      eventType: "validation_failed",
      fromStateKey,
      toStateKey,
      payload: { error: "guard_failed", failures: guardRes.failures },
      actorType: "user",
      actorUserId: sess.userId,
      correlationId,
    });

    await audit(env, {
      entityType: ctx.entityType,
      entityId: ctx.entityId,
      action: "workflow_transition_failed",
      before: { from: fromStateKey },
      after: { to: toStateKey, failures: guardRes.failures },
      actorType: "user",
      actorUserId: sess.userId,
      correlationId,
    });

    return c.json({ error: "guard_failed", failures: guardRes.failures }, 403);
  }

  const toState = await getState(defId, toStateKey);
  const isTerminal = toState?.kind === "terminal";

  const updated = await pbAdminRequest(
    env,
    `/api/collections/workflow_instances/records/${workflowInstanceId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        current_state_key: toStateKey,
        status: isTerminal ? "completed" : inst.status,
        correlation_id: correlationId,
      }),
    },
  );

  await wfEvent(env, {
    workflowInstanceId,
    eventType: "transitioned",
    fromStateKey,
    toStateKey,
    payload: { transitionId: transition.id },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  await audit(env, {
    entityType: ctx.entityType,
    entityId: ctx.entityId,
    action: "workflow_transition_succeeded",
    before: { from: fromStateKey },
    after: { to: toStateKey, workflowInstanceId },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  return c.json({ ok: true, workflowInstance: updated });
});

// ---- Outbox + OTRS manual export (enterprise) ----

function idempotencyKeyFor({
  entityType,
  entityId,
  kind,
  workflowKey,
  workflowVersion,
}) {
  return `${entityType}/${entityId}::${kind}::wf=${workflowKey}@${workflowVersion}`;
}

async function buildOtrsExportBlob({ entityType, entityId, workflowInstance }) {
  const preview = await latestPermissionPreview(entityType, entityId);
  const approval = await latestApprovalInstance(entityType, entityId);
  const entitlements = preview?.entitlements || [];
  const accessProfiles = preview?.access_profiles || [];

  return {
    instructions: [
      "Manual export mode: copia/pega este payload en OTRS (o en el proceso manual equivalente).",
      "Este sistema NO provisiona AD/IAM: solo declara entitlements deseados y solicita ejecución vía ticket.",
    ],
    entity: { entityType, entityId },
    workflow: {
      instanceId: workflowInstance?.id,
      pinned: {
        key: workflowInstance?.workflow_key,
        version: workflowInstance?.workflow_version,
      },
      state: workflowInstance?.current_state_key,
    },
    approvals: approval
      ? {
          id: approval.id,
          status: approval.status,
          policy: {
            key: approval.policy_key,
            version: approval.policy_version,
          },
        }
      : { status: "none" },
    access: {
      previewId: preview?.id || null,
      inputs: preview?.inputs_snapshot || {},
      accessProfiles,
      entitlements,
      totals: {
        accessProfiles: accessProfiles.length,
        entitlements: entitlements.length,
      },
    },
    ticketTemplate: {
      title: `Provisioning request for ${entityType}:${entityId}`,
      queue: "IT::Access",
      priority: "3 normal",
      body: {
        entityType,
        entityId,
        accessProfiles,
        entitlements,
        approvals: approval ? { status: approval.status } : null,
      },
    },
  };
}

app.post("/outbox/enqueue/otrs_create_ticket", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const entityType = body.entityType || "hire";
  const entityId = normStr(body.entityId);
  const workflowInstanceId = normStr(body.workflowInstanceId);
  if (!entityId || !workflowInstanceId)
    return c.json({ error: "missing_fields" }, 400);

  const correlationId = c.get("correlationId");
  const inst = await getWorkflowInstance(workflowInstanceId);

  const kind = "otrs_create_ticket";
  const idem = idempotencyKeyFor({
    entityType,
    entityId,
    kind,
    workflowKey: inst.workflow_key,
    workflowVersion: inst.workflow_version,
  });

  const exportBlob = await buildOtrsExportBlob({
    entityType,
    entityId,
    workflowInstance: inst,
  });

  const createBody = {
    kind,
    entity_type: entityType,
    entity_id: entityId,
    pinned_workflow_key: inst.workflow_key,
    pinned_workflow_version: inst.workflow_version,
    idempotency_key: idem,
    payload: {
      mode: "manual_export",
      entityType,
      entityId,
      workflowInstanceId,
    },
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
    correlation_id: correlationId,
    export_blob: exportBlob,
  };

  const res = await createOrGetByUnique(env, {
    collection: "integration_outbox",
    uniqueField: "idempotency_key",
    uniqueValue: idem,
    createBody,
  });

  await wfEvent(env, {
    workflowInstanceId,
    eventType: "action_enqueued",
    fromStateKey: inst.current_state_key,
    toStateKey: inst.current_state_key,
    payload: {
      kind,
      outboxId: res.record?.id,
      idempotencyKey: idem,
      created: res.created,
    },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  await audit(env, {
    entityType,
    entityId,
    action: "outbox_enqueued",
    before: null,
    after: {
      outboxId: res.record?.id,
      kind,
      idempotencyKey: idem,
      created: res.created,
    },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  return c.json({ ok: true, created: res.created, outbox: res.record });
});

app.get("/enterprise/catalog/items", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  const type = normStr(c.req.query("type") || "");
  const filter = type
    ? encodeURIComponent(`type="${type.replace(/"/g, '\\"')}"`)
    : "";
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    sort: "+key",
  });
  if (filter) params.set("filter", filter);
  const res = await pbAdminRequest(
    env,
    `/api/collections/catalog_items/records?${params.toString()}`,
  );
  return c.json({ ok: true, items: res?.items || [] });
});

app.get("/enterprise/rbac/rules", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    sort: "+priority,+created",
  });
  const res = await pbAdminRequest(
    env,
    `/api/collections/rbac_rules/records?${params.toString()}`,
  );
  return c.json({ ok: true, items: res?.items || [] });
});

app.get("/enterprise/outbox", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  const status = normStr(c.req.query("status") || "");
  const filter = status ? `status="${status.replace(/"/g, '\\"')}"` : "";
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    sort: "-created_at",
  });
  if (filter) params.set("filter", filter);
  const res = await pbAdminRequest(
    env,
    `/api/collections/integration_outbox/records?${params.toString()}`,
  );
  return c.json({ ok: true, items: res?.items || [] });
});

// ---- FASE 5: Apply público por link (single-use + expiración obligatoria) ----

const crypto = require("node:crypto");

function sha256Hex(s) {
  return crypto
    .createHash("sha256")
    .update(String(s || ""), "utf8")
    .digest("hex");
}

function randToken() {
  // URL-safe
  return crypto.randomBytes(24).toString("base64url");
}

function isAllowedDocMime(m) {
  return [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ].includes(String(m || ""));
}

async function findApplyTokenByHash(env, adminToken, tokenHash) {
  const safe = String(tokenHash || "").replace(/"/g, '\\"');
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `tokenHash="${safe}"`,
  });
  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/apply_tokens/records?${params.toString()}`,
  );
  return (res?.items || [])[0] || null;
}

app.get("/interno/applications/:id/apply_tokens", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const applicationId = normStr(c.req.param("id"));
  if (!applicationId) return c.json({ error: "invalid_application" }, 400);

  const adminToken = await adminPbToken();
  const safeId = String(applicationId).replace(/"/g, '\\"');
  const params = new URLSearchParams({
    perPage: "50",
    page: "1",
    sort: "-created",
    filter: `applicationId="${safeId}"`,
  });
  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/apply_tokens/records?${params.toString()}`,
  ).catch(() => null);

  return c.json({ ok: true, items: res?.items || [] });
});

app.post("/interno/apply_tokens", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const Schema = z.object({
    applicationId: z.string().min(1),
    expiresAt: z.string().min(10),
  });

  const body = await c.req.json().catch(() => null);
  const parsed = Schema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const applicationId = normStr(parsed.data.applicationId);
  const exp = new Date(parsed.data.expiresAt);
  const expMs = exp.getTime();
  const nowMs = Date.now();
  if (!applicationId || !Number.isFinite(expMs)) {
    return c.json(
      { error: "invalid_expiresAt", message: "expiresAt obligatorio" },
      400,
    );
  }

  // Range: 7–30 days (inclusive)
  const minMs = nowMs + 7 * 24 * 3600 * 1000;
  const maxMs = nowMs + 30 * 24 * 3600 * 1000;
  if (expMs < minMs || expMs > maxMs) {
    return c.json(
      {
        error: "invalid_expiration_range",
        message: "expiresAt debe estar entre 7 y 30 días",
      },
      400,
    );
  }

  const adminToken = await adminPbToken();
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records/${applicationId}`,
  );
  if (!appRec?.id) return c.json({ error: "invalid_application" }, 400);

  const tokenPlain = randToken();
  const tokenHash = sha256Hex(tokenPlain);
  const nowIso = new Date().toISOString();

  const rec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/apply_tokens/records`,
    {
      method: "POST",
      body: JSON.stringify({
        applicationId,
        jobId: appRec.listingId || "",
        tokenHash,
        expiresAt: exp.toISOString(),
        active: true,
        usedAt: null,
        usedByEmail: "",
        createdAt: nowIso,
        createdByUserId: sess.userId,
      }),
    },
  );

  return c.json({
    ok: true,
    applyUrl: `/apply/${tokenPlain}`,
    expiresAt: exp.toISOString(),
    tokenId: rec?.id || "",
  });
});

app.get("/apply/:token", async (c) => {
  const tokenPlain = normStr(c.req.param("token"));
  if (!tokenPlain) return c.json({ error: "not_found" }, 404);

  const adminToken = await adminPbToken();
  const tokenHash = sha256Hex(tokenPlain);
  const rec = await findApplyTokenByHash(env, adminToken, tokenHash);
  if (!rec?.id) return c.json({ error: "not_found" }, 404);

  if (!rec.active || rec.usedAt)
    return c.json(
      { error: "token_used", message: "Este link ya fue usado." },
      409,
    );

  const expMs = Date.parse(String(rec.expiresAt || ""));
  if (Number.isFinite(expMs) && Date.now() > expMs)
    return c.json(
      { error: "token_expired", message: "Este link ha caducado." },
      410,
    );

  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records/${rec.applicationId}`,
  );
  const listing = appRec?.listingId
    ? await pbRequestAuthed(
        env.POCKETBASE_URL,
        adminToken,
        `/api/collections/listings/records/${appRec.listingId}`,
      ).catch(() => null)
    : null;

  return c.json({
    ok: true,
    applicationId: rec.applicationId,
    expiresAt: rec.expiresAt,
    listing: listing
      ? {
          id: listing.id,
          title: listing.title,
          company: listing.company,
          location: listing.location,
          pay: listing.pay,
        }
      : null,
  });
});

app.post("/public/apply/:token", async (c) => {
  const tokenPlain = normStr(c.req.param("token"));
  if (!tokenPlain) return c.json({ error: "not_found" }, 404);

  const body = await c.req.parseBody().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const Schema = z.object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(120),
    email: z.string().email().max(120),
    birthDate: z.string().min(4),
    coverLetter: z.string().min(1).max(5000),
  });

  const parsed = Schema.safeParse({
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    birthDate: body.birthDate,
    coverLetter: body.coverLetter,
  });
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const cv = body.cv;
  if (!cv || typeof cv !== "object" || typeof cv.arrayBuffer !== "function")
    return c.json({ error: "missing_cv" }, 400);
  // Limit: 50MB per file (FASE 5 refinement)
  if (typeof cv.size === "number" && cv.size > 50 * 1024 * 1024)
    return c.json({ error: "cv_too_large" }, 400);
  if (!isAllowedDocMime(cv.type))
    return c.json({ error: "invalid_cv_mime" }, 400);

  const certsRaw = body.certificates;
  const certs = Array.isArray(certsRaw) ? certsRaw : certsRaw ? [certsRaw] : [];
  for (const f of certs) {
    if (!f || typeof f !== "object" || typeof f.arrayBuffer !== "function")
      return c.json({ error: "invalid_certificate" }, 400);
    // Limit: 50MB per file (FASE 5 refinement)
    if (typeof f.size === "number" && f.size > 50 * 1024 * 1024)
      return c.json({ error: "certificate_too_large" }, 400);
    if (!isAllowedDocMime(f.type))
      return c.json({ error: "invalid_certificate_mime" }, 400);
  }

  const adminToken = await adminPbToken();
  const tokenHash = sha256Hex(tokenPlain);
  const rec = await findApplyTokenByHash(env, adminToken, tokenHash);
  if (!rec?.id) return c.json({ error: "not_found" }, 404);
  if (!rec.active || rec.usedAt)
    return c.json(
      { error: "token_used", message: "Este link ya fue usado." },
      409,
    );

  const expMs = Date.parse(String(rec.expiresAt || ""));
  if (Number.isFinite(expMs) && Date.now() > expMs)
    return c.json(
      { error: "token_expired", message: "Este link ha caducado." },
      410,
    );

  const applicationId = normStr(rec.applicationId);
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records/${applicationId}`,
  );
  if (!appRec?.id) return c.json({ error: "invalid_application" }, 400);

  const email = String(parsed.data.email).trim().toLowerCase();

  // candidate profile upsert by email
  const safeEmail = email.replace(/"/g, '\\"');
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `email="${safeEmail}"`,
  });
  const candList = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/candidate_profiles/records?${params.toString()}`,
  );
  const existing = (candList?.items || [])[0] || null;

  const fullName = `${parsed.data.firstName} ${parsed.data.lastName}`.trim();
  let candId = "";
  if (existing?.id) {
    const updated = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/candidate_profiles/records/${existing.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          email,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          fullName,
        }),
      },
    );
    candId = updated?.id || existing.id;
  } else {
    const created = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/candidate_profiles/records`,
      {
        method: "POST",
        body: JSON.stringify({
          userId: "",
          email,
          firstName: parsed.data.firstName,
          lastName: parsed.data.lastName,
          fullName,
          title: "",
          location: "",
          public: false,
          skills: [],
          about: "",
        }),
      },
    );
    candId = created?.id || "";
  }

  // Update target application
  await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records/${applicationId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        candidateUserId: candId,
        birthDate: new Date(parsed.data.birthDate).toISOString(),
        coverLetter: parsed.data.coverLetter,
      }),
    },
  );

  async function uploadProfileImport(file, docType) {
    const fd = new FormData();
    fd.set("userId", candId);
    fd.set("applicationId", applicationId);
    fd.set("kind", "document");
    fd.set("docType", docType);
    fd.set("consentText", "Public apply: consent");
    const filename =
      typeof file.name === "string" && file.name
        ? file.name
        : `upload-${docType}.bin`;
    fd.set("file", file, filename);
    const url = `${env.POCKETBASE_URL.replace(/\/+$/, "")}/api/collections/profile_imports/records`;
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: fd,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) return { ok: false, status: r.status, body: text };
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    return { ok: true, item: json };
  }

  const upCv = await uploadProfileImport(cv, "cv");
  if (!upCv.ok) return c.json({ error: "cv_upload_failed", detail: upCv }, 400);
  for (const f of certs) {
    const up = await uploadProfileImport(f, "certificate");
    if (!up.ok)
      return c.json({ error: "certificate_upload_failed", detail: up }, 400);
  }

  const nowIso = new Date().toISOString();
  await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/apply_tokens/records/${rec.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        active: false,
        usedAt: nowIso,
        usedByEmail: email,
      }),
    },
  );

  return c.json({ ok: true, message: "Solicitud enviada correctamente" });
});

// ---- FASE 5: Export candidatura completa (ZIP) ----

// List documents for an application (internal)
app.get("/interno/applications/:id/documents", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const applicationId = normStr(c.req.param("id"));
  if (!applicationId) return c.json({ error: "invalid_application" }, 400);

  const adminToken = await adminPbToken();
  // ensure app exists
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records/${applicationId}`,
  ).catch(() => null);
  if (!appRec?.id) return c.json({ error: "not_found" }, 404);

  const safeId = applicationId.replace(/"/g, '\\"');
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    filter: `applicationId="${safeId}"`,
  });
  const imports = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/profile_imports/records?${params.toString()}`,
  ).catch(() => null);
  const items = Array.isArray(imports?.items) ? imports.items : [];

  return c.json({
    ok: true,
    items: items.map((r) => ({
      id: r.id,
      docType: r.docType,
      file: r.file,
      created: r.created,
    })),
  });
});

// Download a specific profile_imports file via API proxy (no direct PB URL exposure)
app.get("/interno/applications/:appId/documents/:importId", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const applicationId = normStr(c.req.param("appId"));
  const importId = normStr(c.req.param("importId"));
  if (!applicationId || !importId)
    return c.json({ error: "invalid_request" }, 400);

  const adminToken = await adminPbToken();

  // ensure record belongs to application
  const rec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/profile_imports/records/${importId}`,
  ).catch(() => null);
  if (!rec?.id) return c.json({ error: "not_found" }, 404);
  if (normStr(rec.applicationId) !== applicationId)
    return c.json({ error: "forbidden" }, 403);

  const fileName = normStr(rec.file);
  if (!fileName) return c.json({ error: "missing_file" }, 400);

  const pbBase = env.POCKETBASE_URL.replace(/\/+$/, "");
  const url = `${pbBase}/api/files/profile_imports/${rec.id}/${encodeURIComponent(fileName)}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!r.ok) return c.json({ error: "download_failed" }, 502);

  const ct = r.headers.get("content-type") || "application/octet-stream";
  c.header("content-type", ct);
  c.header("cache-control", "no-store");
  c.header(
    "content-disposition",
    `inline; filename="${fileName.replace(/"/g, "")}"`,
  );
  return c.body(r.body);
});

app.get("/interno/applications/:id/export.zip", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const applicationId = normStr(c.req.param("id"));
  if (!applicationId) return c.json({ error: "invalid_application" }, 400);

  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const { spawn } = require("node:child_process");

  function sha256Buf(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  async function sha256File(filePath) {
    const buf = await fsp.readFile(filePath);
    return sha256Buf(buf);
  }

  async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  function runZip(cwd, outZipName) {
    return new Promise((resolve, reject) => {
      const p = spawn("zip", ["-r", outZipName, "."], { cwd });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => {
        if (code === 0) return resolve({ out, err });
        reject(new Error(`zip failed (${code}): ${err || out}`));
      });
    });
  }

  const adminToken = await adminPbToken();

  // 1) Load application + candidate
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records/${applicationId}`,
  ).catch(() => null);
  if (!appRec?.id) return c.json({ error: "not_found" }, 404);

  const candId = normStr(appRec.candidateUserId);
  const candRec = candId
    ? await pbRequestAuthed(
        env.POCKETBASE_URL,
        adminToken,
        `/api/collections/candidate_profiles/records/${candId}`,
      ).catch(() => null)
    : null;

  // 2) Load documents linked by profile_imports.applicationId == :id
  const safeId = applicationId.replace(/"/g, '\\"');
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    filter: `applicationId="${safeId}"`,
  });
  const imports = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/profile_imports/records?${params.toString()}`,
  ).catch(() => null);
  const items = Array.isArray(imports?.items) ? imports.items : [];

  // 3) Build export folder
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "Z");
  const baseDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `px-export-${applicationId}-`),
  );
  const workDir = path.join(baseDir, `application_${applicationId}_${stamp}`);
  const docsDir = path.join(workDir, "documents");
  const certDir = path.join(docsDir, "certificates");
  await ensureDir(certDir);

  const applicationJsonPath = path.join(workDir, "application.json");
  const candidateJsonPath = path.join(workDir, "candidate.json");
  await fsp.writeFile(
    applicationJsonPath,
    JSON.stringify(appRec, null, 2) + "\n",
    "utf8",
  );
  await fsp.writeFile(
    candidateJsonPath,
    JSON.stringify(candRec || null, null, 2) + "\n",
    "utf8",
  );

  // Download file helper
  async function downloadImportFile(rec, outPath) {
    const fileName = normStr(rec.file);
    if (!fileName) return false;
    const pbBase = env.POCKETBASE_URL.replace(/\/+$/, "");
    const url = `${pbBase}/api/files/profile_imports/${rec.id}/${encodeURIComponent(fileName)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!r.ok) throw new Error(`download failed ${r.status}`);
    const ab = await r.arrayBuffer();
    await fsp.writeFile(outPath, Buffer.from(ab));
    return true;
  }

  // Stable naming (human-friendly)
  // - CV: documents/cv.<ext> (and cv-02.<ext> if multiple)
  // - Certificates: documents/certificates/<originalName>
  function extOf(file) {
    const f = normStr(file);
    const m = f.match(/\.(\w{1,8})$/);
    return m ? m[1].toLowerCase() : "bin";
  }

  let cvN = 0;
  let certN = 0;
  const manifest = [];

  for (const rec of items) {
    const docType = normStr(rec.docType);
    const ext = extOf(rec.file);
    if (docType === "cv") {
      cvN += 1;
      const outName =
        cvN === 1 ? `cv.${ext}` : `cv-${String(cvN).padStart(2, "0")}.${ext}`;
      const outPath = path.join(docsDir, outName);
      await downloadImportFile(rec, outPath);
      manifest.push({
        path: `documents/${outName}`,
        docType,
        importId: rec.id,
        pbFile: rec.file,
      });
    } else if (docType === "certificate") {
      certN += 1;
      const baseName =
        normStr(rec.file) ||
        `certificate-${String(certN).padStart(2, "0")}.${ext}`;
      const safeBase = baseName.replace(/[^a-zA-Z0-9._-]+/g, "_");
      const outName = safeBase;
      const outPath = path.join(certDir, outName);
      await downloadImportFile(rec, outPath);
      manifest.push({
        path: `documents/certificates/${outName}`,
        docType,
        importId: rec.id,
        pbFile: rec.file,
      });
    }
  }

  const readme = [
    `Proyecto X – Export candidatura`,
    `applicationId: ${applicationId}`,
    `exportedAt: ${new Date().toISOString()}`,
    `docs: ${manifest.length}`,
    ``,
    `Document mapping (PocketBase -> ZIP):`,
    ...manifest.map(
      (m) =>
        `- ${m.path}  (docType=${m.docType}, profile_imports.id=${m.importId}, file=${m.pbFile})`,
    ),
    ``,
  ].join("\n");
  await fsp.writeFile(path.join(workDir, "README.txt"), readme, "utf8");

  // checksums
  const checksumLines = [];
  checksumLines.push(
    `${await sha256File(applicationJsonPath)}  application.json`,
  );
  checksumLines.push(`${await sha256File(candidateJsonPath)}  candidate.json`);
  for (const m of manifest) {
    const fp = path.join(workDir, m.path);
    checksumLines.push(`${await sha256File(fp)}  ${m.path}`);
  }
  await fsp.writeFile(
    path.join(workDir, "checksums.txt"),
    checksumLines.join("\n") + "\n",
    "utf8",
  );

  // ZIP
  const zipPath = path.join(baseDir, `application_${applicationId}_export.zip`);
  await runZip(workDir, zipPath);

  // Stream ZIP (avoid loading whole file into memory)
  c.header("content-type", "application/zip");
  c.header(
    "content-disposition",
    `attachment; filename="application_${applicationId}_export.zip"`,
  );
  c.header("cache-control", "no-store");

  const stream = fs.createReadStream(zipPath);
  stream.on("close", async () => {
    // cleanup best-effort
    try {
      await fsp.rm(baseDir, { recursive: true, force: true });
    } catch {}
  });

  return c.body(stream);
});

// ---- FASE 5: Export por listing (ZIP) ----

app.get("/interno/listings/:id/export.zip", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const listingId = normStr(c.req.param("id"));
  if (!listingId) return c.json({ error: "invalid_listing" }, 400);

  const fs = require("node:fs");
  const fsp = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const { spawn } = require("node:child_process");

  function sha256Buf(buf) {
    return crypto.createHash("sha256").update(buf).digest("hex");
  }

  async function sha256File(filePath) {
    const buf = await fsp.readFile(filePath);
    return sha256Buf(buf);
  }

  async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  function runZip(cwd, outZipName) {
    return new Promise((resolve, reject) => {
      const p = spawn("zip", ["-r", outZipName, "."], { cwd });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => {
        if (code === 0) return resolve({ out, err });
        reject(new Error(`zip failed (${code}): ${err || out}`));
      });
    });
  }

  function normCsv(v) {
    const s = String(v ?? "");
    // Basic CSV escaping
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function extOf(file) {
    const f = normStr(file);
    const m = f.match(/\.(\w{1,8})$/);
    return m ? m[1].toLowerCase() : "bin";
  }

  async function downloadImportFile(adminToken, rec, outPath) {
    const fileName = normStr(rec.file);
    if (!fileName) return false;
    const pbBase = env.POCKETBASE_URL.replace(/\/+$/, "");
    const url = `${pbBase}/api/files/profile_imports/${rec.id}/${encodeURIComponent(fileName)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!r.ok) throw new Error(`download failed ${r.status}`);
    const ab = await r.arrayBuffer();
    await fsp.writeFile(outPath, Buffer.from(ab));
    return true;
  }

  const adminToken = await adminPbToken();

  // Ensure listing exists
  const listing = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/listings/records/${listingId}`,
  ).catch(() => null);
  if (!listing?.id) return c.json({ error: "not_found" }, 404);

  // Load applications
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    filter: `listingId="${listingId.replace(/"/g, '\\"')}"`,
  });
  const list = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/applications/records?${params.toString()}`,
  );
  const apps = Array.isArray(list?.items) ? list.items : [];

  // Build export folder
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .replace("Z", "Z");
  const baseDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `px-export-listing-${listingId}-`),
  );
  const workDir = path.join(baseDir, `listing_${listingId}_${stamp}`);
  const docsDir = path.join(workDir, "documents");
  await ensureDir(docsDir);

  // Preload candidate profiles map
  const candCache = {};
  async function getCandidate(candId) {
    const id = normStr(candId);
    if (!id) return null;
    if (candCache[id] !== undefined) return candCache[id];
    const rec = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/candidate_profiles/records/${id}`,
    ).catch(() => null);
    candCache[id] = rec || null;
    return candCache[id];
  }

  // CSV header
  const csvLines = [];
  csvLines.push(
    [
      "applicationId",
      "stage",
      "firstName",
      "lastName",
      "email",
      "birthDate",
      "coverLetter",
    ]
      .map(normCsv)
      .join(","),
  );

  const manifest = [];

  for (const appRec of apps) {
    const appId = normStr(appRec.id);
    const cand = await getCandidate(appRec.candidateUserId);

    csvLines.push(
      [
        appId,
        normStr(appRec.stage),
        normStr(cand?.firstName),
        normStr(cand?.lastName),
        normStr(cand?.email),
        String(appRec.birthDate || "").slice(0, 10),
        normStr(appRec.coverLetter),
      ]
        .map(normCsv)
        .join(","),
    );

    // Load documents linked by applicationId
    const safeId = appId.replace(/"/g, '\\"');
    const p2 = new URLSearchParams({
      perPage: "200",
      page: "1",
      filter: `applicationId="${safeId}"`,
    });
    const imports = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/profile_imports/records?${p2.toString()}`,
    ).catch(() => null);
    const items = Array.isArray(imports?.items) ? imports.items : [];

    // Folder per application
    const appDocsDir = path.join(docsDir, appId);
    const certDir = path.join(appDocsDir, "certificates");
    await ensureDir(certDir);

    let cvN = 0;
    let certN = 0;
    for (const rec of items) {
      const docType = normStr(rec.docType);
      const ext = extOf(rec.file);
      if (docType === "cv") {
        cvN += 1;
        const outName =
          cvN === 1 ? `cv.${ext}` : `cv-${String(cvN).padStart(2, "0")}.${ext}`;
        const outPath = path.join(appDocsDir, outName);
        await downloadImportFile(adminToken, rec, outPath);
        manifest.push({
          path: `documents/${appId}/${outName}`,
          importId: rec.id,
          docType,
          pbFile: rec.file,
        });
      } else if (docType === "certificate") {
        certN += 1;
        const baseName =
          normStr(rec.file) ||
          `certificate-${String(certN).padStart(2, "0")}.${ext}`;
        const safeBase = baseName.replace(/[^a-zA-Z0-9._-]+/g, "_");
        const outName = safeBase;
        const outPath = path.join(certDir, outName);
        await downloadImportFile(adminToken, rec, outPath);
        manifest.push({
          path: `documents/${appId}/certificates/${outName}`,
          importId: rec.id,
          docType,
          pbFile: rec.file,
        });
      }
    }
  }

  const csvPath = path.join(workDir, "candidates.csv");
  await fsp.writeFile(csvPath, csvLines.join("\n") + "\n", "utf8");

  // checksums
  const checksumLines = [];
  checksumLines.push(`${await sha256File(csvPath)}  candidates.csv`);
  for (const m of manifest) {
    const fp = path.join(workDir, m.path);
    checksumLines.push(`${await sha256File(fp)}  ${m.path}`);
  }
  await fsp.writeFile(
    path.join(workDir, "checksums.txt"),
    checksumLines.join("\n") + "\n",
    "utf8",
  );

  // ZIP
  const zipPath = path.join(baseDir, `listing_${listingId}_export.zip`);
  await runZip(workDir, zipPath);

  c.header("content-type", "application/zip");
  c.header(
    "content-disposition",
    `attachment; filename="listing_${listingId}_export.zip"`,
  );
  c.header("cache-control", "no-store");

  const stream = fs.createReadStream(zipPath);
  stream.on("close", async () => {
    try {
      await fsp.rm(baseDir, { recursive: true, force: true });
    } catch {}
  });

  return c.body(stream);
});

// ---- FASE 5: Import candidates to listing (internal, max 10 per operation on UI) ----

app.post("/interno/listings/:id/import_candidate", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  try {
    const listingId = normStr(c.req.param("id"));
    if (!listingId) return c.json({ error: "invalid_listing" }, 400);

    const body = await c.req.parseBody().catch(() => null);
    if (!body) return c.json({ error: "invalid_body" }, 400);

    const Schema = z.object({
      firstName: z.string().min(1).max(80),
      lastName: z.string().min(1).max(120),
      email: z.string().email().max(120),
      birthDate: z.string().min(4),
      coverLetter: z.string().min(1).max(5000),
    });

    const parsed = Schema.safeParse({
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      birthDate: body.birthDate,
      coverLetter: body.coverLetter,
    });
    if (!parsed.success)
      return c.json(
        { error: "invalid_body", details: parsed.error?.issues },
        400,
      );

    const cv = body.cv;
    if (!cv || typeof cv !== "object" || typeof cv.arrayBuffer !== "function")
      return c.json({ error: "missing_cv" }, 400);
    // Limit: 50MB per file (FASE 5 refinement)
    if (typeof cv.size === "number" && cv.size > 50 * 1024 * 1024)
      return c.json({ error: "cv_too_large" }, 400);
    if (!isAllowedDocMime(cv.type))
      return c.json({ error: "invalid_cv_mime" }, 400);

    const certsRaw = body.certificates;
    const certs = Array.isArray(certsRaw)
      ? certsRaw
      : certsRaw
        ? [certsRaw]
        : [];
    for (const f of certs) {
      if (!f || typeof f !== "object" || typeof f.arrayBuffer !== "function")
        return c.json({ error: "invalid_certificate" }, 400);
      // Limit: 50MB per file (FASE 5 refinement)
      if (typeof f.size === "number" && f.size > 50 * 1024 * 1024)
        return c.json({ error: "certificate_too_large" }, 400);
      if (!isAllowedDocMime(f.type))
        return c.json({ error: "invalid_certificate_mime" }, 400);
    }

    const adminToken = await adminPbToken();

    // Load listing to get ownerUserId (company user)
    const listing = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/listings/records/${listingId}`,
    ).catch(() => null);
    if (!listing?.id) return c.json({ error: "not_found" }, 404);
    const companyUserId = normStr(listing.ownerUserId);
    if (!companyUserId)
      return c.json(
        { error: "invalid_listing", message: "listing.ownerUserId missing" },
        400,
      );

    const email = String(parsed.data.email).trim().toLowerCase();

    // candidate profile upsert by email
    const safeEmail = email.replace(/"/g, '\\"');
    const params = new URLSearchParams({
      perPage: "1",
      page: "1",
      filter: `email="${safeEmail}"`,
    });
    const candList = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/candidate_profiles/records?${params.toString()}`,
    );
    const existing = (candList?.items || [])[0] || null;

    const fullName = `${parsed.data.firstName} ${parsed.data.lastName}`.trim();
    let candId = "";
    if (existing?.id) {
      const updated = await pbRequestAuthed(
        env.POCKETBASE_URL,
        adminToken,
        `/api/collections/candidate_profiles/records/${existing.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            email,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            fullName,
          }),
        },
      );
      candId = updated?.id || existing.id;
    } else {
      const created = await pbRequestAuthed(
        env.POCKETBASE_URL,
        adminToken,
        `/api/collections/candidate_profiles/records`,
        {
          method: "POST",
          body: JSON.stringify({
            userId: "",
            email,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            fullName,
            title: "",
            location: "",
            public: false,
            skills: [],
            about: "",
          }),
        },
      );
      candId = created?.id || "";
    }

    // Create application
    const createdApp = await pbRequestAuthed(
      env.POCKETBASE_URL,
      adminToken,
      `/api/collections/applications/records`,
      {
        method: "POST",
        body: JSON.stringify({
          listingId,
          companyUserId,
          candidateUserId: candId,
          stage: "nuevo",
          notes: "",
          birthDate: new Date(parsed.data.birthDate).toISOString(),
          coverLetter: parsed.data.coverLetter,
        }),
      },
    );
    const applicationId = createdApp?.id || "";

    async function uploadProfileImport(file, docType) {
      const fd = new FormData();
      fd.set("userId", candId);
      fd.set("applicationId", applicationId);
      fd.set("kind", "document");
      fd.set("docType", docType);
      fd.set("consentText", "Internal import: consent");
      const filename =
        typeof file.name === "string" && file.name
          ? file.name
          : `upload-${docType}.bin`;
      fd.set("file", file, filename);
      const url = `${env.POCKETBASE_URL.replace(/\/+$/, "")}/api/collections/profile_imports/records`;
      const r = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}` },
        body: fd,
      });
      const text = await r.text().catch(() => "");
      if (!r.ok) return { ok: false, status: r.status, body: text };
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { ok: true, item: json };
    }

    const upCv = await uploadProfileImport(cv, "cv");
    if (!upCv.ok)
      return c.json({ error: "cv_upload_failed", detail: upCv }, 400);
    for (const f of certs) {
      const up = await uploadProfileImport(f, "certificate");
      if (!up.ok)
        return c.json({ error: "certificate_upload_failed", detail: up }, 400);
    }

    return c.json({ ok: true, applicationId, candidateProfileId: candId });
  } catch (e) {
    // Never leak as 500 for validation-ish errors; surface PocketBase body when present.
    const status = Number(e?.status || e?.statusCode || 400);
    return c.json(
      {
        error: "import_failed",
        message: String(e?.message || e),
        detail: e?.body || null,
      },
      status >= 400 && status < 600 ? status : 400,
    );
  }
});

// ---- Departments catalog (internal) ----

function normalizeDeptKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

app.get("/interno/departments", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const q = normStr(c.req.query("q") || "");
  const active = normStr(c.req.query("active") || "");

  const token = await adminPbToken();

  const clauses = [];
  if (active === "1") clauses.push("isActive=true");
  if (q) {
    const nq = q.replace(/"/g, '\\"');
    clauses.push(`(name~"${nq}" || normalizedKey~"${normalizeDeptKey(nq)}")`);
  }
  const filter = clauses.length ? clauses.join(" && ") : "";

  const params = new URLSearchParams({
    perPage: "500",
    page: "1",
    sort: "+code,+name",
  });
  if (filter) params.set("filter", filter);

  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/departments/records?${params.toString()}`,
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  return c.json({ ok: true, items });
});

// ---- Job Titles catalog (internal) ----

function normalizeJobTitleKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

app.get("/interno/job_titles", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const q = normStr(c.req.query("q") || "");
  const active = normStr(c.req.query("active") || "");

  const token = await adminPbToken();

  const clauses = [];
  if (active === "1") clauses.push("isActive=true");
  if (q) {
    const nq = q.replace(/"/g, '\\"');
    clauses.push(
      `(name~"${nq}" || normalizedKey~"${normalizeJobTitleKey(nq)}")`,
    );
  }
  const filter = clauses.length ? clauses.join(" && ") : "";

  const params = new URLSearchParams({
    perPage: "500",
    page: "1",
    sort: "+code,+name",
  });
  if (filter) params.set("filter", filter);

  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/job_titles/records?${params.toString()}`,
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  return c.json({ ok: true, items });
});

async function resolveDepartmentIdFromLegacyText(adminToken, legacyText) {
  const raw = normStr(legacyText);
  if (!raw) return "";
  const nk = normalizeDeptKey(raw);
  if (!nk) return "";
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `normalizedKey="${nk.replace(/"/g, '\\"')}"`,
  });
  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    adminToken,
    `/api/collections/departments/records?${params.toString()}`,
  );
  return String(res?.items?.[0]?.id || "");
}

// ---- Internal hiring -> IT request (portal MVP) ----

app.post("/interno/hire/enqueue_it_request", async (c) => {
  // Alta IT: this is the ONLY place where department/jobTitle/costCenter/manager live.
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const HireSchema = z.object({
    applicationId: z.string().min(1),
    startDate: z.string().min(4),
    departmentId: z.string().min(1),
    jobTitleId: z.string().min(1),
    costCenter: z.string().min(1).max(80),
    managerEmail: z.string().email(),
    managerName: z.string().max(120).optional().or(z.literal("")),
    accessProfileId: z.string().min(1).max(80),
    hardwareProfile: z.string().max(200).optional().or(z.literal("")),
    notesIT: z.string().max(2000).optional().or(z.literal("")),
  });

  const body = await c.req.json().catch(() => null);
  const parsed = HireSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const applicationId = normStr(parsed.data.applicationId);
  const departmentId = normStr(parsed.data.departmentId);
  const jobTitleId = normStr(parsed.data.jobTitleId);

  const token = await adminPbToken();

  // Validate catalogs
  const deptRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/departments/records/${departmentId}`,
  );
  if (!deptRec?.id)
    return c.json(
      {
        error: "invalid_department",
        message: "Department no existe en catálogo",
      },
      400,
    );

  const jtRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/job_titles/records/${jobTitleId}`,
  );
  if (!jtRec?.id)
    return c.json(
      { error: "invalid_jobTitle", message: "Job Title no existe en catálogo" },
      400,
    );

  // Load application + context
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${applicationId}`,
  );
  if (!appRec?.id) return c.json({ error: "invalid_application" }, 400);

  const listing = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/listings/records/${appRec.listingId}`,
  );
  const candList = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/candidate_profiles/records?${new URLSearchParams({ perPage: "1", page: "1", filter: `userId="${appRec.candidateUserId}"` }).toString()}`,
  );
  const candProfile = (candList?.items || [])[0] || null;

  // Upsert hire_profile by unique applicationId
  const hpFilter = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `applicationId="${applicationId.replace(/"/g, '\\"')}"`,
  });
  const hpList = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/hire_profiles/records?${hpFilter.toString()}`,
  );
  const existingHp = hpList?.items?.[0];

  const nowIso = new Date().toISOString();
  const hpBody = {
    applicationId,
    companyUserId: appRec.companyUserId,
    candidateUserId: appRec.candidateUserId,
    startDate: new Date(parsed.data.startDate).toISOString(),
    departmentId,
    jobTitleId,
    costCenter: parsed.data.costCenter,
    managerEmail: parsed.data.managerEmail,
    managerName: parsed.data.managerName || "",
    accessProfileId: parsed.data.accessProfileId,
    hardwareProfile: parsed.data.hardwareProfile || "",
    notesIT: parsed.data.notesIT || "",
    createdAt: nowIso,
  };

  let hireProfileId = "";
  if (existingHp?.id) {
    const updated = await pbRequestAuthed(
      env.POCKETBASE_URL,
      token,
      `/api/collections/hire_profiles/records/${existingHp.id}`,
      {
        method: "PATCH",
        body: JSON.stringify(hpBody),
      },
    );
    hireProfileId = updated?.id || existingHp.id;
  } else {
    const created = await pbRequestAuthed(
      env.POCKETBASE_URL,
      token,
      "/api/collections/hire_profiles/records",
      {
        method: "POST",
        body: JSON.stringify(hpBody),
      },
    );
    hireProfileId = created?.id || "";
  }

  const correlationId = c.get("correlationId");
  const entityType = "hire";
  const entityId = `hire_app_${applicationId}`;
  const kind = "otrs_create_ticket";
  const idem = `${entityType}/${entityId}::${kind}`;

  const exportBlob = {
    instructions: [
      "Alta IT: solicitud generada al marcar candidato como Contratado.",
      "Modo manual export: este sistema NO integra con OTRS real por ahora.",
    ],
    entity: { entityType, entityId },
    source: {
      applicationId,
      listingId: appRec.listingId,
      companyUserId: appRec.companyUserId,
      candidateUserId: appRec.candidateUserId,
      hireProfileId,
    },
    hire_profile: {
      startDate: hpBody.startDate,
      costCenter: hpBody.costCenter,
      managerEmail: hpBody.managerEmail,
      managerName: hpBody.managerName,
      accessProfileId: hpBody.accessProfileId,
      hardwareProfile: hpBody.hardwareProfile,
      notesIT: hpBody.notesIT,
    },
    department: {
      id: deptRec.id,
      code: deptRec.code,
      name: deptRec.name,
      normalizedKey: deptRec.normalizedKey,
    },
    jobTitle: {
      id: jtRec.id,
      code: jtRec.code,
      name: jtRec.name,
      normalizedKey: jtRec.normalizedKey,
    },
    candidate: candProfile
      ? {
          fullName: candProfile.fullName || "",
          title: candProfile.title || "",
          location: candProfile.location || "",
          skills: candProfile.skills || [],
        }
      : { userId: appRec.candidateUserId },
    listing: listing
      ? {
          title: listing.title || "",
          company: listing.company || "",
          location: listing.location || "",
          pay: listing.pay || "",
        }
      : { id: appRec.listingId },
    requestedBy: { userId: sess.userId, email: sess.email, role: sess.role },
    snapshotAt: nowIso,
  };

  const createBody = {
    kind,
    entity_type: entityType,
    entity_id: entityId,
    pinned_workflow_key: "portal_mvp",
    pinned_workflow_version: 2,
    idempotency_key: idem,
    payload: {
      mode: "manual_export",
      entityType,
      entityId,
      applicationId,
      hireProfileId,
      departmentId: deptRec.id,
      jobTitleId: jtRec.id,
    },
    status: "pending",
    attempts: 0,
    created_at: nowIso,
    correlation_id: correlationId,
    export_blob: exportBlob,
  };

  const res = await createOrGetByUnique(env, {
    collection: "integration_outbox",
    uniqueField: "idempotency_key",
    uniqueValue: idem,
    createBody,
  });

  // Move ATS stage to hired (final). This is ATS-only field.
  await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${applicationId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ stage: "hired" }),
    },
  );

  await audit(env, {
    entityType,
    entityId,
    action: "hire_confirmed_outbox_created",
    before: null,
    after: {
      outboxId: res.record?.id,
      kind,
      idempotencyKey: idem,
      created: res.created,
      applicationId,
      hireProfileId,
      departmentId: deptRec.id,
      jobTitleId: jtRec.id,
    },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  // FASE 4 (temporary, for reproducible closure without UI automation): log IDs of the last hire.
  // This is NOT business logic; it's evidence plumbing.
  try {
    const fs = require("node:fs");
    const payload = {
      timestamp: new Date().toISOString(),
      applicationId,
      hireProfileId,
      outboxId: res.record?.id || "",
    };
    console.log("FASE4_LAST_HIRE_IDS " + JSON.stringify(payload));
    fs.writeFileSync(
      "/tmp/fase-4-last-hire-ids.json",
      JSON.stringify(payload, null, 2),
    );
  } catch (e) {
    console.log(
      "FASE4_LAST_HIRE_IDS_ERROR " + String(e && e.message ? e.message : e),
    );
  }

  return c.json({
    ok: true,
    created: res.created,
    outbox: res.record,
    hireProfileId,
    movedStage: "hired",
  });
});

app.get("/outbox/:id/export", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const id = normStr(c.req.param("id"));
  if (!id) return c.json({ error: "invalid_id" }, 400);

  const outbox = await pbAdminRequest(
    env,
    `/api/collections/integration_outbox/records/${id}`,
  );
  return c.json({
    ok: true,
    export: outbox.export_blob || null,
    payload: outbox.payload || null,
    outbox,
  });
});

app.post("/outbox/:id/mark_exported", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const id = normStr(c.req.param("id"));
  if (!id) return c.json({ error: "invalid_id" }, 400);

  const correlationId = c.get("correlationId");
  const before = await pbAdminRequest(
    env,
    `/api/collections/integration_outbox/records/${id}`,
  );

  const updated = await pbAdminRequest(
    env,
    `/api/collections/integration_outbox/records/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        status: "exported_manually",
        correlation_id: correlationId,
      }),
    },
  );

  await audit(env, {
    entityType: before.entity_type,
    entityId: before.entity_id,
    action: "outbox_mark_exported",
    before: { status: before.status },
    after: { status: updated.status, outboxId: id },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  return c.json({ ok: true, outbox: updated });
});

app.post("/otrs/link", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const entityType = body.entityType || "hire";
  const entityId = normStr(body.entityId);
  const ticketNumber = normStr(body.ticketNumber);
  const ticketUrl = normStr(body.ticketUrl || "");
  const status = body.status || "unknown";
  const workflowInstanceId = normStr(body.workflowInstanceId || "");

  if (!entityId || !ticketNumber)
    return c.json({ error: "missing_fields" }, 400);

  const correlationId = c.get("correlationId");
  const uniqueKey = `${entityType}::${entityId}::${ticketNumber}`;

  const createBody = {
    entity_type: entityType,
    entity_id: entityId,
    ticket_number: ticketNumber,
    ticket_url: ticketUrl || null,
    status,
    linked_at: new Date().toISOString(),
    linked_by: sess.userId,
    meta: body.meta || {},
    unique_key: uniqueKey,
    correlation_id: correlationId,
  };

  const res = await createOrGetByUnique(env, {
    collection: "otrs_ticket_links",
    uniqueField: "unique_key",
    uniqueValue: uniqueKey,
    createBody,
  });

  await audit(env, {
    entityType,
    entityId,
    action: "otrs_ticket_linked",
    before: null,
    after: {
      ticketNumber,
      ticketUrl,
      status,
      created: res.created,
      linkId: res.record?.id,
    },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  if (workflowInstanceId) {
    await wfEvent(env, {
      workflowInstanceId,
      eventType: "external_linked",
      payload: {
        kind: "otrs_ticket",
        ticketNumber,
        ticketUrl,
        status,
        linkId: res.record?.id,
      },
      actorType: "user",
      actorUserId: sess.userId,
      correlationId,
    });
  }

  return c.json({ ok: true, created: res.created, link: res.record });
});

// Mock connector: simula un ticket OTRS cambiando estado (open → in_progress → closed)
app.post("/mock/otrs/simulate/:entityId", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const entityId = normStr(c.req.param("entityId"));
  const entityType = "hire";
  if (!entityId) return c.json({ error: "invalid_entity" }, 400);

  const correlationId = c.get("correlationId");

  const filter = encodeURIComponent(
    `entity_type="${entityType}" && entity_id="${entityId.replace(/"/g, '\\"')}"`,
  );
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    sort: "-linked_at",
    filter,
  });
  const list = await pbAdminRequest(
    env,
    `/api/collections/otrs_ticket_links/records?${params.toString()}`,
  );
  const existing = (list?.items || [])[0] || null;

  if (!existing) {
    const ticketNumber = `MOCK-${Math.random().toString(16).slice(2, 8).toUpperCase()}`;
    const uniqueKey = `${entityType}::${entityId}::${ticketNumber}`;
    const created = await pbAdminRequest(
      env,
      "/api/collections/otrs_ticket_links/records",
      {
        method: "POST",
        body: JSON.stringify({
          entity_type: entityType,
          entity_id: entityId,
          ticket_number: ticketNumber,
          ticket_url: null,
          status: "open",
          linked_at: new Date().toISOString(),
          linked_by: sess.userId,
          meta: { mock: true },
          unique_key: uniqueKey,
          correlation_id: correlationId,
        }),
      },
    );

    await audit(env, {
      entityType,
      entityId,
      action: "mock_otrs_ticket_created",
      before: null,
      after: { ticketNumber, status: "open", linkId: created.id },
      actorType: "user",
      actorUserId: sess.userId,
      correlationId,
    });

    return c.json({ ok: true, link: created });
  }

  const next =
    existing.status === "open"
      ? "in_progress"
      : existing.status === "in_progress"
        ? "closed"
        : "closed";
  const updated = await pbAdminRequest(
    env,
    `/api/collections/otrs_ticket_links/records/${existing.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: next, correlation_id: correlationId }),
    },
  );

  await audit(env, {
    entityType,
    entityId,
    action: "mock_otrs_ticket_advanced",
    before: { status: existing.status },
    after: { status: next, linkId: existing.id },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  return c.json({ ok: true, link: updated });
});

// ---- RBAC previews (enterprise) ----

function normStr(v) {
  const s = v == null ? "" : String(v);
  return s.trim();
}

function ruleMatches(condition, inputs) {
  const c = condition || {};
  const i = inputs || {};

  // Convention: if condition field missing/empty => no constraint.
  // If array present => input must be in array.
  // If scalar present => input must equal.
  for (const [k, condVal] of Object.entries(c)) {
    if (condVal == null) continue;
    if (Array.isArray(condVal)) {
      if (!condVal.length) continue;
      const inVal = i[k];
      if (inVal == null) return false;
      if (!condVal.map(normStr).includes(normStr(inVal))) return false;
      continue;
    }
    // object conditions (future) are ignored for now
    if (typeof condVal === "object") continue;
    const inVal = i[k];
    if (inVal == null) return false;
    if (normStr(inVal) !== normStr(condVal)) return false;
  }

  return true;
}

async function fetchActiveRbacRules() {
  // Use admin because rule collections are locked down.
  const params = new URLSearchParams({
    perPage: "200",
    page: "1",
    sort: "+priority,+created",
  });
  const list = await pbAdminRequest(
    env,
    `/api/collections/rbac_rules/records?${params.toString()}`,
  );
  const items = Array.isArray(list?.items) ? list.items : [];
  return items.filter((r) => r.status === "active");
}

async function fetchEntitlementsByAccessProfiles(accessProfileIds) {
  const ids = Array.from(new Set((accessProfileIds || []).filter(Boolean)));
  if (!ids.length) return [];

  // PocketBase filter OR: field="id1" || field="id2"
  const ors = ids.map((id) => `access_profile="${id}"`).join(" || ");
  const params = new URLSearchParams({
    perPage: "500",
    page: "1",
    filter: ors,
  });
  const res = await pbAdminRequest(
    env,
    `/api/collections/access_profile_entitlements/records?${params.toString()}`,
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  return items.map((e) => ({
    accessProfileId: e.access_profile,
    entitlementType: e.entitlement_type,
    entitlementKey: e.entitlement_key,
    description: e.description || "",
    system: e.system || "",
    criticality: e.criticality || "",
    validFrom: e.valid_from || null,
    validTo: e.valid_to || null,
  }));
}

app.post("/rbac/preview", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "invalid_body" }, 400);

  const entityType = body.entityType || "hire";
  const entityId = normStr(body.entityId);
  const inputs = body.inputs || {};
  const workflowInstanceId = normStr(body.workflowInstanceId || "");
  const correlationId = c.get("correlationId");

  if (!entityId) return c.json({ error: "missing_entity_id" }, 400);

  const rules = await fetchActiveRbacRules();
  const matched = [];
  const accessProfileIds = [];

  for (const r of rules) {
    const cond = r.condition || {};
    const ok = ruleMatches(cond, inputs);
    if (!ok) continue;

    const resultIds = Array.isArray(r.result_access_profiles)
      ? r.result_access_profiles
      : [];
    for (const id of resultIds) accessProfileIds.push(id);

    matched.push({
      id: r.id,
      name: r.name,
      priority: r.priority,
      condition: cond,
      resultAccessProfiles: resultIds,
    });
  }

  const dedupProfiles = Array.from(new Set(accessProfileIds.filter(Boolean)));
  const entitlements = await fetchEntitlementsByAccessProfiles(dedupProfiles);

  const computedAt = new Date().toISOString();

  const recordBody = {
    entity_type: entityType,
    entity_id: entityId,
    workflow_instance: workflowInstanceId || null,
    computed_at: computedAt,
    inputs_snapshot: inputs,
    matched_rules: matched,
    access_profiles: dedupProfiles,
    entitlements,
    approved: false,
    correlation_id: correlationId,
  };

  const created = await pbAdminRequest(
    env,
    "/api/collections/permission_previews/records",
    {
      method: "POST",
      body: JSON.stringify(recordBody),
    },
  );

  await audit(env, {
    entityType,
    entityId,
    action: "permission_preview_generated",
    before: null,
    after: {
      permissionPreviewId: created?.id,
      accessProfiles: dedupProfiles.length,
      entitlements: entitlements.length,
    },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  if (workflowInstanceId) {
    await wfEvent(env, {
      workflowInstanceId,
      eventType: "action_succeeded",
      payload: {
        kind: "rbac_preview_generated",
        permissionPreviewId: created?.id,
      },
      actorType: "user",
      actorUserId: sess.userId,
      correlationId,
    });
  }

  return c.json({ ok: true, preview: created });
});

app.get("/rbac/preview/:hireId", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const hireId = normStr(c.req.param("hireId"));
  const correlationId = c.get("correlationId");
  if (!hireId) return c.json({ error: "invalid_hire" }, 400);

  const filter = encodeURIComponent(
    `entity_type="hire" && entity_id="${hireId.replace(/"/g, '\\"')}"`,
  );
  const params = new URLSearchParams({
    perPage: "1",
    page: "1",
    sort: "-computed_at",
    filter,
  });
  const list = await pbAdminRequest(
    env,
    `/api/collections/permission_previews/records?${params.toString()}`,
  );
  const item = (list?.items || [])[0] || null;

  await audit(env, {
    entityType: "hire",
    entityId: hireId,
    action: "permission_preview_viewed",
    before: null,
    after: { found: !!item },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  return c.json({ ok: true, preview: item });
});

// ---- Metrics (real PocketBase data) ----

app.get("/metrics", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const token = await adminPbToken();
  const pb = (path) => pbRequestAuthed(env.POCKETBASE_URL, token, path);

  const [listingsRes, appsRes] = await Promise.all([
    pb("/api/collections/listings/records?perPage=1&page=1"),
    pb("/api/collections/applications/records?perPage=1&page=1"),
  ]);

  const totalListings = listingsRes?.totalItems ?? 0;
  const totalApplications = appsRes?.totalItems ?? 0;

  // applicationsByStage: fetch all applications and group by stage
  const allAppsRes = await pb(
    "/api/collections/applications/records?perPage=500&page=1&sort=-created",
  );
  const apps = Array.isArray(allAppsRes?.items) ? allAppsRes.items : [];
  const appsByStage = {};
  for (const a of apps) {
    const s = a.stage || "nuevo";
    appsByStage[s] = (appsByStage[s] || 0) + 1;
  }

  // listingsByKind: fetch all listings and group by kind
  const allListingsRes = await pb(
    "/api/collections/listings/records?perPage=500&page=1",
  );
  const allListings = Array.isArray(allListingsRes?.items)
    ? allListingsRes.items
    : [];
  const listingsByKind = {};
  for (const l of allListings) {
    const k = l.kind || "empleo";
    listingsByKind[k] = (listingsByKind[k] || 0) + 1;
  }

  // recentActivity: last 10 applications with candidate + listing info
  const recentRes = await pb(
    "/api/collections/applications/records?perPage=10&page=1&sort=-created",
  );
  const recentApps = Array.isArray(recentRes?.items) ? recentRes.items : [];
  const candidateIds = [
    ...new Set(recentApps.map((a) => a.candidateUserId).filter(Boolean)),
  ];
  const listingIds = [
    ...new Set(recentApps.map((a) => a.listingId).filter(Boolean)),
  ];

  const candidatesById = {};
  const listingsById = {};
  await Promise.all([
    ...candidateIds.map(async (cid) => {
      try {
        const cr = await pb(
          `/api/collections/candidate_profiles/records/${cid}`,
        );
        candidatesById[cid] = cr;
      } catch {
        candidatesById[cid] = null;
      }
    }),
    ...listingIds.map(async (lid) => {
      try {
        const lr = await pb(`/api/collections/listings/records/${lid}`);
        listingsById[lid] = lr;
      } catch {
        listingsById[lid] = null;
      }
    }),
  ]);

  const recentActivity = recentApps.map((a) => {
    const cand = candidatesById[a.candidateUserId];
    const listing = listingsById[a.listingId];
    return {
      id: a.id,
      stage: a.stage,
      createdAt: a.created,
      candidateName: cand?.fullName || cand?.firstName || "",
      listingTitle: listing?.title || "",
    };
  });

  // Simulated values for now
  const avgTimeToHire = 45;
  const conversionRate = 28;

  return c.json({
    ok: true,
    totalListings,
    totalApplications,
    applicationsByStage: appsByStage,
    listingsByKind,
    recentActivity,
    avgTimeToHire,
    conversionRate,
  });
});

// ---- Public catalog aliases (requireUser, not requireCompleteProfile) ----

app.get("/departments", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const q = normStr(c.req.query("q") || "");
  const active = normStr(c.req.query("active") || "");

  const token = await adminPbToken();

  const clauses = [];
  if (active === "1") clauses.push("isActive=true");
  if (q) {
    const nq = q.replace(/"/g, '\\"');
    clauses.push(`(name~"${nq}" || normalizedKey~"${normalizeDeptKey(nq)}")`);
  }
  const filter = clauses.length ? clauses.join(" && ") : "";

  const params = new URLSearchParams({
    perPage: "500",
    page: "1",
    sort: "+code,+name",
  });
  if (filter) params.set("filter", filter);

  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/departments/records?${params.toString()}`,
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  return c.json({ ok: true, items });
});

app.get("/job_titles", async (c) => {
  const sess = await requireUser(c);
  if (!sess) return c.json({ error: "unauthorized" }, 401);

  const q = normStr(c.req.query("q") || "");
  const active = normStr(c.req.query("active") || "");

  const token = await adminPbToken();

  const clauses = [];
  if (active === "1") clauses.push("isActive=true");
  if (q) {
    const nq = q.replace(/"/g, '\\"');
    clauses.push(
      `(name~"${nq}" || normalizedKey~"${normalizeJobTitleKey(nq)}")`,
    );
  }
  const filter = clauses.length ? clauses.join(" && ") : "";

  const params = new URLSearchParams({
    perPage: "500",
    page: "1",
    sort: "+code,+name",
  });
  if (filter) params.set("filter", filter);

  const res = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/job_titles/records?${params.toString()}`,
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  return c.json({ ok: true, items });
});

// ---- Enterprise hire-profiles (public alias for the internal IT enqueue) ----

app.post("/enterprise/hire-profiles", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const HireSchema = z.object({
    applicationId: z.string().min(1),
    startDate: z.string().min(4),
    departmentId: z.string().min(1),
    jobTitleId: z.string().min(1),
    costCenter: z.string().min(1).max(80),
    managerEmail: z.string().email(),
    managerName: z.string().max(120).optional().or(z.literal("")),
    accessProfileId: z.string().min(1).max(80),
    hardwareProfile: z.string().max(200).optional().or(z.literal("")),
    notesIT: z.string().max(2000).optional().or(z.literal("")),
  });

  const body = await c.req.json().catch(() => null);
  const parsed = HireSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      { error: "invalid_body", details: parsed.error?.issues },
      400,
    );

  const applicationId = normStr(parsed.data.applicationId);
  const departmentId = normStr(parsed.data.departmentId);
  const jobTitleId = normStr(parsed.data.jobTitleId);

  const token = await adminPbToken();

  // Validate catalogs
  const deptRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/departments/records/${departmentId}`,
  );
  if (!deptRec?.id)
    return c.json(
      {
        error: "invalid_department",
        message: "Department no existe en catálogo",
      },
      400,
    );

  const jtRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/job_titles/records/${jobTitleId}`,
  );
  if (!jtRec?.id)
    return c.json(
      { error: "invalid_jobTitle", message: "Job Title no existe en catálogo" },
      400,
    );

  // Load application + context
  const appRec = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/applications/records/${applicationId}`,
  );
  if (!appRec?.id) return c.json({ error: "invalid_application" }, 400);

  const nowIso = new Date().toISOString();
  const correlationId = c.get("correlationId");

  // Upsert hire_profile by unique applicationId
  const hpFilter = new URLSearchParams({
    perPage: "1",
    page: "1",
    filter: `applicationId="${applicationId.replace(/"/g, '\\"')}"`,
  });
  const hpList = await pbRequestAuthed(
    env.POCKETBASE_URL,
    token,
    `/api/collections/hire_profiles/records?${hpFilter.toString()}`,
  );
  const existingHp = hpList?.items?.[0];

  const hpBody = {
    applicationId,
    companyUserId: appRec.companyUserId,
    candidateUserId: appRec.candidateUserId,
    startDate: new Date(parsed.data.startDate).toISOString(),
    departmentId,
    jobTitleId,
    costCenter: parsed.data.costCenter,
    managerEmail: parsed.data.managerEmail,
    managerName: parsed.data.managerName || "",
    accessProfileId: parsed.data.accessProfileId,
    hardwareProfile: parsed.data.hardwareProfile || "",
    notesIT: parsed.data.notesIT || "",
    createdAt: nowIso,
  };

  let hireProfileId = "";
  if (existingHp?.id) {
    const updated = await pbRequestAuthed(
      env.POCKETBASE_URL,
      token,
      `/api/collections/hire_profiles/records/${existingHp.id}`,
      {
        method: "PATCH",
        body: JSON.stringify(hpBody),
      },
    );
    hireProfileId = updated?.id || existingHp.id;
  } else {
    const created = await pbRequestAuthed(
      env.POCKETBASE_URL,
      token,
      "/api/collections/hire_profiles/records",
      {
        method: "POST",
        body: JSON.stringify(hpBody),
      },
    );
    hireProfileId = created?.id || "";
  }

  // Create outbox entry
  const entityType = "hire";
  const entityId = `hire_app_${applicationId}`;
  const kind = "alta_it";
  const idem = `${entityType}/${entityId}::${kind}`;

  const createBody = {
    kind,
    entity_type: entityType,
    entity_id: entityId,
    pinned_workflow_key: "portal_mvp",
    pinned_workflow_version: 2,
    idempotency_key: idem,
    payload: {
      mode: "manual_export",
      entityType,
      entityId,
      applicationId,
      hireProfileId,
      departmentId: deptRec.id,
      jobTitleId: jtRec.id,
    },
    status: "pending",
    attempts: 0,
    created_at: nowIso,
    correlation_id: correlationId,
    export_blob: {
      instructions: ["Alta IT via /enterprise/hire-profiles"],
      entity: { entityType, entityId },
      source: { applicationId, hireProfileId },
      department: { id: deptRec.id, code: deptRec.code, name: deptRec.name },
      jobTitle: { id: jtRec.id, code: jtRec.code, name: jtRec.name },
      hire_profile: hpBody,
      snapshotAt: nowIso,
    },
  };

  const res = await createOrGetByUnique(env, {
    collection: "integration_outbox",
    uniqueField: "idempotency_key",
    uniqueValue: idem,
    createBody,
  });

  await audit(env, {
    entityType,
    entityId,
    action: "hire_profile_created",
    before: null,
    after: { hireProfileId, outboxId: res.record?.id, kind, applicationId },
    actorType: "user",
    actorUserId: sess.userId,
    correlationId,
  });

  return c.json({
    ok: true,
    hire_profile: hpBody,
    hireProfileId,
    outbox: res.record,
  });
});

// ---- Enterprise audit log ----

app.get("/enterprise/audit-log", async (c) => {
  const gate = await requireCompleteProfile(c);
  if (gate.error) return gate.error;
  const sess = gate.sess;
  if (!["admin", "rrhh", "it"].includes(sess.role))
    return c.json({ error: "forbidden" }, 403);

  const page = Math.max(1, parseInt(c.req.query("page") || "1", 10) || 1);
  const perPage = Math.min(
    200,
    Math.max(1, parseInt(c.req.query("perPage") || "20", 10) || 20),
  );
  const actionFilter = normStr(c.req.query("action") || "");
  const from = normStr(c.req.query("from") || "");
  const to = normStr(c.req.query("to") || "");

  const clauses = [];
  if (actionFilter) {
    clauses.push(`action~"${actionFilter.replace(/"/g, '\\"')}"`);
  }
  if (from) {
    clauses.push(`at>="${from.replace(/"/g, '\\"')}"`);
  }
  if (to) {
    clauses.push(`at<="${to.replace(/"/g, '\\"')}"`);
  }
  const filter = clauses.length ? clauses.join(" && ") : "";

  const params = new URLSearchParams({
    perPage: String(perPage),
    page: String(page),
    sort: "-at",
  });
  if (filter) params.set("filter", filter);

  const res = await pbAdminRequest(
    env,
    `/api/collections/audit_log/records?${params.toString()}`,
  );
  const items = Array.isArray(res?.items) ? res.items : [];
  const totalItems = res?.totalItems ?? items.length;

  return c.json({
    ok: true,
    items,
    totalItems,
    page,
    perPage,
    totalPages: Math.ceil(totalItems / perPage),
  });
});

serve({ fetch: app.fetch, port: env.PORT });
console.log(`[api] listening on http://localhost:${env.PORT}`);
