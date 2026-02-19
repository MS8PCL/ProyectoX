#!/usr/bin/env bash
set -euo pipefail

# Proyecto X smoke test
# Usage:
#   ./backend/scripts/smoke.sh
# Assumes the docker-compose stack is already up (infra/docker-compose.yml)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INFRA_DIR="$ROOT_DIR/infra"
BASE_URL="${PX_BASE_URL:-http://localhost:8787}"
API="$BASE_URL/api"

log() { printf "[%s] %s\n" "$(date +%H:%M:%S)" "$*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }
need_cmd curl
need_cmd node
need_cmd docker

read_env_kv() {
  # naive .env parser: KEY=VALUE lines, ignores comments/empty
  local file="$1" key="$2"
  node - "$file" "$key" <<'NODE'
const fs = require('fs');
const [file, key] = process.argv.slice(2);
const txt = fs.readFileSync(file,'utf8');
for (const line of txt.split(/\r?\n/)) {
  const l = line.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('=');
  if (i < 1) continue;
  const k = l.slice(0,i).trim();
  if (k !== key) continue;
  let v = l.slice(i+1);
  // strip optional quotes
  v = v.replace(/^"|"$/g,'').replace(/^'|'$/g,'');
  process.stdout.write(v);
  process.exit(0);
}
process.exit(2);
NODE
}

json_get() {
  local file="$1" path="$2"
  node - "$file" "$path" <<'NODE'
const fs = require('fs');
const [file, path] = process.argv.slice(2);
const obj = JSON.parse(fs.readFileSync(file,'utf8'));
const parts = path.split('.').filter(Boolean);
let cur = obj;
for (const p of parts) {
  if (cur == null) { process.exit(2); }
  cur = cur[p];
}
if (cur == null) process.exit(2);
process.stdout.write(String(cur));
NODE
}

http_json() {
  local method="$1" url="$2" data_file="${3:-}" cookie_in="${4:-}" cookie_out="${5:-}"

  local args=(-sS -D /tmp/px_headers.txt -o /tmp/px_body.json -X "$method" "$url" -H "content-type: application/json")
  if [[ -n "$cookie_in" ]]; then args+=( -b "$cookie_in" ); fi
  if [[ -n "$cookie_out" ]]; then args+=( -c "$cookie_out" ); fi
  if [[ -n "$data_file" ]]; then args+=( --data-binary "@$data_file" ); fi

  curl "${args[@]}" >/dev/null

  local code
  code="$(awk 'NR==1{print $2}' /tmp/px_headers.txt)"
  if [[ "$code" -lt 200 || "$code" -ge 300 ]]; then
    echo "--- $method $url" >&2
    cat /tmp/px_headers.txt >&2
    echo "--- body" >&2
    cat /tmp/px_body.json >&2
    fail "HTTP $code"
  fi

  cat /tmp/px_body.json
}

log "1) health"
curl -fsS "$API/health" >/dev/null || fail "health failed"

log "2) ensure PocketBase superuser + schema"
PB_ENV_FILE="$INFRA_DIR/.env.api.local"
[[ -f "$PB_ENV_FILE" ]] || fail "Missing $PB_ENV_FILE"
PB_ADMIN_EMAIL="$(read_env_kv "$PB_ENV_FILE" PB_ADMIN_EMAIL || true)"
PB_ADMIN_PASSWORD="$(read_env_kv "$PB_ENV_FILE" PB_ADMIN_PASSWORD || true)"
[[ -n "$PB_ADMIN_EMAIL" ]] || fail "PB_ADMIN_EMAIL missing in $PB_ENV_FILE"
[[ -n "$PB_ADMIN_PASSWORD" ]] || fail "PB_ADMIN_PASSWORD missing in $PB_ENV_FILE"

docker exec proyecto-x-pocketbase pocketbase superuser upsert "$PB_ADMIN_EMAIL" "$PB_ADMIN_PASSWORD" >/dev/null
# create/patch collections (idempotent)
docker exec -e POCKETBASE_URL="http://pocketbase:8090" -e PB_ADMIN_EMAIL="$PB_ADMIN_EMAIL" -e PB_ADMIN_PASSWORD="$PB_ADMIN_PASSWORD" proyecto-x-api bun src/bootstrap-pocketbase.cjs >/tmp/px_bootstrap.log
# collections needed for /interno/altas (outbox)
docker exec -e POCKETBASE_URL="http://pocketbase:8090" -e PB_ADMIN_EMAIL="$PB_ADMIN_EMAIL" -e PB_ADMIN_PASSWORD="$PB_ADMIN_PASSWORD" proyecto-x-api bun src/bootstrap-pocketbase-outbox.cjs >/tmp/px_bootstrap_outbox.log
# catalog departments (Phase 2)
docker exec -e POCKETBASE_URL="http://pocketbase:8090" -e PB_ADMIN_EMAIL="$PB_ADMIN_EMAIL" -e PB_ADMIN_PASSWORD="$PB_ADMIN_PASSWORD" proyecto-x-api bun src/bootstrap-pocketbase-departments.cjs >/tmp/px_bootstrap_departments.log
# catalog job titles (Phase 3)
docker exec -e POCKETBASE_URL="http://pocketbase:8090" -e PB_ADMIN_EMAIL="$PB_ADMIN_EMAIL" -e PB_ADMIN_PASSWORD="$PB_ADMIN_PASSWORD" proyecto-x-api bun src/bootstrap-pocketbase-jobtitles.cjs >/tmp/px_bootstrap_jobtitles.log

log "3) public registration must be disabled (410)"
set +e
curl -sS -o /tmp/px_reg_disabled_body.txt -w "%{http_code}" -H "content-type: application/json" -X POST "$API/auth/register" --data-binary '{"email":"x@example.com","password":"12345678"}' > /tmp/px_reg_disabled_code.txt
set -e
REG_CODE="$(cat /tmp/px_reg_disabled_code.txt)"
[[ "$REG_CODE" == "410" ]] || fail "expected 410 for /auth/register, got $REG_CODE (body: $(cat /tmp/px_reg_disabled_body.txt))"

log "4) create internal user (RRHH) via PocketBase admin + login cookie"
TS="$(date +%s)"
INT_EMAIL="rrhh_smoke_${TS}@example.com"
INT_PW="Passw0rd!${TS}"

docker exec -e POCKETBASE_URL="http://pocketbase:8090" -e PB_ADMIN_EMAIL="$PB_ADMIN_EMAIL" -e PB_ADMIN_PASSWORD="$PB_ADMIN_PASSWORD" \
  -e INTERNAL_EMAIL="$INT_EMAIL" -e INTERNAL_PASSWORD="$INT_PW" -e INTERNAL_CORP_ROLE="HR" \
  proyecto-x-api bun src/bootstrap-internal-user.cjs >/tmp/px_bootstrap_internal_user.log

cat > /tmp/px_login.json <<JSON
{"email":"$INT_EMAIL","password":"$INT_PW"}
JSON
http_json POST "$API/auth/login" /tmp/px_login.json "" /tmp/px_internal.cookies >/tmp/px_login.out.json
http_json GET "$API/me" "" /tmp/px_internal.cookies "" >/tmp/px_me_internal.json

log "5) departments endpoint (active=1)"
http_json GET "$API/interno/departments?active=1" "" /tmp/px_internal.cookies "" >/tmp/px_depts.json

log "6) job titles endpoint (active=1)"
http_json GET "$API/interno/job_titles?active=1" "" /tmp/px_internal.cookies "" >/tmp/px_jobtitles.json

log "7) create minimal ATS records via PB admin + confirm hire (Alta IT)"
# Create a candidate user + candidate_profile + listing + application directly in PocketBase as admin,
# then call the internal hire endpoint and verify stage moved to hired and outbox created.

PB_URL="http://localhost:8090"
PB_TOKEN="$(node -e 'const j=require("/tmp/pb_admin_auth.json");process.stdout.write(j.token||"" )' 2>/dev/null || true)"
if [[ -z "$PB_TOKEN" ]]; then
  PB_TOKEN="$(curl -sS -H 'content-type: application/json' -X POST "$PB_URL/api/admins/auth-with-password" --data-binary "{\"identity\":\"$PB_ADMIN_EMAIL\",\"password\":\"$PB_ADMIN_PASSWORD\"}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{console.log(JSON.parse(d).token||"")}catch{console.log("")}})')"
fi
[[ -n "$PB_TOKEN" ]] || fail "missing PB admin token"

TS2="$(date +%s)"
CAND_EMAIL="cand_smoke_${TS2}@example.com"
CAND_PW="Passw0rd!${TS2}"

# create candidate user
cat > /tmp/px_pb_user.json <<JSON
{"email":"$CAND_EMAIL","password":"$CAND_PW","passwordConfirm":"$CAND_PW"}
JSON
curl -sS -H "Authorization: Bearer $PB_TOKEN" -H 'content-type: application/json' -X POST "$PB_URL/api/collections/users/records" --data-binary @/tmp/px_pb_user.json > /tmp/px_pb_user_out.json
CAND_UID="$(node -e 'const j=require("/tmp/px_pb_user_out.json");console.log(j.id||"")')"
[[ -n "$CAND_UID" ]] || fail "failed to create PB user"

# candidate profile
cat > /tmp/px_pb_candprof.json <<JSON
{"userId":"$CAND_UID","fullName":"Cand Smoke","title":"QA","location":"Madrid","public":true,"skills":["testing"],"about":"smoke"}
JSON
curl -sS -H "Authorization: Bearer $PB_TOKEN" -H 'content-type: application/json' -X POST "$PB_URL/api/collections/candidate_profiles/records" --data-binary @/tmp/px_pb_candprof.json >/tmp/px_pb_candprof_out.json

# listing owned by internal rrhh user id
INT_UID="$(node -e 'const j=require("/tmp/px_me_internal.json");console.log(j.user.id||"")')"
cat > /tmp/px_pb_listing.json <<JSON
{"ownerUserId":"$INT_UID","kind":"empleo","title":"Smoke Listing","company":"SmokeCo","location":"Remote","pay":"0","tags":["smoke"],"desc":"smoke"}
JSON
curl -sS -H "Authorization: Bearer $PB_TOKEN" -H 'content-type: application/json' -X POST "$PB_URL/api/collections/listings/records" --data-binary @/tmp/px_pb_listing.json > /tmp/px_pb_listing_out.json
LID="$(node -e 'const j=require("/tmp/px_pb_listing_out.json");console.log(j.id||"")')"
[[ -n "$LID" ]] || fail "failed to create listing"

# application
cat > /tmp/px_pb_app.json <<JSON
{"listingId":"$LID","companyUserId":"$INT_UID","candidateUserId":"$CAND_UID","stage":"nuevo","notes":""}
JSON
curl -sS -H "Authorization: Bearer $PB_TOKEN" -H 'content-type: application/json' -X POST "$PB_URL/api/collections/applications/records" --data-binary @/tmp/px_pb_app.json > /tmp/px_pb_app_out.json
APP_ID="$(node -e 'const j=require("/tmp/px_pb_app_out.json");console.log(j.id||"")')"
[[ -n "$APP_ID" ]] || fail "failed to create application"

# pick first dept + job title
DEPT_ID="$(node -e 'const j=require("/tmp/px_depts.json");console.log((j.items&&j.items[0]&&j.items[0].id)||"")')"
JT_ID="$(node -e 'const j=require("/tmp/px_jobtitles.json");console.log((j.items&&j.items[0]&&j.items[0].id)||"")')"
[[ -n "$DEPT_ID" ]] || fail "missing department id"
[[ -n "$JT_ID" ]] || fail "missing job title id"

cat > /tmp/px_hire_confirm.json <<JSON
{
  "applicationId":"$APP_ID",
  "startDate":"$(date +%F)",
  "departmentId":"$DEPT_ID",
  "jobTitleId":"$JT_ID",
  "costCenter":"CC-SMOKE",
  "managerEmail":"manager_${TS2}@example.com",
  "managerName":"Manager Smoke",
  "accessProfileId":"ACCESS-SMOKE",
  "hardwareProfile":"Laptop",
  "notesIT":"smoke"
}
JSON
http_json POST "$API/interno/hire/enqueue_it_request" /tmp/px_hire_confirm.json /tmp/px_internal.cookies "" >/tmp/px_hire_confirm_out.json

OUTBOX_ID="$(node -e 'const j=require("/tmp/px_hire_confirm_out.json");console.log(j.outbox&&j.outbox.id||"")')"
[[ -n "$OUTBOX_ID" ]] || fail "missing outbox id"

# verify stage moved to hired in PB
curl -sS -H "Authorization: Bearer $PB_TOKEN" "$PB_URL/api/collections/applications/records/$APP_ID" > /tmp/px_pb_app_after.json
STAGE="$(node -e 'const j=require("/tmp/px_pb_app_after.json");console.log(j.stage||"")')"
[[ "$STAGE" == "hired" ]] || fail "expected stage hired, got $STAGE"

log "8) outbox list contains created item"
http_json GET "$API/enterprise/outbox?status=pending" "" /tmp/px_internal.cookies "" >/tmp/px_outbox_pending.json

log "7) state endpoints (cache path)"
cat > /tmp/px_state_put.json <<JSON
{"state":{"hello":"world","ts":$TS}}
JSON
http_json PUT "$API/state" /tmp/px_state_put.json /tmp/px_internal.cookies "" >/tmp/px_state_put.out.json
http_json GET "$API/state" "" /tmp/px_internal.cookies "" >/tmp/px_state_get.json

log "8) negative auth: wrong password must be 401 (not 500)"
cat > /tmp/px_bad_login.json <<JSON
{"email":"$INT_EMAIL","password":"WRONG_PASSWORD"}
JSON
set +e
curl -sS -o /tmp/px_bad_login_body.txt -w "%{http_code}" -H "content-type: application/json" -X POST "$API/auth/login" --data-binary @/tmp/px_bad_login.json > /tmp/px_bad_login_code.txt
set -e
BAD_CODE="$(cat /tmp/px_bad_login_code.txt)"
[[ "$BAD_CODE" == "401" ]] || fail "expected 401 on wrong password, got $BAD_CODE (body: $(cat /tmp/px_bad_login_body.txt))"

log "OK smoke passed"
log "Artifacts:"
log "- bootstrap log: /tmp/px_bootstrap.log"
log "- bootstrap outbox log: /tmp/px_bootstrap_outbox.log"
log "- bootstrap departments log: /tmp/px_bootstrap_departments.log"
log "- curl headers: /tmp/px_headers.txt"
