// Bootstrap PocketBase departments catalog (Phase 2)
// - Creates collection departments (if missing)
// - Seeds OFFICIAL departments if collection is empty
// Usage (inside api container): bun src/bootstrap-pocketbase-departments.cjs

const seedLines = require('./seeds/departments.seed.cjs')

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

function normalizedKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

function parseLine(line) {
  const raw = String(line || '').trim()
  if (!raw) return null
  const idx = raw.indexOf(' - ')
  let code = raw
  if (idx >= 0) code = raw.slice(0, idx).trim()
  const name = raw
  return { code, name, normalizedKey: normalizedKey(name) }
}

async function listCount(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` }
  const url = joinUrl(baseUrl, '/api/collections/departments/records?perPage=1&page=1')
  const r = await req(url, { headers: hdr })
  if (!r.res.ok) throw new Error(`List departments failed: ${r.res.status} ${r.text}`)
  return Number(r.json?.totalItems || 0)
}

async function createRecord(baseUrl, token, body) {
  const hdr = { Authorization: `Bearer ${token}` }
  const url = joinUrl(baseUrl, '/api/collections/departments/records')
  const r = await req(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(body),
  })
  if (!r.res.ok) throw new Error(`Create department failed: ${r.res.status} ${r.text}`)
  return r.json
}

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://pocketbase:8090'
  const email = process.env.PB_ADMIN_EMAIL
  const password = process.env.PB_ADMIN_PASSWORD
  if (!email || !password) throw new Error('Missing PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD')

  const token = await adminToken(baseUrl, email, password)

  await ensureCollection(baseUrl, token, {
    name: 'departments',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'code', required: true, system: false, options: { max: 40, min: 1, pattern: '' } },
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 2, pattern: '' } },
      { type: 'text', name: 'normalizedKey', required: true, system: false, options: { max: 220, min: 2, pattern: '' } },
      { type: 'bool', name: 'isActive', required: true, system: false, options: {} },
    ],
    indexes: [
      // NOTE: The provided official list contains repeated codes (e.g. CL, CORP, ZE),
      // so we cannot enforce unique(code) without inventing values.
      // We enforce uniqueness by normalizedKey instead.
      'CREATE UNIQUE INDEX idx_departments_normalizedKey_unique ON departments (normalizedKey)',
      'CREATE UNIQUE INDEX idx_departments_name_unique ON departments (name)',
      'CREATE INDEX idx_departments_active_code ON departments (isActive, code)',
    ],
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    options: {},
  })

  const count = await listCount(baseUrl, token)
  if (count > 0) {
    console.log(`[bootstrap-departments] ok: departments already seeded (totalItems=${count})`)
    return
  }

  const parsed = seedLines.map(parseLine).filter(Boolean)

  // Deduplicate by normalizedKey (and also by name, which is unique index anyway)
  const seen = new Set()
  const out = []
  for (const d of parsed) {
    if (!d.normalizedKey) continue
    if (seen.has(d.normalizedKey)) continue
    seen.add(d.normalizedKey)
    out.push(d)
  }

  for (const d of out) {
    await createRecord(baseUrl, token, { code: d.code, name: d.name, normalizedKey: d.normalizedKey, isActive: true })
  }

  console.log(`[bootstrap-departments] ok: seeded ${out.length} departments`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
