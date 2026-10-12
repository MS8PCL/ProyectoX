// Create or update an internal PocketBase user (admin/rrhh/it).
// Usage (inside api container): bun src/bootstrap-internal-user.cjs
// Env:
//  POCKETBASE_URL, PB_ADMIN_EMAIL, PB_ADMIN_PASSWORD
//  INTERNAL_EMAIL, INTERNAL_PASSWORD, INTERNAL_CORP_ROLE (HR|IT|ADMIN)

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '')
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`
}

async function req(url, init) {
  const res = await fetch(url, init)
  const text = await res.text().catch(() => '')
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = null }
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

async function ensureUsersCorpRoleField(baseUrl, token) {
  const hdr = { Authorization: `Bearer ${token}` }
  const col = await req(joinUrl(baseUrl, '/api/collections/users'), { headers: hdr })
  if (!col.res.ok) throw new Error(`Fetch users collection failed: ${col.res.status} ${col.text}`)

  const fields = col.json.fields || []
  const has = fields.find((f) => f.name === 'corpRole')
  if (!has) {
    fields.push({
      type: 'select',
      name: 'corpRole',
      required: false,
      system: false,
      values: ['HR', 'IT', 'ADMIN'],
      options: { maxSelect: 1 },
    })

    const patch = { ...col.json, fields }
    const updated = await req(joinUrl(baseUrl, `/api/collections/${col.json.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...hdr },
      body: JSON.stringify(patch),
    })
    if (!updated.res.ok) throw new Error(`Patch users collection failed: ${updated.res.status} ${updated.text}`)
  }
}

async function main() {
  const baseUrl = process.env.POCKETBASE_URL || 'http://pocketbase:8090'
  const adminEmail = process.env.PB_ADMIN_EMAIL
  const adminPass = process.env.PB_ADMIN_PASSWORD
  const email = process.env.INTERNAL_EMAIL
  const pass = process.env.INTERNAL_PASSWORD
  const corpRole = String(process.env.INTERNAL_CORP_ROLE || '').toUpperCase()
  if (!adminEmail || !adminPass) throw new Error('Missing PB admin env')
  if (!email || !pass) throw new Error('Missing INTERNAL_EMAIL/INTERNAL_PASSWORD')
  if (!['HR', 'IT', 'ADMIN'].includes(corpRole)) throw new Error('INTERNAL_CORP_ROLE must be HR|IT|ADMIN')

  const token = await adminToken(baseUrl, adminEmail, adminPass)
  await ensureUsersCorpRoleField(baseUrl, token)

  const hdr = { Authorization: `Bearer ${token}` }

  // Find by email
  const filter = encodeURIComponent(`email="${String(email).replace(/"/g, '\\"')}"`)
  const list = await req(joinUrl(baseUrl, `/api/collections/users/records?perPage=1&page=1&filter=${filter}`), { headers: hdr })
  if (!list.res.ok) throw new Error(`List users failed: ${list.res.status} ${list.text}`)
  const existing = list.json?.items?.[0] || null

  if (existing?.id) {
    // update corpRole + password
    const body = {
      corpRole,
      password: pass,
      passwordConfirm: pass,
      // ensure verified so email auth works consistently
      verified: true,
    }
    const upd = await req(joinUrl(baseUrl, `/api/collections/users/records/${existing.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...hdr },
      body: JSON.stringify(body),
    })
    if (!upd.res.ok) throw new Error(`Update user failed: ${upd.res.status} ${upd.text}`)
    console.log(`[bootstrap-internal-user] ok: updated ${email} (${corpRole}) id=${existing.id}`)
    return
  }

  const body = {
    email,
    password: pass,
    passwordConfirm: pass,
    corpRole,
    verified: true,
  }
  const created = await req(joinUrl(baseUrl, '/api/collections/users/records'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(body),
  })
  if (!created.res.ok) throw new Error(`Create user failed: ${created.res.status} ${created.text}`)
  console.log(`[bootstrap-internal-user] ok: created ${email} (${corpRole}) id=${created.json.id}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
