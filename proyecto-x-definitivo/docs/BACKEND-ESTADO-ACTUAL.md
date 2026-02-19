# Backend — Estado actual

> Fecha: 2026-02-19

---

## Resumen ejecutivo

El backend es un servidor Hono mínimo. Tiene 5 endpoints operativos, todos superficiales: el login no conecta a ninguna base de datos, las sesiones no se persisten en KeyDB, y PocketBase no se toca en ningún momento durante el ciclo de vida de una petición normal. Los helpers y scripts de bootstrap existen y están bien escritos, pero son código muerto desde el punto de vista del servidor.

---

## Archivos del backend

```
backend/
├── package.json
└── src/
    ├── index.js                           # Servidor principal (único archivo activo)
    ├── pb.cjs                             # Helpers PocketBase (no usado desde index.js)
    ├── bootstrap-user-state.cjs           # Script one-off: crea colección user_state
    ├── bootstrap-profile-imports.cjs      # Script one-off: crea colección profile_imports
    ├── bootstrap-pocketbase-enterprise.cjs # Script one-off: crea 13 colecciones enterprise (SE BORRA)
    ├── migrate-keydb-state-to-pb.cjs      # Migración legacy (no relevante para MVP)
    └── migrate-profile-imports.cjs        # Migración legacy (no relevante para MVP)
```

---

## Dependencias (`package.json`)

| Paquete | Versión | Uso real |
|---|---|---|
| `hono` | ^4.6.15 | Sí — framework HTTP |
| `@hono/node-server` | ^1.13.0 | Sí — adapter para correr con Node/Bun |
| `zod` | ^3.23.8 | Parcial — solo en el schema de login |
| `ioredis` | ^5.7.0 | No — instalado, sin ningún uso |

Nota: `package.json` declara `"type": "commonjs"` pero `index.js` usa ESM (`import`). Los scripts de bootstrap sí usan `.cjs` correctamente.

---

## `index.js` — El servidor

### Configuración de entorno

```js
const env = {
  PORT: Number(process.env.PORT ?? 8787),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? 'false') === 'true',
}
```

Variables esperadas: `PORT`, `WEB_ORIGIN`, `COOKIE_SECURE`. No lee `POCKETBASE_URL`, `PB_ADMIN_EMAIL`, `REDIS_URL` ni nada relacionado con los servicios externos.

### CORS

CORS manual en middleware global. Permite solo `WEB_ORIGIN`, con credenciales. Solo métodos `GET`, `POST`, `OPTIONS`. No hay `PUT` ni `DELETE` permitidos (bloquearía endpoints futuros si no se actualiza).

### Endpoints implementados

#### `GET /health`
Devuelve `{ ok: true }`. Funcional.

#### `GET /me`
```js
app.get('/me', (c) => {
  const sid = getCookie(c.req.raw, 'sid')
  if (!sid) return c.json({ user: null })
  // TODO: lookup session in KeyDB + fetch user in PocketBase
  return c.json({ user: { id: 'demo', email: 'demo@local', sid } })
})
```
Lee la cookie `sid`. Si existe, devuelve siempre el mismo usuario hardcoded `{ id: 'demo', email: 'demo@local' }`. No valida la sesión, no consulta KeyDB, no consulta PocketBase.

#### `POST /auth/login`
```js
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

app.post('/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

  const sid = `dev_${crypto.randomUUID()}`
  setSidCookie(c, sid)
  return c.json({ ok: true })
})
```
Valida formato con Zod (email + password no vacío). Genera un `sid` aleatorio con prefijo `dev_`. Establece la cookie. No consulta PocketBase, no verifica credenciales, no guarda la sesión en KeyDB. Cualquier email/password válidos en formato funcionan.

#### `POST /auth/logout`
Limpia la cookie `sid` con `Max-Age=0`. Funcional en cuanto a limpiar la cookie del cliente, pero como no hay sesión en KeyDB tampoco hay nada que invalidar en servidor.

#### `GET /state` y `PUT /state`
No aparecen implementados en `index.js`. El informe de exploración los mencionaba como existentes pero el archivo leído no los contiene — o bien están en una versión del archivo no sincronizada, o bien no están implementados.

### Gestión de cookies

Implementado manualmente con funciones helper:
- `getCookie(req, name)` — parsea el header `Cookie`
- `setSidCookie(c, sid)` — cookie `HttpOnly`, `SameSite=Lax`, `Max-Age=86400` (24h), `Secure` condicional
- `clearSidCookie(c)` — mismos atributos con `Max-Age=0`

---

## `pb.cjs` — Helpers PocketBase

Módulo CommonJS con 5 funciones. **No se importa desde `index.js`.** Es código preparado pero sin conectar.

| Función | Qué hace |
|---|---|
| `pbRequest(baseUrl, path, init)` | Fetch genérico a PocketBase con manejo de errores y parsing JSON |
| `pbRequestAuthed(baseUrl, token, path, init)` | Igual que el anterior pero añade `Authorization: Bearer <token>` |
| `pbAuthWithPassword(baseUrl, email, password)` | Autentica un usuario en `POST /api/collections/users/auth-with-password` |
| `pbAdminAuth(baseUrl, email, password)` | Autentica como superadmin. Intenta `_superusers` primero, cae en `/api/admins` si 404 (compatibilidad versiones) |
| `pbCreateUser(baseUrl, adminToken, email, password, role)` | Crea un usuario en la colección `users` con rol `worker` por defecto |

El error handling lanza excepciones con `err.status` y `err.body` adjuntos, lo que está bien diseñado para uso futuro.

---

## Scripts de bootstrap

Son scripts one-off que se ejecutan manualmente dentro del contenedor del backend. No son parte del servidor y no se ejecutan al arrancar.

### `bootstrap-user-state.cjs`

Crea la colección `user_state` en PocketBase si no existe.

**Schema de la colección:**
| Campo | Tipo | Notas |
|---|---|---|
| `userId` | text | Requerido, max 40 chars |
| `state` | json | Requerido, sin límite de tamaño |

**Reglas de acceso:** `userId = @request.auth.id` en todas las operaciones. Solo el propio usuario puede leer/escribir su estado.

### `bootstrap-profile-imports.cjs`

Crea la colección `profile_imports` si no existe.

**Schema de la colección:**
| Campo | Tipo | Notas |
|---|---|---|
| `userId` | text | Requerido |
| `kind` | select | `linkedin_pdf`, `cv`, `portfolio`, `behance`, `dribbble` |
| `url` | text | Opcional, max 2048 |
| `file` | file | PDF, max 1 archivo |
| `consentText` | text | Requerido |
| `rawText` | text | Opcional, max 50000 chars |

**Reglas de acceso:** igual que `user_state`, solo el propio usuario.

### `bootstrap-pocketbase-enterprise.cjs`

El más completo. Crea 13 colecciones y parchea la colección `users`. Requiere `POCKETBASE_URL`, `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD`.

**Modificación a `users`:** añade campo `corpRole` (select: `HR`, `IT`, `FINANCE`, `ADMIN`).

**Colecciones enterprise creadas:**

| Colección | Propósito |
|---|---|
| `catalog_items` | Catálogo de departamentos, puestos, perfiles de acceso, hardware |
| `catalog_revisions` | Historial versionado de cada item del catálogo |
| `rbac_rules` | Reglas de asignación de perfiles de acceso (con condiciones JSON) |
| `access_profile_entitlements` | Permisos concretos por perfil (AD groups, licencias, app roles) |
| `permission_previews` | Snapshot calculado de permisos para una contratación |
| `workflow_definitions` | Definición de workflows (versionados, con estado draft/published) |
| `workflow_states` | Estados de un workflow (start / normal / terminal) |
| `workflow_transitions` | Transiciones entre estados (con guards, conditions, actions en JSON) |
| `workflow_instances` | Instancias activas de un workflow asociadas a una entidad (`hire`) |
| `workflow_event_log` | Log inmutable de eventos de workflow |
| `approval_policies` | Políticas de aprobación multi-step versionadas |
| `approval_instances` | Instancias de aprobación por entidad |
| `approval_step_instances` | Pasos individuales de cada aprobación |
| `integration_outbox` | Cola de mensajes salientes (OTRS, email, mock) con retry |
| `audit_log` | Log inmutable de auditoría general |
| `otrs_ticket_links` | Vínculos a tickets OTRS por entidad |

**Reglas de acceso enterprise:**
- Lectura: cualquier usuario autenticado (`@request.auth.id != ""`)
- Escritura: solo usuarios con `corpRole = "ADMIN"` o a través del backend con token admin
- `workflow_event_log` y `audit_log`: sin update ni delete (append-only)

---

## Estado de KeyDB

`ioredis` está en `package.json`. No hay ningún `import` ni `require` de `ioredis` en ningún archivo del backend. KeyDB no se usa en absoluto.

El plan documentado (en comentarios del código y en docs/) era:
- `px:sess:<sid>` → TTL 24h, almacena `{ userId, email, role }`
- `px:cache:*` → caché de queries frecuentes a PocketBase

Ninguna de esas claves se escribe ni se lee.

---

## Diagrama del flujo de login actual vs. el esperado

### Flujo actual (lo que pasa hoy)
```
Cliente → POST /auth/login { email, password }
  → Hono valida formato con Zod
  → Genera sid aleatorio (dev_<uuid>)
  → Set-Cookie: sid=...
  → { ok: true }

Cliente → GET /me
  → Hono lee cookie sid
  → Si existe: { user: { id: 'demo', email: 'demo@local' } }
  → Si no existe: { user: null }
```

### Flujo esperado (lo que debería pasar)
```
Cliente → POST /auth/login { email, password }
  → Hono valida formato con Zod
  → pbAuthWithPassword(PB_URL, email, password)   ← llamada a PocketBase
  → Si error: 401
  → Genera sid = crypto.randomUUID()
  → redis.set(`px:sess:${sid}`, JSON.stringify({ userId, email, role }), 'EX', 86400)
  → Set-Cookie: sid=...
  → { ok: true }

Cliente → GET /me
  → Lee cookie sid
  → session = await redis.get(`px:sess:${sid}`)
  → Si no existe: { user: null }
  → { user: JSON.parse(session) }
```

---

## Problemas concretos

1. **Login fake** — cualquier email bien formado y password no vacío inicia sesión. Las credenciales no se verifican.

2. **Sesiones sin persistencia** — el `sid` se genera y se manda al cliente pero nunca se guarda en ningún sitio. Si el servidor se reinicia, todas las sesiones del cliente siguen "válidas" (la cookie existe) pero el servidor siempre devuelve `demo@local` de todas formas.

3. **`ioredis` sin usar** — dependencia instalada, cero líneas de código que la usen.

4. **`pb.cjs` sin conectar** — 5 helpers bien escritos que no se importan desde `index.js`.

5. **CORS sin `PUT`/`DELETE`/`PATCH`** — el middleware solo permite `GET`, `POST`, `OPTIONS`. Cualquier endpoint que necesite `PUT` o `PATCH` (ej: actualizar perfil) fallará con CORS si se añade sin actualizar el middleware.

6. **Bootstrap no automatizado** — las colecciones de PocketBase no existen hasta que alguien ejecute los scripts manualmente. Sin `user_state`, `profile_imports` y las colecciones enterprise, cualquier endpoint que intente escribir en PocketBase fallará con 404.

7. **`type: "commonjs"` en `package.json` vs. ESM en `index.js`** — inconsistencia. `index.js` usa `import`/`export` ESM pero el paquete se declara CommonJS. Funciona con Bun pero puede dar problemas con Node estándar.
