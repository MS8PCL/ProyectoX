# Enterprise stack (parallel) — run on different ports

This repo includes an **additional** docker compose file to run a second instance **in parallel** with the existing stack.

## Ports

- Proxy (web+api): http://localhost:8791
- PocketBase admin/API (direct): http://localhost:8092
- KeyDB (direct): 6381

## Start

```bash
cd infra
# IMPORTANT: use a different project name (-p) to avoid touching the old stack
# even if service names are the same.
docker compose -p proyecto-x-ent -f docker-compose.enterprise.yml up -d --build
```

## Stop

```bash
cd infra
docker compose -p proyecto-x-ent -f docker-compose.enterprise.yml down
```

## Notes

- Containers are named `proyecto-x-ent-*` to avoid clashes.
- PocketBase data is stored in a separate named volume: `pb_data_ent`.
- Inside the docker network, services still talk via `pocketbase:8090` and `keydb:6379`.
