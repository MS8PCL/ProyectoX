// Idempotent bootstrap for Job Titles catalog in PocketBase.
// Creates collection `job_titles` and seeds initial records ONLY if collection is empty.

const seed = require('./seeds/job_titles.seed.cjs')

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

function normalizeKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
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

async function ensureCollection(baseUrl, token, spec) {
  const hdr = { Authorization: `Bearer ${token}` }
  const list = await req(joinUrl(baseUrl, '/api/collections?perPage=200'), { headers: hdr })
  if (!list.res.ok) throw new Error(`List collections failed: ${list.res.status} ${list.text}`)
  const existing = (list.json.items || []).find((c) => c.name === spec.name)

  if (!existing) {
    const created = await req(joinUrl(baseUrl, '/api/collections'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hdr },
      body: JSON.stringify(spec),
    })
    if (!created.res.ok) throw new Error(`Create collection failed: ${created.res.status} ${created.text}`)
    return
  }

  // Patch to desired spec (fields/indexes/rules) - PocketBase expects full object.
  const full = await req(joinUrl(baseUrl, `/api/collections/${existing.id}`), { headers: hdr })
  if (!full.res.ok) throw new Error(`Fetch collection failed: ${full.res.status} ${full.text}`)
  const patch = { ...full.json, ...spec, id: full.json.id }
  const updated = await req(joinUrl(baseUrl, `/api/collections/${existing.id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(patch),
  })
  if (!updated.res.ok) throw new Error(`Patch collection failed: ${updated.res.status} ${updated.text}`)
}

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://127.0.0.1:8090'
  const adminEmail = process.env.PB_ADMIN_EMAIL
  const adminPass = process.env.PB_ADMIN_PASSWORD
  if (!adminEmail || !adminPass) throw new Error('Missing PB admin env')
  const token = await adminToken(baseUrl, adminEmail, adminPass)

  await ensureCollection(baseUrl, token, {
    name: 'job_titles',
    type: 'base',
    system: false,
    fields: [
      { type: 'text', name: 'code', required: true, system: false, options: { max: 40, min: 1, pattern: '' } },
      { type: 'text', name: 'name', required: true, system: false, options: { max: 200, min: 1, pattern: '' } },
      { type: 'text', name: 'normalizedKey', required: true, system: false, options: { max: 240, min: 1, pattern: '' } },
      { type: 'bool', name: 'isActive', required: true, system: false, options: {} },
    ],
    indexes: [
      'CREATE UNIQUE INDEX idx_job_titles_normalized_unique ON job_titles (normalizedKey)',
      'CREATE UNIQUE INDEX idx_job_titles_name_unique ON job_titles (name)',
      'CREATE INDEX idx_job_titles_active ON job_titles (isActive)',
    ],
    // Any authenticated internal user via backend can query (backend uses admin token anyway).
    listRule: '@request.auth.id != ""',
    viewRule: '@request.auth.id != ""',
    createRule: '',
    updateRule: '',
    deleteRule: '',
    options: {},
  })

  const hdr = { Authorization: `Bearer ${token}` }
  const params = new URLSearchParams({ perPage: '1', page: '1' })
  const list = await req(joinUrl(baseUrl, `/api/collections/job_titles/records?${params.toString()}`), { headers: hdr })
  if (!list.res.ok) throw new Error(`List records failed: ${list.res.status} ${list.text}`)
  const existingCount = Number(list.json?.totalItems || 0)
  if (existingCount > 0) {
    console.log('[bootstrap-jobtitles] ok: already seeded')
    return
  }

  for (const line of seed) {
    const raw = String(line || '').trim()
    if (!raw) continue
    const m = raw.split(' - ')
    const code = String(m[0] || '').trim()
    const name = String(m.slice(1).join(' - ') || '').trim() || code
    const normalizedKey = normalizeKey(`${code}-${name}`)

    const created = await req(joinUrl(baseUrl, '/api/collections/job_titles/records'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...hdr },
      body: JSON.stringify({ code, name, normalizedKey, isActive: true }),
    })
    if (!created.res.ok) throw new Error(`Seed create failed: ${created.res.status} ${created.text}`)
  }

  console.log(`[bootstrap-jobtitles] ok: seeded ${seed.length} records`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
