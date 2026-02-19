# Enterprise HR→IT layer — checklist (MVP)

## PocketBase schema
- [x] Script creates enterprise collections: `backend/src/bootstrap-pocketbase-enterprise.cjs`
- [x] Unique simulation fields: `unique_key`, `idempotency_key`
- [x] Append-only logs: `audit_log`, `workflow_event_log` (`updateRule=false`, `deleteRule=false`)

## Backend endpoints
- [x] Correlation middleware: `x-correlation-id`
- [x] Helpers: `audit()`, `wfEvent()`, `createOrGetByUnique()`

### RBAC
- [x] POST `/rbac/preview`
- [x] GET `/rbac/preview/:hireId`

### Workflow
- [x] POST `/wf/transition`

### Outbox / OTRS manual export
- [x] POST `/outbox/enqueue/otrs_create_ticket`
- [x] GET `/outbox/:id/export`
- [x] POST `/outbox/:id/mark_exported`
- [x] POST `/otrs/link`
- [x] POST `/mock/otrs/simulate/:entityId`

## UI (minimal)
- [x] `/enterprise/dashboard`
- [x] `/enterprise/catalog`
- [x] `/enterprise/rbac`
- [x] `/enterprise/outbox`
- [x] `/enterprise/hire-tools`

## Manual test plan
1) Apply schema:
   - Run `node backend/src/bootstrap-pocketbase-enterprise.cjs`
2) Create sample catalog items:
   - `catalog_items` type=access_profile key=AP_FIN_READ
   - `access_profile_entitlements` for that profile (ad_group)
3) Create RBAC rule:
   - condition: { departmentKey: "DEPT_FIN", jobTitleKey: "JT_ANALYST" }
   - result_access_profiles: [AP_FIN_READ]
4) Generate preview:
   - Open UI → Enterprise → Hire Tools → Generar preview
5) Create a workflow_instance in PB manually for now:
   - workflow_key=hire_standard, workflow_version=1, current_state_key=start, status=active
6) Enqueue outbox:
   - Hire Tools: set workflowInstanceId and Enqueue otrs_create_ticket
7) Export payload:
   - Enterprise → Outbox → Export
8) Mark exported + link ticket:
   - POST /outbox/:id/mark_exported then POST /otrs/link
9) Mock simulate:
   - Hire Tools → Mock simulate ticket

## Known constraints (MVP)
- Guards use a heuristic for `hire_profile_complete` based on RBAC preview inputs.
- No dedicated `hires` collection yet; entity_id is a string.
- Enterprise list endpoints exist implicitly via PB admin reads (UI calls `/enterprise/*`).
