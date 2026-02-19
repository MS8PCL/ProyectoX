# Enterprise HR→IT layer — PocketBase schema

This project bootstraps the enterprise HR→IT provisioning layer schema using:

- `backend/src/bootstrap-pocketbase-enterprise.cjs`

## How to apply

```bash
export POCKETBASE_URL=http://127.0.0.1:8090
export PB_ADMIN_EMAIL=...
export PB_ADMIN_PASSWORD=...
node backend/src/bootstrap-pocketbase-enterprise.cjs
```

## Collections created

- catalog_items, catalog_revisions
- rbac_rules, access_profile_entitlements, permission_previews
- workflow_definitions, workflow_states, workflow_transitions, workflow_instances, workflow_event_log
- approval_policies, approval_instances, approval_step_instances
- integration_outbox, otrs_ticket_links
- audit_log

## Notes

- Composite uniqueness is simulated via explicit `unique_key`/`idempotency_key` fields + unique indexes.
- `workflow_event_log` and `audit_log` are append-only (`updateRule=false`, `deleteRule=false`).
- The script also patches the `users` collection adding `corpRole` (HR|IT|FINANCE|ADMIN) used in basic rules.
