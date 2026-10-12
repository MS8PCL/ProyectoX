// One-off bootstrap: ensure PocketBase collection user_state exists.

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

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://pocketbase:8090'
  const email = process.env.PB_ADMIN_EMAIL
  const password = process.env.PB_ADMIN_PASSWORD
  if (!email || !password) throw new Error('Missing PB_ADMIN_EMAIL/PB_ADMIN_PASSWORD')

  const token = await adminToken(baseUrl, email, password)
  const hdr = { Authorization: `Bearer ${token}` }

  const check = await req(joinUrl(baseUrl, '/api/collections/user_state'), { headers: hdr })
  if (check.res.ok) {
    console.log('[bootstrap] collection user_state already exists')
    return
  }
  if (check.res.status !== 404) throw new Error(`[bootstrap] unexpected: ${check.res.status} ${check.text}`)

  const schema = {
    name: 'user_state',
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
        type: 'json',
        name: 'state',
        required: true,
        system: false,
        options: { maxSize: 0 },
      },
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
  console.log('[bootstrap] created collection user_state')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
