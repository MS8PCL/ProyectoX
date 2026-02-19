# FASE 4 — Auditoría del repo ACTUAL (f04ec60 / fase-3-stable)

> Objetivo: Inventario real de UI vs backend vs PocketBase. Detectar piezas fantasma, enlaces rotos, rutas no enroutadas y colecciones/campos huérfanos.

## Contexto de auditoría
- Repo: `/Users/manuserrano/C:\Users\Manu\.openclaw\workspace/projects/proyecto-x-definitivo`
- HEAD: `f04ec60` (tag `fase-3-stable`)
- Stack: `infra/docker-compose.yml` (Caddy proxy :8787, API :8787, Web :5173 behind proxy, PocketBase :8090, KeyDB :6379)

## Evidencia UI (capturas)
Carpeta: `MEDIA/fase-4/` (pendiente de copiar desde OpenClaw MEDIA; ver referencias abajo)
- Home `/`: `MEDIA:/Users/manuserrano/.openclaw/media/browser/04475493-613f-4602-b0a1-736bf6bd84b7.jpg`
- Pipeline `/interno/seleccion`: `MEDIA:/Users/manuserrano/.openclaw/media/browser/e3c8e895-f70c-4eb1-b33a-9a648d636160.jpg`
- Outbox `/interno/altas`: `MEDIA:/Users/manuserrano/.openclaw/media/browser/6250ebba-6bc2-406b-bf5c-b1eb4f59649f.jpg`

## A) Rutas UI reales (router)
Fuente: `frontend/src/router/index.js`

### Rutas públicas
- `/login`
- `/register` → redirect `/login` (deshabilitado)

### Rutas privadas (bajo layout `/`)
- `/` (Home)
- `/buscar`
- `/publicar`
- `/candidaturas`
- `/candidatos` (PipelineServerPage) + alias: `pipeline`, `proceso-seleccion`, `proceso-server`, `/interno/seleccion`
- `/perfil`
- `/favoritos`

Enterprise HR→IT
- `/enterprise/dashboard`
- `/enterprise/catalog`
- `/enterprise/rbac`
- `/enterprise/outbox` + alias `/interno/altas`
- `/enterprise/hire-tools`

Otros
- `/candidatos/:candidateId`
- `/:pathMatch(.*)*` (NotFound)

## B) Páginas existentes en `frontend/src/pages` pero NO enroutadas (funcionalidad fantasma)
Listado real de archivos:
- `ApplicationsPage.vue` ✅ enroutada
- `CandidateProfilePage.vue` ✅ enroutada
- `DataPage.vue` ❌ NO enroutada
- `EnterpriseCatalogPage.vue` ✅
- `EnterpriseDashboardPage.vue` ✅
- `EnterpriseHireToolsPage.vue` ✅
- `EnterpriseOutboxPage.vue` ✅
- `EnterpriseRbacPage.vue` ✅
- `FavoritesPage.vue` ✅
- `HomePage.vue` ✅
- `ImportPage.vue` ❌ NO enroutada
- `ListsPage.vue` ❌ NO enroutada
- `LoginPage.vue` ✅
- `NotFoundPage.vue` ✅
- `PipelinePage.vue` ❌ NO enroutada (pero hay alias string `pipeline` apuntando a `/candidatos`)
- `PipelineServerPage.vue` ✅
- `PlansPage.vue` ❌ NO enroutada
- `ProfilePage.vue` ✅
- `ProjectDetailPage.vue` ❌ NO enroutada
- `ProjectsPage.vue` ❌ NO enroutada
- `PublishPage.vue` ✅
- `RegisterPage.vue` (existe el archivo pero la ruta está deshabilitada) ⚠️ fantasma
- `SearchPage.vue` ✅
- `SettingsPage.vue` ❌ NO enroutada

### Observación
Estas páginas no enroutadas son deuda/ruido: o se eliminan, o se enroutan bajo una sección explícita de admin/debug (con permisos) o se documenta su estado.

## C) Enlaces rotos / navegación incoherente
### `/pipeline` en Home
Fuente: `frontend/src/pages/HomePage.vue`
- En modo empresa, el CTA usa `:to="... ? '/candidaturas' : '/pipeline'"`.
- Existe un alias **string** `pipeline` dentro de la ruta `/candidatos` (router), lo cual termina resolviendo a `/pipeline` y funciona.
- Pero esto es confuso porque la ruta canónica es `/candidatos` y la ruta requerida del producto es `/interno/seleccion`.

**Recomendación para fase de coherencia:** normalizar CTA a `/interno/seleccion` para evitar tres rutas (candidatos/pipeline/interno/seleccion).

## D) Backend — endpoints reales
Fuente: `backend/src/index.cjs` (extractor simple de `app.METHOD('/path'`)

### Salud / sesión
- `GET /api/health`
- `GET /api/me`
- `POST /api/auth/register` → 410 (public signup deshabilitado)
- `POST /api/auth/login`
- `POST /api/auth/logout`

### ATS
- `GET /api/profile`
- `PUT /api/profile`
- `GET /api/onboarding/status` (nota: internal roles bypass en `requireCompleteProfile`)
- `GET /api/listings` (feed)
- `POST /api/listings` (creación interna)
- `POST /api/listings/:id/apply` → 410 (public apply deshabilitado)
- `GET /api/company/listings/:id/applications`
- `PATCH /api/company/applications/:id` (stage+notes)
- `GET /api/company/candidates/:candidateUserId/profile`
- `GET /api/company/candidates/:candidateUserId/cv`

### Candidate portal (deshabilitado)
- `GET /api/me/applications` → 410
- `GET /api/me/favorites` → 410
- `POST /api/me/favorites/:listingId/toggle` → 410

### Estado app
- `GET /api/state`
- `PUT /api/state`

### Documentos/imports
- `GET /api/profile/imports`
- `POST /api/profile/imports/link`
- `POST /api/profile/imports/file`

### Enterprise / Alta IT
- `GET /api/enterprise/catalog/items`
- `GET /api/enterprise/rbac/rules`
- `GET /api/enterprise/outbox`
- `GET /api/interno/departments`
- `GET /api/interno/job_titles`
- `POST /api/interno/hire/enqueue_it_request` (Alta IT: crea hire_profile + outbox snapshot + stage->hired)
- `GET /api/outbox/:id/export`
- `POST /api/outbox/:id/mark_exported`

### OTRS mock / RBAC tools
- `POST /api/outbox/enqueue/otrs_create_ticket`
- `POST /api/otrs/link`
- `POST /api/mock/otrs/simulate/:entityId`
- `POST /api/rbac/preview`
- `GET /api/rbac/preview/:hireId`
- `POST /api/wf/transition`

## E) PocketBase — colecciones relevantes y uso
Fuente: PocketBase `/api/collections?perPage=200`

Colecciones:
- `users` (auth)
- `user_state` (estado app)
- `listings` (ATS)
- `applications` (ATS)
- `candidate_profiles` (ATS)
- `company_profiles` (ATS / internal)
- `profile_imports` (documentos)
- `listing_favorites` (portal candidato; endpoints 410 ahora)
- `departments` (catálogo Alta IT)
- `job_titles` (catálogo Alta IT)
- `hire_profiles` (Alta IT)
- `integration_outbox` (Alta IT snapshot)
- `audit_log` (auditoría)

### Colecciones potencialmente huérfanas / en duda
- `listing_favorites`: existe en PB pero el backend lo ha deshabilitado (410). Puede considerarse “huérfana” hasta que exista invitación/apply.

## F) Funcionalidades fantasma (resumen)
UI que existe pero no está accesible:
- Import/Export JSON pages (`ImportPage.vue`, `DataPage.vue`) — no enroutadas.
- Varias páginas (Lists/Plans/Settings/Projects/ProjectDetail/PipelinePage) — no enroutadas.

Backend endpoints no reflejados en UI (posible gap):
- `POST /wf/transition`, `POST /rbac/preview`, `GET /rbac/preview/:hireId`, `POST /otrs/link`, `POST /mock/otrs/simulate/:entityId` — no está claro su uso UI actual.

UI que muestra elementos “de candidato” aunque el portal está deshabilitado:
- `AppLayout` sigue teniendo condicionales para `app.role === 'candidato'` (Candidaturas/Favoritos). En internal-only esto debería quedar siempre en modo empresa.

## G) Lista de gaps a resolver en Fase 4 (post-auditoría, NO implementar aún)
1) Normalizar navegación: Home CTA a `/interno/seleccion` (y eliminar dependencia de `/pipeline`).
2) Eliminar/ocultar definitivamente rutas/elementos de portal candidato en UI (sidebar y páginas candidaturas/favoritos) cuando está internal-only.
3) Decidir destino de páginas no enroutadas: borrar vs enroutar bajo /admin/debug.
4) Revisar endpoints “tools” no usados y decidir: documentar o eliminar.
5) Documentos: verificar si el botón CV (abre URL de PB) cumple seguridad/permiso y UX (visor embebido pendiente si se exige).

