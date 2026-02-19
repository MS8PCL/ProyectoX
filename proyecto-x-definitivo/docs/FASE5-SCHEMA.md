# FASE 5 – Schema & Endpoints (Checkpoint)

> Plan A aprobado: `profile_imports.applicationId` es **TEXT**, no relation.

## Colecciones tocadas

### `profile_imports`
- **Nuevo campo:** `applicationId` (text, optional)
- **Índice:** `idx_profile_imports_applicationId` (non-unique) sobre `(applicationId)`

### `applications`
- **Nuevo campo:** `birthDate` (date, required)
- **Nuevo campo:** `coverLetter` (text, required)
- `candidateUserId` ahora **required=false** (permitir aplicación pública sin usuario previo)

### `candidate_profiles`
- **Nuevos campos:** `email`, `firstName`, `lastName` (para upsert por email en apply público)
- `title` y `location` pasan a **opcionales** (para no inventar valores en apply público)
- **Nota:** índice en `email` es **NO-UNIQUE** por legacy data

### `apply_tokens` (nueva)
Campos:
- `tokenHash` (text) – almacenar hash SHA256 del token
- `applicationId` (text)
- `expiresAt` (date, required)
- `active` (bool, **required=false**; PocketBase considera `false` como blank si required=true)
- `usedAt` (date)
- `usedByEmail` (email)
- `createdAt` (date)
- `createdByUserId` (text)

## Endpoints

### Interno
- `POST /api/interno/apply_tokens` → genera link `/apply/:token` (expiración obligatoria)
- `GET /api/interno/applications/:id/export.zip` → ZIP completo por candidatura

### Público
- `GET /api/apply/:token` → valida token (404/409/410)
- `POST /api/public/apply/:token` → submit multipart + validación server-side + single-use

## Export ZIP
Estructura:
- `application.json`
- `candidate.json`
- `documents/`
  - `cv.pdf` (+ `cv-02.pdf` si hay varios)
  - `cert-01.pdf`, `cert-02.pdf`, ...
- `README.txt`
- `checksums.txt` (SHA256)

Filtro de documentos:
- `profile_imports.applicationId == :id`
