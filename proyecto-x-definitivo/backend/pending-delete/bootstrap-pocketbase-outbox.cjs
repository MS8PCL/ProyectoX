// Bootstrap PocketBase collections required for /interno/altas (outbox) in portal MVP.
// Intentionally minimal: avoids PocketBase relation field collectionId issues.
// Usage (inside api container): bun src/bootstrap-pocketbase-outbox.cjs

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '')
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`
}

async function req(url, init) {
  const res = await fetch(url, init)
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { res, text, json }
}

async function adminToken(baseUrl, email, password) {
  const payload = JSON.stringify({ identity: email, password })

  let r = await req(joinUrl(baseUrl, '/api/collections/_superusers/auth-with-password'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })

  if (r.res.status === 404) {
    r = await req(joinUrl(baseUrl, '/api/admins/auth-with-password'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
  }

  if (!r.res.ok) throw new Error(`Admin auth failed: ${r.res.status} ${r.text}`)
  return r.json.token
}

async function ensureCollection(baseUrl, token, schema) {
  const hdr = { Authorization: `Bearer ${token}` }

  const check = await req(joinUrl(baseUrl, `/api/collections/${schema.name}`), { headers: hdr })
  if (check.res.ok) return { ok: true, existed: true, id: check.json.id }
  if (check.res.status !== 404) throw new Error(`Unexpected status checking ${schema.name}: ${check.res.status} ${check.text}`)

  const created = await req(joinUrl(baseUrl, '/api/collections'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(schema),
  })

  if (!created.res.ok) throw new Error(`Create failed (${schema.name}): ${created.res.status} ${created.text}`)
  return { ok: true, existed: false, id: created.json.id }
}

function authedReadRule() {
  return '@request.auth.id != ""'
}

function adminWriteRule() {
  // Empty rule => no rule (PocketBase treats it as unrestricted).
  // We still write through backend using PB admin token.
  return ''
}

async function patchOutbox(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` }
  const col = await req(joinUrl(baseUrl, '/api/collections/integration_outbox'), { headers: hdr })
  if (!col.res.ok) return false

  const fields = col.json.fields || []

  const attempts = fields.find((f) => f.name === 'attempts')
  if (attempts && attempts.type === 'number') {
    attempts.required = false
    attempts.onlyInt = true
    attempts.min = 0
  }

  const payload = fields.find((f) => f.name === 'payload')
  if (payload && payload.type === 'json') {
    payload.required = false
  }

  const pinned = fields.find((f) => f.name === 'pinned_workflow_version')
  if (pinned && pinned.type === 'number') {
    pinned.onlyInt = true
    pinned.min = 1
  }

  const patch = { ...col.json, fields }
  const updated = await req(joinUrl(baseUrl, `/api/collections/${col.json.id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(patch),
  })

  if (!updated.res.ok) throw new Error(`Patch integration_outbox failed: ${updated.res.status} ${updated.text}`)
  return true
}

async function patchAudit(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` }
  const col = await req(joinUrl(baseUrl, '/api/collections/audit_log'), { headers: hdr })
  if (!col.res.ok) return false
  // keep as-is for phase 1
  return true
}

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://pocketbase:8090'
  const email = process.env.PB_ADMIN_EMAIL
  const password = process.env.PB_ADMIN_PASSWORD
  if (!email || !password) throw new Error('Missing PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD')

  const token = await adminToken(baseUrl, email, password)

  await ensureCollection(baseUrl, token, {
    name: 'integration_outbox',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'kind', required: true, system: false, options: { max: 80, min: 2, pattern: '' } },
      { type: 'text', name: 'entity_type', required: true, system: false, options: { max: 80, min: 1, pattern: '' } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'text', name: 'pinned_workflow_key', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'number', name: 'pinned_workflow_version', required: true, system: false, options: { min: 1, max: null, noDecimal: true } },
      { type: 'text', name: 'idempotency_key', required: true, system: false, options: { max: 300, min: 6, pattern: '' } },
      // PocketBase treats empty json/object as blank in some versions; keep non-required and validate in backend.
      { type: 'json', name: 'payload', required: false, system: false, options: { maxSize: 0 } },
      { type: 'text', name: 'status', required: true, system: false, options: { max: 60, min: 2, pattern: '' } },
      // Attempts can be 0; keep non-required and set constraints via patchOutbox.
      { type: 'number', name: 'attempts', required: false, system: false, options: { min: 0, max: null, noDecimal: true } },
      { type: 'text', name: 'last_error', required: false, system: false, options: { max: 4000, min: 0, pattern: '' } },
      { type: 'json', name: 'export_blob', required: false, system: false, options: { maxSize: 0 } },
      { type: 'date', name: 'created_at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 120, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_integration_outbox_idempotency_key ON integration_outbox (idempotency_key)',
      'CREATE INDEX idx_integration_outbox_status ON integration_outbox (status)',
      'CREATE INDEX idx_integration_outbox_entity ON integration_outbox (entity_type, entity_id)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: adminWriteRule(),
    deleteRule: adminWriteRule(),
    options: {},
  })

  await ensureCollection(baseUrl, token, {
    name: 'audit_log',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'entity_type', required: true, system: false, options: { max: 80, min: 1, pattern: '' } },
      { type: 'text', name: 'entity_id', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'text', name: 'action', required: true, system: false, options: { max: 120, min: 1, pattern: '' } },
      { type: 'json', name: 'before', required: false, system: false, options: { maxSize: 0 } },
      { type: 'json', name: 'after', required: false, system: false, options: { maxSize: 0 } },
      { type: 'text', name: 'actor_type', required: true, system: false, options: { max: 40, min: 1, pattern: '' } },
      { type: 'text', name: 'actor_user', required: false, system: false, options: { max: 80, min: 0, pattern: '' } },
      { type: 'date', name: 'at', required: true, system: false, options: { min: '', max: '' } },
      { type: 'text', name: 'correlation_id', required: true, system: false, options: { max: 120, min: 8, pattern: '' } },
    ],
    indexes: [
      'CREATE INDEX idx_audit_log_entity ON audit_log (entity_type, entity_id)',
      'CREATE INDEX idx_audit_log_corr ON audit_log (correlation_id)',
      'CREATE INDEX idx_audit_log_at ON audit_log (at)',
    ],
    listRule: authedReadRule(),
    viewRule: authedReadRule(),
    createRule: adminWriteRule(),
    updateRule: '',
    deleteRule: '',
    options: {},
  })

  // Patch existing collections to keep them compatible.
  await patchOutbox(baseUrl, token)
  await patchAudit(baseUrl, token)

  console.log('[bootstrap-outbox] ok: ensured integration_outbox + audit_log')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
