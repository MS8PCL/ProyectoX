# Informe de Reestructuración — Proyecto X Fase 5

> Fecha: 2026-02-19

---

## Estado general

**Fase 5 (UI Structural) es un esqueleto frontal bien estructurado con arquitectura clara, pero con implementación backend incompleta.**

| Capa | Estado | % estimado |
|---|---|---|
| Frontend (UI / routing / stores) | Bien implementado | ~90% |
| Infraestructura (Docker / Caddy) | Funcional | ~100% |
| Documentación (`docs/`) | Muy completa | ~90% |
| Backend API | **MUY INCOMPLETO** | ~10-15% |
| Integración PocketBase | Documentada, sin usar | ~5% |
| Enterprise Layer | UI existe, API no | ~15% |

---

## Estructura de carpetas

```
fase-5-ui-structural/proyecto-x-definitivo/
├── frontend/          # Vue 3 + Vite (UI)
├── backend/           # Hono + Bun (API)
├── infra/             # Docker, Caddy, configuración
└── docs/              # Documentación técnica
```

### Frontend

```
frontend/src/
├── main.js                        # Entry point, router guards, auth bootstrap
├── App.vue                        # Root component (RouterView)
├── router/index.js                # Vue Router 5 — rutas públicas/privadas
├── stores/
│   ├── auth.js                    # Auth store (Pinia)
│   └── app.js                     # Estado global: listings, applications, favorites(eliminar esta feature por completo de aqui) (720 líneas)
├── lib/
│   ├── api.js                     # Fetch helper (JSON + FormData)
│   └── storage.js                 # localStorage wrapper
├── components/
│   ├── ListingDetail.vue          # Drawer lateral detalle de anuncio
│   ├── CandidateDetail.vue        # Modal perfil candidato
│   ├── ModalShell.vue             # Wrapper modal reutilizable
│   └── ComboBox.vue               # Select dropdown
├── layouts/
│   └── AppLayout.vue              # Sidebar + main + drawer/toast
└── pages/
    ├── HomePage.vue               # Dashboard inicial
    ├── LoginPage.vue              # Formulario login
    ├── RegisterPage.vue           # Desactivado, redirige a login
    ├── ProfilePage.vue            # Editar perfil
    ├── SearchPage.vue             # Buscar anuncios
    ├── PublishPage.vue            # Publicar anuncio (empresa)
    ├── ApplicationsPage.vue       # Mis candidaturas (candidato)
    ├── PipelineServerPage.vue     # Kanban proceso selección (empresa/RRHH)
    ├── FavoritesPage.vue          # Anuncios guardados (esta feature se borra)
    ├── CandidateProfilePage.vue   # Ver perfil candidato (empresa) 
    ├── ApplyPublicPage.vue        # Aplicación pública por token
    └── Enterprise/ (5 páginas)
        ├── EnterpriseDashboardPage.vue
        ├── EnterpriseCatalogPage.vue
        ├── EnterpriseRbacPage.vue
        ├── EnterpriseOutboxPage.vue
        └── EnterpriseHireToolsPage.vue
```

### Backend

```
backend/src/
├── index.js                           # Servidor Hono + middlewares + endpoints básicos
├── pb.cjs                             # Helpers PocketBase (pbRequest, pbAdminAuth, etc.)
├── bootstrap-user-state.cjs           # Inicializa colección user_state en PB
├── bootstrap-profile-imports.cjs      # Inicializa colección profile_imports en PB
├── bootstrap-pocketbase-enterprise.cjs
├── migrate-keydb-state-to-pb.cjs
└── migrate-profile-imports.cjs
```

### Infraestructura

```
infra/
├── docker-compose.yml               # Stack principal (Caddy + Vite + API + PB + KeyDB)
├── docker-compose.enterprise.yml    # Stack paralelo con puertos distintos
├── Dockerfile.caddy
├── Caddyfile                        # /api/* → backend :8787, resto → frontend :5173
├── .env.api.local                   # Credenciales admin PocketBase
└── .env.empty                       # Template vacío
```

---

## Tecnologías y dependencias

### Frontend
| Tecnología | Versión | Rol |
|---|---|---|
| Vue | 3.5.24 | Framework UI (Composition API + SFC) |
| Vue Router | 5.0.2 | Enrutamiento SPA |
| Pinia | 3.0.4 | State management |
| Vite | 7.2.4 | Build tool + dev server |
| Bun | 1.3.8 | Runtime JS (en Docker) |

### Backend
| Tecnología | Versión | Rol |
|---|---|---|
| Hono | 4.6.15 | Framework HTTP |
| @hono/node-server | 1.13.0 | Server adapter |
| Zod | 3.23.8 | Validación de schemas |
| ioredis | 5.7.0 | Cliente Redis / KeyDB |
| Bun | 1.3.8 | Runtime + bundler |

### Infraestructura
| Servicio | Rol |
|---|---|
| PocketBase | Base de datos + Auth |
| KeyDB | Sesiones + caché (Redis compatible) |
| Caddy | Reverse proxy |
| Docker | Orquestación |

---

## Qué está implementado

### Frontend (bien)
- Auth completa: login con cookie HttpOnly, logout, auth guard
- 22+ rutas incluyendo públicas y privadas
- Pinia stores para auth y estado de la app
- `PipelineServerPage` con drag & drop implementado (sin persistencia servidor)
- `ApplyPublicPage` diseñada (sin backend que la soporte)
- CSS con dos temas (terminal / light) usando variables CSS
- Todos los componentes UI principales

### Backend (mínimo)
Solo 5 endpoints implementados:
- `GET /health`
- `GET /me`
- `POST /auth/login` — devuelve usuario **hardcoded**, no conecta a PocketBase (Añadir full feature de login)
- `POST /auth/logout`
- `GET /state` y `PUT /state`

### Infraestructura (completa)
- Stack Docker funcional
- Caddy configurado correctamente
- Stack enterprise paralelo documentado en `infra/README-enterprise-stack.md`

---

## Qué falta — análisis por bloqueos

### Backend: endpoints no implementados (crítico)

| Endpoint | Necesario para |
|---|---|
| `GET /listings` | SearchPage |
| `POST /listings` | PublishPage |
| `POST /listings/:id/apply` | Candidaturas |
| `GET /me/applications` | ApplicationsPage |
| `GET /me/favorites` y `POST` | FavoritesPage |
| `GET /company/listings/:id/applications` | PipelineServerPage |
| `GET /onboarding/status` | Auth guard onboarding |
| `POST /profile/imports/*` | Subir CV / documentos |
| `POST /public/apply/:token` | ApplyPublicPage |
| `GET /company/listings/:id/export.zip` | Exportación candidatos |
| Endpoints enterprise (`/rbac/*`, `/wf/*`, `/outbox/*`) | Enterprise pages |

### Integración PocketBase
- Los helpers en `pb.cjs` existen pero ningún endpoint los llama
- Los bootstrap scripts son manuales — las colecciones pueden no existir si no se ejecutaron
- No está automatizado en Docker

### KeyDB
- `ioredis` está instalado pero no se usa en ningún archivo
- El código de sesiones tiene un `// TODO: lookup session in KeyDB` sin implementar
- Sin KeyDB, las sesiones no se validan correctamente

---

## Problemas e inconsistencias

### Críticos
1. **Login fake** — `POST /auth/login` devuelve un usuario hardcoded, nunca toca PocketBase ni KeyDB
2. **15+ endpoints necesarios no existen** — el frontend cae en modo degradado (localStorage)
3. **KeyDB no se usa** — sesiones sin persistencia real
4. **Bootstrap scripts manuales** — las colecciones de PocketBase pueden no existir

### Moderados
5. **Enterprise pages sin backend** — 5 páginas UI, 0 endpoints implementados
6. **ApplyPublicPage inutilizable** — no hay validación de token ni colección `apply_tokens`
7. **PipelineServerPage sin persistencia** — drag & drop funciona solo en cliente
8. **ProfilePage** — edición local funciona, guardado a servidor requiere endpoint inexistente

### Menores
9. **`bun.lock` no versionado** — Dockerfile lo copia pero puede no existir
10. **CSS sin media queries** — posibles problemas en mobile
11. **Validación Zod solo en login** — resto de endpoints sin validación de entrada
12. **`normalizeImportedState()` frágil** — limpia strings hardcoded de demo data (150+ líneas)

---

## READMEs del proyecto

| Archivo | Contenido |
|---|---|
| `README.md` (raíz repo) | Solo dice `# ProyectoX` — vacío |
| `README-UBICACION.md` | Explica el path del proyecto y problemas con OpenClaw |
| `frontend/README.md` | Boilerplate genérico de Vite, sin info del proyecto |
| `infra/README-enterprise-stack.md` | Instrucciones para levantar stack enterprise en puertos paralelos |

---

## Arquitectura actual

```
┌─────────────────────────────────────────────────────────────┐
│ CLIENTE (Browser) — http://localhost:8787                   │
│ Vue 3 App (Pinia) — 22+ rutas                               │
└─────────────────────────────────────────────────────────────┘
                          │ HTTP
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ CADDY (Reverse Proxy, :8787)                                │
│ /api/* → backend :8787   |   resto → Vite :5173             │
└─────────────────────────────────────────────────────────────┘
          │                                    │
          ▼                                    ▼
┌────────────────────────┐       ┌─────────────────────────┐
│ Hono Backend (:8787)   │       │ Vite Dev Server (:5173) │
│ ✓ GET /health          │       │ Vue SFC + HMR            │
│ ✓ GET /me              │       └─────────────────────────┘
│ ✓ POST /auth/login     │
│ ✓ POST /auth/logout    │
│ ✓ GET|PUT /state       │
│ ✗ 15+ endpoints        │
│ ✗ Enterprise endpoints │
└────────────────────────┘
          │ (sin implementar)
          ▼
┌─────────────────────────────────────────────────────────────┐
│ PocketBase (:8090) — Schema documentado, sin acceso real    │
│ users · user_state · listings · applications · profiles     │
│ + 8 colecciones enterprise                                  │
└─────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ KeyDB (:6379) — instalado, no usado                         │
│ px:sess:<sid>  ·  px:cache:*                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Próximos pasos recomendados

1. **Implementar endpoints principales en backend** — los 15+ endpoints que el frontend ya llama
2. **Conectar login a PocketBase** — reemplazar el usuario hardcoded
3. **Activar KeyDB para sesiones** — el TODO ya está identificado en `index.js`
4. **Automatizar bootstrap de PocketBase** — ejecutar scripts al arrancar Docker
5. **Implementar enterprise endpoints** — RBAC, workflow, outbox
6. **Resolver ApplyPublicPage** — crear colección `apply_tokens` y endpoint POST
7. **Añadir persistencia a PipelineServerPage** — conectar drag & drop con API
