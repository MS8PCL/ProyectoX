import { defineStore } from "pinia";
import { api } from "../lib/api.js";
import { isDesktopMode, loadState, saveState } from "../lib/storage.js";
import { useNotificationsStore } from "./notifications.js";

// Keep promises outside reactive state; each store has its own desktop queue.
const desktopBootstraps = new WeakMap();
const desktopWrites = new WeakMap();

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}`;
}

function normalizeListingKind(kind) {
  return ["empleo", "freelance", "ett", "becario"].includes(kind) ? kind : "empleo";
}

export function createDefaultState() {
  return {
    v: 3,
    theme: "terminal", // terminal | light
    role: "candidato", // candidato | empresa
    profile: {
      candidato: {
        name: "",
        title: "",
        location: "",
        skills: [],
        about: "",
        public: true,
      },
      empresa: {
        name: "",
        title: "",
        location: "",
        skills: [],
        about: "",
      },
    },
    // No-demo: listings/apps come from server.
    listings: [],
    favorites: [],
    applications: [],
    candidates: [],

    // Company lists (talent lists)
    lists: [],
    listMembers: {
      // listId -> candidateId[]
    },

    pipeline: {
      // listingId -> array of candidates (per offer)
    },
    candidateFavorites: {},

    // UI experiments
    homeMode: "workflow", // workflow (fixed)
  };
}

function normalizeImportedState(input, legacyCleanup = !isDesktopMode()) {
  if (!input || typeof input !== "object") throw new Error("JSON inválido");

  // Accept either full state or { state: ... }
  const s =
    input.state && typeof input.state === "object" ? input.state : input;

  const base = createDefaultState();
  const out = { ...base, ...s };

  // No-demo migration: if coming from older persisted state, drop demo/business data.
  if (legacyCleanup && Number(out.v || 0) < 3) {
    out.listings = [];
    out.applications = [];
    out.candidates = [];
    out.lists = [];
    out.listMembers = {};
    out.pipeline = {};
    out.candidateFavorites = {};
  }

  // Basic normalization
  if (!["terminal", "light"].includes(out.theme)) out.theme = "terminal";
  if (!["candidato", "empresa"].includes(out.role)) out.role = "candidato";
  if (!Array.isArray(out.listings)) out.listings = base.listings;
  if (!Array.isArray(out.favorites)) out.favorites = [];
  if (!Array.isArray(out.applications)) out.applications = [];
  if (!out.profile || typeof out.profile !== "object")
    out.profile = base.profile;
  if (!Array.isArray(out.candidates)) out.candidates = base.candidates;
  out.candidates = out.candidates.filter(Boolean).map((c) => ({
    id: String(c.id || uid("cand")),
    name: String(c.name || ""),
    title: String(c.title || ""),
    location: String(c.location || ""),
    tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
    about: String(c.about || ""),
    cvUrl: String(c.cvUrl || ""),
    public: c.public !== false,
  }));
  if (!Array.isArray(out.lists)) out.lists = base.lists;
  if (!out.listMembers || typeof out.listMembers !== "object")
    out.listMembers = {};
  if (!out.pipeline || typeof out.pipeline !== "object") out.pipeline = {};
  if (!out.candidateFavorites || typeof out.candidateFavorites !== "object")
    out.candidateFavorites = {};
  if (!["console", "workflow"].includes(out.homeMode))
    out.homeMode = "workflow";

  // Profile cleanup: remove legacy demo defaults if they exist in persisted state
  const demoStrings = new Set(legacyCleanup ? [
    "Manu",
    "Frontend / Producto",
    "Madrid",
    "Perfil demo (editable).",
    "Empresa Demo",
    "Equipo",
    "Remoto",
    "Empresa demo (editable).",
  ] : []);

  for (const r of ["candidato", "empresa"]) {
    const p = out.profile?.[r];
    if (!p || typeof p !== "object") continue;

    const cleaned = {
      name: demoStrings.has(String(p.name || "")) ? "" : String(p.name || ""),
      title: demoStrings.has(String(p.title || ""))
        ? ""
        : String(p.title || ""),
      location: demoStrings.has(String(p.location || ""))
        ? ""
        : String(p.location || ""),
      skills: Array.isArray(p.skills)
        ? p.skills.map((x) => String(x)).filter((x) => !demoStrings.has(x))
        : [],
      about: demoStrings.has(String(p.about || ""))
        ? ""
        : String(p.about || ""),
      public: p.public !== false,
    };

    out.profile[r] = cleaned;
  }

  out.listings = out.listings.filter(Boolean).map((x) => ({
    id: String(x.id || uid("l")),
    kind: normalizeListingKind(x.kind),
    title: String(x.title || ""),
    company: String(x.company || ""),
    location: String(x.location || ""),
    pay: String(x.pay || ""),
    tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
    desc: String(x.desc || ""),
    createdAt: Number(x.createdAt || Date.now()),
    createdBy: x.createdBy === "candidato" ? "candidato" : "empresa",
    ownerUserId: x.ownerUserId ? String(x.ownerUserId) : "",
  }));

  // Keep favorites consistent
  const ids = new Set(out.listings.map((l) => l.id));
  out.favorites = out.favorites.map(String).filter((id) => ids.has(id));

  return out;
}

export const useAppStore = defineStore("app", {
  state: () => ({
    booted: false,
    state: null,
    drawer: {
      open: false,
      listingId: null,
    },
    // candidateDrawer removed (server-only mode)
    toast: null,
    // auto theme: tracks whether the user has manually chosen a theme.
    // null = no manual override (follow OS), otherwise 'terminal' or 'light'.
    _themeOverride: null,
  }),
  getters: {
    theme: (s) => s.state?.theme ?? "terminal",
    role: (s) => s.state?.role ?? "candidato",
    homeMode: (s) => s.state?.homeMode ?? "console",
    listings: (s) => s.state?.listings ?? [],
    favorites: (s) => new Set(s.state?.favorites ?? []),
    // (server-only) removed: candidateFavorites/candidates/lists/listMembers
    applications: (s) => s.state?.applications ?? [],

    isProfileComplete: (s) => (role) => {
      const r = role || s.state?.role || "candidato";
      const p = s.state?.profile?.[r];
      if (!p) return false;
      // Required fields (MVP): name + title/sector + location
      const nameOk = String(p.name || "").trim().length >= 2;
      const titleOk = String(p.title || "").trim().length >= 2;
      const locOk = String(p.location || "").trim().length >= 2;
      return nameOk && titleOk && locOk;
    },
  },
  actions: {
    async bootstrap() {
      if (this.booted) return;
      if (isDesktopMode()) {
        if (desktopBootstraps.has(this)) return desktopBootstraps.get(this);
        const loading = (async () => {
          try {
            const res = await api("/state");
            if (!res || typeof res !== "object" || !("state" in res) ||
                (res.state !== null && (typeof res.state !== "object" || Array.isArray(res.state)))) {
              throw new Error("Respuesta /state inválida");
            }
            // Only an explicit null from the server means a new, empty state.
            this.state = res.state === null ? createDefaultState() : normalizeImportedState(res.state);
            // /state may contain only preferences; the feed lives in /listings.
            // Role-dependent reads wait for main.js to synchronize the identity.
            await this.refreshListingsFromServer();
            this._applyTheme();
            this._setupAutoTheme();
            this.booted = true;
          } catch (err) {
            this._reportStateError("No se pudo cargar el estado", err);
            throw err;
          } finally {
            desktopBootstraps.delete(this);
          }
        })();
        desktopBootstraps.set(this, loading);
        return loading;
      }

      // 1) Try backend-first
      try {
        const res = await api("/state");
        if (res && res.state) {
          this.state = normalizeImportedState(res.state);
        }
      } catch {
        // ignore
      }

      // 2) Fallback to localStorage
      if (!this.state) {
        const loaded = loadState();
        this.state = loaded ? normalizeImportedState(loaded) : createDefaultState();
      }

      this.booted = true;
      this._applyTheme();
      this._setupAutoTheme();

      // Server-only: refresh listings and favorites from server.
      await this.refreshListingsFromServer().catch(() => {});
      await this.refreshFavoritesFromServer().catch(() => {});

      // Also refresh candidate applications from server if candidate.
      if (this.role === "candidato")
        await this.refreshMyApplicationsFromServer().catch(() => {});

      // persist immediately (both) so backend gets a copy
      await this._persist();
    },
    _reportStateError(message, err) {
      const text = `${message}: ${err instanceof Error ? err.message : String(err)}`;
      this.toast = { kind: "err", text };
      useNotificationsStore().add({ type: "warning", title: message, body: text });
      console.error("[app]", text, err);
    },
    _persist() {
      if (isDesktopMode()) {
        if (!this.booted || !this.state) {
          const err = new Error("El estado de escritorio aún no se ha cargado");
          const failed = Promise.reject(err);
          failed.catch(() => this._reportStateError("No se pudo guardar el estado", err));
          return failed;
        }
        // Snapshot at execution time so queued writes include mutations made in flight.
        const previous = desktopWrites.get(this) || Promise.resolve();
        const write = previous.catch(() => {}).then(() => api("/state", {
          method: "PUT",
          body: JSON.stringify({ state: this.state }),
        }));
        desktopWrites.set(this, write);
        // Callers may await and receive the rejection; fire-and-forget actions still report it.
        write.catch((err) => this._reportStateError("No se pudo guardar el estado", err));
        return write;
      }
      if (!this.state) return Promise.resolve();
      // Debounce rapid consecutive mutations (e.g., toggleFavorite spam).
      if (this.__persistTimer) {
        clearTimeout(this.__persistTimer);
      }
      this.__persistPending = false;

      const doPersist = async () => {
        this.__persistTimer = null;
        saveState(this.state);
        try {
          await api("/state", {
            method: "PUT",
            body: JSON.stringify({ state: this.state }),
          });
        } catch {
          // offline or backend down: localStorage already has it
        }
        // If another mutation arrived while we were persisting, flush once more.
        if (this.__persistPending) {
          this.__persistPending = false;
          this._persist();
        }
      };

      this.__persistTimer = setTimeout(doPersist, 300);
    },
    _applyTheme() {
      const t = this.state?.theme || "terminal";
      document.documentElement.setAttribute("data-theme", t);
    },
    _setupAutoTheme() {
      const saved = localStorage.getItem("px_theme_override");
      if (saved) {
        this._themeOverride = saved;
        this.state.theme = saved;
        this._applyTheme();
        return;
      }
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const applyOS = () => {
        if (this._themeOverride !== null) return;
        this.state.theme = mq.matches ? "terminal" : "light";
        this._applyTheme();
      };
      applyOS();
      mq.addEventListener("change", applyOS);
    },
    setTheme(theme) {
      // Manual toggle overrides auto-detection
      this._themeOverride = theme;
      localStorage.setItem("px_theme_override", theme);
      this.state.theme = theme;
      this._applyTheme();
      this._persist();
    },
    toggleTheme() {
      this.setTheme(this.state.theme === "terminal" ? "light" : "terminal");
    },
    setRole(role) {
      this.state.role = role;
      this._persist();
    },
    toggleRole() {
      this.setRole(this.state.role === "candidato" ? "empresa" : "candidato");
    },
    // homeMode: fixed to workflow (no toggle)
    openDrawer(listingId) {
      this.drawer.open = true;
      this.drawer.listingId = listingId;
    },
    closeDrawer() {
      this.drawer.open = false;
      this.drawer.listingId = null;
    },

    // (removed) candidate drawer (server-only mode)
    async refreshFavoritesFromServer() {
      if (this.role !== "candidato") {
        this.state.favorites = [];
        return;
      }
      const res = await api("/me/favorites");
      const ids = Array.isArray(res?.listingIds)
        ? res.listingIds.map(String)
        : [];
      this.state.favorites = Array.from(new Set(ids));
    },

    async toggleFavorite(listingId) {
      const id = String(listingId || "");
      if (!id) return;
      if (this.role !== "candidato") return;

      // optimistic
      const favs = new Set(this.state.favorites || []);
      const next = !favs.has(id);
      if (next) favs.add(id);
      else favs.delete(id);
      this.state.favorites = Array.from(favs);

      try {
        const res = await api(
          `/me/favorites/${encodeURIComponent(id)}/toggle`,
          { method: "POST" },
        );
        const okNext = !!res?.favorited;
        const final = new Set(this.state.favorites || []);
        if (okNext) final.add(id);
        else final.delete(id);
        this.state.favorites = Array.from(final);
      } catch {
        // revert on error
        const revert = new Set(this.state.favorites || []);
        if (next) revert.delete(id);
        else revert.add(id);
        this.state.favorites = Array.from(revert);
        this.toast = {
          kind: "info",
          text: "No se pudo actualizar Favoritos en el servidor.",
        };
      }

      await this._persist();
    },
    createListing(partial) {
      // Offline fallback (kept for resilience)
      const l = {
        id: uid(partial.kind === "freelance" ? "free" : "job"),
        kind: normalizeListingKind(partial.kind),
        title: String(partial.title || ""),
        company: String(partial.company || ""),
        location: String(partial.location || ""),
        pay: String(partial.pay || ""),
        tags: Array.isArray(partial.tags)
          ? partial.tags
          : String(partial.tags || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
        desc: String(partial.desc || ""),
        createdAt: Date.now(),
        createdBy: this.state.role === "empresa" ? "empresa" : "candidato",
        ownerUserId: "",
      };
      this.state.listings = [l, ...this.state.listings];
      this._persist();
      return l;
    },

    async refreshListingsFromServer() {
      const res = await api("/listings");
      if (isDesktopMode() && !Array.isArray(res?.items)) {
        throw new Error("Respuesta /listings inválida");
      }
      const items = Array.isArray(res?.items) ? res.items : [];
      const mapped = items
        .map((x) => ({
          id: String(x.id || ""),
          kind: normalizeListingKind(x.kind),
          title: String(x.title || ""),
          company: String(x.company || ""),
          location: String(x.location || ""),
          pay: String(x.pay || ""),
          tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
          desc: String(x.desc || ""),
          createdAt: x.created ? Date.parse(x.created) : Date.now(),
          createdBy: "empresa",
          ownerUserId: x.ownerUserId ? String(x.ownerUserId) : "",
        }))
        .filter((l) => l.id);

      // Server-only: replace listings entirely.
      this.state.listings = mapped.sort(
        (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      );
    },

    async createListingServer(partial) {
      const payload = {
        kind: normalizeListingKind(partial.kind),
        title: String(partial.title || ""),
        company: String(partial.company || ""),
        location: String(partial.location || ""),
        pay: String(partial.pay || ""),
        tags: Array.isArray(partial.tags)
          ? partial.tags
          : String(partial.tags || "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
        desc: String(partial.desc || ""),
      };

      const res = await api("/listings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const x = res?.item;
      const l = {
        id: String(x?.id || uid(payload.kind === "freelance" ? "free" : "job")),
        kind: normalizeListingKind(x?.kind ?? payload.kind),
        title: String(x?.title || payload.title),
        company: String(x?.company || payload.company),
        location: String(x?.location || payload.location),
        pay: String(x?.pay || payload.pay),
        tags: Array.isArray(x?.tags) ? x.tags.map(String) : payload.tags,
        desc: String(x?.desc || payload.desc),
        createdAt: x?.created ? Date.parse(x.created) : Date.now(),
        createdBy: "empresa",
        ownerUserId: String(x?.ownerUserId || ""),
      };

      // insert/replace
      const rest = (this.state.listings || []).filter((z) => z.id !== l.id);
      this.state.listings = [l, ...rest];
      await this._persist();
      return l;
    },
    applyToListing(listingId) {
      // Candidate flow: applications with status
      const existing = this.state.applications.find(
        (a) => a.listingId === listingId,
      );
      if (existing) {
        this.toast = {
          kind: "info",
          text: "Ya existe una candidatura para este anuncio.",
        };
        return;
      }

      // Create/ensure a candidate identity for the current candidate profile
      const prof = this.state.profile?.candidato || {};
      const displayName = String(prof.name || "").trim();
      if (!displayName) {
        this.toast = {
          kind: "info",
          text: "Antes de aplicar, completa tu Nombre en Perfil.",
        };
        return;
      }

      const candidateId = `cand_me`;
      const cand = {
        id: candidateId,
        name: displayName,
        title: String(prof.title || ""),
        location: String(prof.location || "—"),
        tags: Array.isArray(prof.skills)
          ? prof.skills.map(String).slice(0, 6)
          : [],
        about: String(prof.about || "").slice(0, 1200),
        cvUrl: "",
        public: prof.public !== false,
      };
      this.state.candidates = Array.isArray(this.state.candidates)
        ? this.state.candidates
        : [];
      const idx = this.state.candidates.findIndex((c) => c.id === candidateId);
      if (idx >= 0)
        this.state.candidates[idx] = { ...this.state.candidates[idx], ...cand };
      else this.state.candidates = [cand, ...this.state.candidates];

      this.state.applications = [
        {
          id: uid("app"),
          listingId,
          candidateId,
          status: "enviado", // enviado | entrevista | oferta | rechazado
          createdAt: Date.now(),
        },
        ...this.state.applications,
      ];

      // Company side: auto-add applicant into selection process (empleo only)
      const listing = (this.state.listings || []).find(
        (x) => x.id === listingId,
      );
      if (
        listing &&
        listing.kind === "empleo" &&
        listing.createdBy === "empresa"
      ) {
        this.addApplicantToSelection(listingId, candidateId);
      }

      this._persist();
      this.toast = { kind: "ok", text: "Candidatura creada (offline)." };
    },

    async applyToListingServer(listingId) {
      // No-demo mode: server is the source of truth.
      const existing = (this.state.applications || []).find(
        (a) => a.listingId === listingId,
      );
      if (existing) {
        this.toast = {
          kind: "info",
          text: "Ya existe una candidatura para este anuncio.",
        };
        return;
      }

      // Keep minimal client-side validation (UX) – server will also enforce profile completeness.
      const prof = this.state.profile?.candidato || {};
      const displayName = String(prof.name || "").trim();
      if (!displayName) {
        this.toast = {
          kind: "info",
          text: "Antes de aplicar, completa tu Nombre en Perfil.",
        };
        return;
      }

      await api(`/listings/${encodeURIComponent(listingId)}/apply`, {
        method: "POST",
      });

      await this.refreshMyApplicationsFromServer().catch(() => {});
      this.toast = { kind: "ok", text: "Candidatura enviada." };
      await this._persist();
    },

    async refreshMyApplicationsFromServer() {
      const res = await api("/me/applications");
      const apps = Array.isArray(res?.items) ? res.items : [];
      const listings =
        res?.listings && typeof res.listings === "object" ? res.listings : {};

      // Replace applications entirely from server.
      this.state.applications = apps.map((a) => ({
        id: String(a.id),
        listingId: String(a.listingId),
        candidateId: "server",
        status: String(a.status || "enviado"),
        createdAt: Number(a.createdAt || Date.now()),
      }));

      // Merge listing summaries into local listings so the UI can show title/company.
      const serverListings = Object.values(listings || {});
      if (serverListings.length) {
        const byId = new Map((this.state.listings || []).map((l) => [l.id, l]));
        for (const l of serverListings) {
          if (!l?.id) continue;
          byId.set(String(l.id), {
            id: String(l.id),
            kind: normalizeListingKind(l.kind),
            title: String(l.title || ""),
            company: String(l.company || ""),
            location: String(l.location || ""),
            pay: String(l.pay || ""),
            tags: Array.isArray(l.tags) ? l.tags.map(String) : [],
            desc: String(l.desc || ""),
            createdAt: Number(l.createdAt || Date.now()),
            createdBy: "empresa",
            ownerUserId: String(l.ownerUserId || ""),
          });
        }
        this.state.listings = Array.from(byId.values()).sort(
          (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
        );
      }
    },
    setApplicationStatus(appId, status) {
      const allowed = new Set(["enviado", "entrevista", "oferta", "rechazado"]);
      if (!allowed.has(status)) return;
      const app = this.state.applications.find((a) => a.id === appId);
      if (!app) return;
      app.status = status;
      this._persist();
    },
    // Company flow: pipeline per listing
    addCandidateToPipeline(listingId, candidateName) {
      const name = String(candidateName || "").trim();
      if (!name) return;

      // ensure candidate identity exists
      const candidateId = uid("cand");
      const cand = {
        id: candidateId,
        name,
        title: "",
        location: "",
        tags: [],
        about: "",
        cvUrl: "",
        public: true,
      };
      this.state.candidates = Array.isArray(this.state.candidates)
        ? this.state.candidates
        : [];
      this.state.candidates = [cand, ...this.state.candidates];

      const row = {
        id: uid("sel"),
        candidateId,
        name,
        stage: "nuevo",
        notes: "",
        createdAt: Date.now(),
        source: "manual",
      };
      const list = Array.isArray(this.state.pipeline[listingId])
        ? this.state.pipeline[listingId]
        : [];
      this.state.pipeline[listingId] = [row, ...list];
      this._persist();
    },

    // Company: add known candidate to a specific listing's selection process
    addKnownCandidateToSelection(listingId, candidateId, stage = "nuevo") {
      const lid = String(listingId || "");
      const cid = String(candidateId || "");
      const allowed = new Set([
        "nuevo",
        "revisar",
        "entrevista",
        "oferta",
        "descartado",
      ]);
      if (!lid || !cid || !allowed.has(stage)) return;

      const cand = (this.state.candidates || []).find((c) => c.id === cid);
      if (!cand) {
        this.toast = { kind: "info", text: "Candidato no encontrado (demo)." };
        return;
      }

      const list = Array.isArray(this.state.pipeline[lid])
        ? this.state.pipeline[lid]
        : [];
      const exists = list.some((r) => r.candidateId === cid);
      if (exists) {
        this.toast = {
          kind: "info",
          text: "Ese candidato ya está en el proceso.",
        };
        return;
      }

      const row = {
        id: uid("sel"),
        candidateId: cid,
        name: cand.name,
        stage,
        notes: "",
        createdAt: Date.now(),
        source: "known",
      };

      this.state.pipeline[lid] = [row, ...list];
      this._persist();
      this.toast = { kind: "ok", text: "Añadido al proceso de selección." };
    },

    addApplicantToSelection(listingId, candidateId) {
      const lid = String(listingId || "");
      const cid = String(candidateId || "");
      if (!lid || !cid) return;

      const cand = (this.state.candidates || []).find((c) => c.id === cid);
      if (!cand) return;

      const list = Array.isArray(this.state.pipeline[lid])
        ? this.state.pipeline[lid]
        : [];
      const exists = list.some((r) => r.candidateId === cid);
      if (exists) return;

      const row = {
        id: uid("sel"),
        candidateId: cid,
        name: cand.name,
        stage: "nuevo",
        notes: "",
        createdAt: Date.now(),
        source: "applicant",
      };

      this.state.pipeline[lid] = [row, ...list];

      // ensure initial status is visible to candidate
      this._setApplicationStatusByListingCandidate(lid, cid, "enviado");
    },

    toggleCandidateFavorite(listingId, candidateId) {
      const lid = String(listingId || "");
      const cid = String(candidateId || "");
      if (!lid || !cid) return;

      const map = this.state.candidateFavorites || {};
      const list = Array.isArray(map[lid]) ? map[lid].map(String) : [];
      const set = new Set(list);
      if (set.has(cid)) set.delete(cid);
      else set.add(cid);
      map[lid] = Array.from(set);
      this.state.candidateFavorites = map;
      this._persist();
    },
    isCandidateFavorited(listingId, candidateId) {
      const ids = this.state?.candidateFavorites?.[listingId];
      return Array.isArray(ids) ? ids.includes(candidateId) : false;
    },
    moveCandidate(listingId, candidateId, stage) {
      const allowed = new Set([
        "nuevo",
        "revisar",
        "entrevista",
        "oferta",
        "descartado",
      ]);
      if (!allowed.has(stage)) return;
      const list = this.state.pipeline[listingId];
      if (!Array.isArray(list)) return;
      const row = list.find((r) => r.id === candidateId);
      if (!row) return;

      row.stage = stage;

      // If this row corresponds to a real applicant, sync candidate-facing application status
      if (row.candidateId) {
        const status =
          stage === "entrevista"
            ? "entrevista"
            : stage === "oferta"
              ? "oferta"
              : stage === "descartado"
                ? "rechazado"
                : "enviado";
        this._setApplicationStatusByListingCandidate(
          listingId,
          row.candidateId,
          status,
        );
      }

      this._persist();
    },

    _setApplicationStatusByListingCandidate(listingId, candidateId, status) {
      const allowed = new Set(["enviado", "entrevista", "oferta", "rechazado"]);
      if (!allowed.has(status)) return;
      const lid = String(listingId || "");
      const cid = String(candidateId || "");
      if (!lid || !cid) return;
      const appRow = (this.state.applications || []).find(
        (a) => a.listingId === lid && a.candidateId === cid,
      );
      if (!appRow) return;
      appRow.status = status;
    },
    setSelectionNotes(listingId, selectionRowId, notes) {
      const lid = String(listingId || "");
      const rid = String(selectionRowId || "");
      if (!lid || !rid) return;
      const list = this.state.pipeline[lid];
      if (!Array.isArray(list)) return;
      const row = list.find((r) => r.id === rid);
      if (!row) return;
      row.notes = String(notes || "").slice(0, 500);
      this._persist();
    },

    createList(name) {
      const n = String(name || "").trim();
      if (!n) return null;
      const exists = (this.state.lists || []).some(
        (l) => String(l.name).toLowerCase() === n.toLowerCase(),
      );
      if (exists) {
        this.toast = { kind: "info", text: "Esa lista ya existe." };
        return null;
      }
      const list = { id: uid("list"), name: n, createdAt: Date.now() };
      this.state.lists = Array.isArray(this.state.lists)
        ? [list, ...this.state.lists]
        : [list];
      this._persist();
      this.toast = { kind: "ok", text: "Lista creada." };
      return list;
    },

    renameList(listId, name) {
      const lid = String(listId || "");
      const n = String(name || "").trim();
      if (!lid || !n) return;
      const lists = Array.isArray(this.state.lists) ? this.state.lists : [];
      const row = lists.find((l) => l.id === lid);
      if (!row) return;
      const exists = lists.some(
        (l) => l.id !== lid && String(l.name).toLowerCase() === n.toLowerCase(),
      );
      if (exists) {
        this.toast = {
          kind: "info",
          text: "Ya existe otra lista con ese nombre.",
        };
        return;
      }
      row.name = n;
      this._persist();
      this.toast = { kind: "ok", text: "Lista renombrada." };
    },

    addCandidateToList(listId, candidateId) {
      const lid = String(listId || "");
      const cid = String(candidateId || "");
      if (!lid || !cid) return;
      const members = this.state.listMembers || {};
      const arr = Array.isArray(members[lid]) ? members[lid].map(String) : [];
      const set = new Set(arr);
      set.add(cid);
      members[lid] = Array.from(set);
      this.state.listMembers = members;
      this._persist();
      this.toast = { kind: "ok", text: "Añadido a la lista." };
    },

    removeCandidateFromList(listId, candidateId) {
      const lid = String(listId || "");
      const cid = String(candidateId || "");
      if (!lid || !cid) return;
      const members = this.state.listMembers || {};
      const arr = Array.isArray(members[lid]) ? members[lid].map(String) : [];
      members[lid] = arr.filter((x) => x !== cid);
      this.state.listMembers = members;
      this._persist();
    },

    setCandidateCvUrl(candidateId, cvUrl) {
      const cid = String(candidateId || "");
      if (!cid) return;
      const url = String(cvUrl || "").trim();
      this.state.candidates = Array.isArray(this.state.candidates)
        ? this.state.candidates
        : [];
      const idx = this.state.candidates.findIndex((c) => c.id === cid);
      if (idx >= 0)
        this.state.candidates[idx] = {
          ...this.state.candidates[idx],
          cvUrl: url,
        };
      else
        this.state.candidates = [
          {
            id: cid,
            name: "(candidato)",
            title: "",
            location: "",
            tags: [],
            about: "",
            cvUrl: url,
            public: true,
          },
          ...this.state.candidates,
        ];
      this._persist();
    },
    updateProfile(role, patch) {
      if (!this.state.profile[role]) return;
      this.state.profile[role] = { ...this.state.profile[role], ...patch };
      return this._persist();
    },
    importStateFromJsonText(text) {
      const data = JSON.parse(text);
      this.state = normalizeImportedState(data);
      this._applyTheme();
      this._persist();
    },
    clearToast() {
      this.toast = null;
    },
  },
});
