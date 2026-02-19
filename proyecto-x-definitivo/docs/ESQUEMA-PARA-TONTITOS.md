# Proyecto X — Esquema “para tontitos” (Figma-style)

> Objetivo: entender de un vistazo qué es cada pieza y cómo fluye todo.

---

## FRAME 1 — Arquitectura (MVP)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ CLIENTE (Tu navegador)                                                       │
│ URL entrada: http://localhost:8787                                           │
│                                                                              │
│ UI (Vue): Buscar · Publicar · Perfil · Candidaturas · Proceso Selección · Fav│
└──────────────────────────────────────────────────────────────────────────────┘
                          │
                          │ HTTP
                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ CADDY (Reverse Proxy / “Portero”)                                            │
│ Escucha: :8787                                                               │
│                                                                              │
│ Reglas:                                                                      │
│  - /api/*  ───────────────► API (Bun/Hono)                                   │
│  - resto  ────────────────► WEB (Vue/Vite)                                   │
└──────────────────────────────────────────────────────────────────────────────┘
            │                                               │
            │                                               │
            ▼                                               ▼
┌──────────────────────────────────────────┐   ┌──────────────────────────────────────────┐
│ WEB (Frontend)                           │   │ API (Backend)                            │
│ Vue + Pinia                              │   │ Bun + Hono                               │
│ Puerto interno: 5173                     │   │ Puerto interno: 8787                     │
│                                          │   │                                          │
│ - Renderiza páginas                      │   │ - Auth + sesión (cookie sid)             │
│ - Llama a /api/...                       │   │ - Onboarding obligatorio (perfil)        │
│                                          │   │ - Listings (ofertas)                     │
│                                          │   │ - Applications (candidaturas/pipeline)   │
│                                          │   │ - CV seguro                              │
│                                          │   │ - Favoritos candidato (server)           │
└──────────────────────────────────────────┘   └──────────────────────────────────────────┘
                                                     │
                                                     │ reads/writes
                                                     ▼
                         ┌──────────────────────────────────────────┐
                         │ POCKETBASE (DB / Fuente de verdad)        │
                         │ Puerto: 8090  Dashboard: /_/              │
                         │                                           │
                         │ Colecciones:                               │
                         │ - users                                    │
                         │ - candidate_profiles / company_profiles    │
                         │ - listings                                 │
                         │ - applications                             │
                         │ - profile_imports (CV/docs)                │
                         │ - listing_favorites                        │
                         │ - user_state (si queda legacy)             │
                         └──────────────────────────────────────────┘
                                                     │
                                                     │ sesiones/cache
                                                     ▼
                         ┌──────────────────────────────────────────┐
                         │ KEYDB (Sesiones + cache)                  │
                         │ Puerto: 6379                              │
                         │ - px:sess:<sid> (TTL)                     │
                         │ - cache si aplica                         │
                         └──────────────────────────────────────────┘
```

---

## FRAME 2 — Flujos (lo que pasa cuando haces click)

### A) LOGIN (candidato/empresa)

```
Browser ──POST /api/auth/login──► API ──auth──► PocketBase(users)
Browser ◄── set-cookie sid ────── API ──store sid──► KeyDB(px:sess:...)
```

### B) ONBOARDING (perfil obligatorio)

```
Browser ── GET /api/onboarding/status ──► API ──► PocketBase(candidate_profiles/company_profiles)
Si incompleto: API responde 403 profile_incomplete y te manda a Perfil
```

### C) PUBLICAR (empresa)

```
Browser(UI Publicar) ──POST /api/listings──► API ──► PocketBase(listings)
Browser(UI Buscar)    ◄─GET  /api/listings── API ◄── PocketBase(listings)
```

### D) APLICAR (candidato)

```
Browser(UI Detalle) ──POST /api/listings/:id/apply──► API ──► PocketBase(applications)
```

### E) CANDIDATURAS (candidato)

```
Browser(UI Candidaturas) ──GET /api/me/applications──► API ──► PocketBase(applications + listings)
```

### F) PROCESO DE SELECCIÓN (empresa)

```
Browser(UI Proceso) ──GET /api/company/listings/:id/applications──► API ──► PocketBase(applications)
Browser(DnD/Notas)  ──PATCH /api/company/applications/:id─────────► API ──► PocketBase(applications)
```

### G) VER CV (empresa, con permiso)

```
Browser ──GET /api/company/candidates/:userId/cv──► API
API comprueba relación en PocketBase(applications)
API devuelve URL del fichero en PocketBase(profile_imports)
Browser abre el PDF
```

### H) FAVORITOS (candidato)

```
Browser ──POST /api/me/favorites/:listingId/toggle──► API ──► PocketBase(listing_favorites)
Browser ──GET  /api/me/favorites────────────────────► API ──► PocketBase(listing_favorites)
```

---

## Chuleta de puertos

- **8787** → Entrada única (Caddy) / lo que abres en el navegador
- **8090** → PocketBase (dashboard)
- **6379** → KeyDB

---

## Nota

Este esquema describe el estado actual en local (Docker + Caddy). No incluye nada de Coolify.
