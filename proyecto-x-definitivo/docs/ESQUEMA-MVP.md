# Proyecto X — Esquema técnico (MVP)

> Fuente de verdad de este documento: conversación + consolidación en repo.
> Objetivo: evitar "poner en contexto" cada día.

## Stack

- Persistencia / Fuente de verdad: **PocketBase** (:8090)
- Sesiones + cache inteligente: **KeyDB** (:6379)
- Reverse proxy: **Caddy** (:8787)
- API: **Hono + Bun**
- UI: **Vue + Pinia (JS)**

## Rutas / networking (origen)

- Origen: `http://localhost:8787`
- Web:
  - `/` → `web:5173`
- API:
  - `/api/*` → `api:8787`

## API: responsabilidades

- Auth + sesiones
- State GET/PUT
- Import de docs/links (perfil candidato)

## KeyDB

Claves:
- `px:sess:<sid>` (TTL)
- `px:cache:state:user:<userId>`

Objetivo:
- sesiones
- cache de state (TTL aprox. 10 min)

## PocketBase

Colecciones (MVP):
- `users` (auth)
- `user_state` (state JSON)
- `profile_imports` (docs + links)

## Cache + sesiones: quién manda

- **Fuente de verdad:** PocketBase
- **Aceleradores:** KeyDB (sesiones + cache)

## Flujos

### 1) Login

1. Web → `POST /api/auth/login`
2. API valida credenciales en PocketBase
3. API crea cookie `sid` (**HttpOnly**) + KeyDB `px:sess:<sid>` (con TTL)

### 2) State

- `GET /api/state`
  1. mira cache KeyDB
  2. si miss → lee `user_state` en PocketBase
  3. rellena cache (TTL ~10m)

- `PUT /api/state`
  1. upsert en PocketBase (`user_state`)
  2. refresca cache en KeyDB

### 3) Import (candidato)

- `POST /api/profile/imports/file` (`docType` + file)
  - guarda en PocketBase `profile_imports` (kind=`document`)

- `POST /api/profile/imports/link` (portfolio/behance/dribbble...)
  - guarda en PocketBase `profile_imports`

## UI

- Dirección visual: **terminal minimalism**
- 2 temas: `terminal` / `light`
- Regla: **misma UI; solo cambia paleta** vía variables CSS.
