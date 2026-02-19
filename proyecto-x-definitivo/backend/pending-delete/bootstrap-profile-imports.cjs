// One-off bootstrap: ensure PocketBase collection profile_imports exists.
// Run inside api container.

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
  // Try superusers, fallback to legacy admins.
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

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://pocketbase:8090'
  const email = process.env.PB_ADMIN_EMAIL
  const password = process.env.PB_ADMIN_PASSWORD
  if (!email || !password) throw new Error('Missing PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD')

  const token = await adminToken(baseUrl, email, password)
  const hdr = { Authorization: `Bearer ${token}` }

  const check = await req(joinUrl(baseUrl, '/api/collections/profile_imports'), { headers: hdr })
  if (check.res.ok) {
    console.log('[bootstrap] collection profile_imports already exists')
    return
  }

  if (check.res.status !== 404) {
    throw new Error(`[bootstrap] unexpected status checking collection: ${check.res.status} ${check.text}`)
  }

  const schema = {
    name: 'profile_imports',
    type: 'base',
    system: false,
    fields: [
      {
        type: 'text',
        name: 'userId',
        required: true,
        system: false,
        options: { max: 40, min: 1, pattern: '' },
      },
      {
        type: 'select',
        name: 'kind',
        required: true,
        system: false,
        // NOTE: PocketBase expects select values at the top-level for the field.
        values: ['linkedin_pdf', 'cv', 'portfolio', 'behance', 'dribbble'],
        options: { maxSelect: 1 },
      },
      { type: 'text', name: 'url', required: false, system: false, options: { max: 2048, min: 0, pattern: '' } },
      {
        type: 'file',
        name: 'file',
        required: false,
        system: false,
        options: { maxSelect: 1, maxSize: 0, mimeTypes: ['application/pdf'], thumbs: null, protected: false },
      },
      { type: 'text', name: 'consentText', required: true, system: false, options: { max: 2048, min: 0, pattern: '' } },
      { type: 'text', name: 'rawText', required: false, system: false, options: { max: 50000, min: 0, pattern: '' } },
    ],
    indexes: [],
    listRule: 'userId = @request.auth.id',
    viewRule: 'userId = @request.auth.id',
    createRule: 'userId = @request.auth.id',
    updateRule: 'userId = @request.auth.id',
    deleteRule: 'userId = @request.auth.id',
    options: {},
  }

  const created = await req(joinUrl(baseUrl, '/api/collections'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(schema),
  })

  if (!created.res.ok) throw new Error(`[bootstrap] create failed: ${created.res.status} ${created.text}`)
  console.log('[bootstrap] created collection profile_imports')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
