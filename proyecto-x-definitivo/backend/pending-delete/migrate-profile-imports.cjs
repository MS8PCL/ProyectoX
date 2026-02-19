// One-off migration: update PocketBase collection profile_imports to support generic documents + docType.

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

  const col = await req(joinUrl(baseUrl, '/api/collections/profile_imports'), { headers: hdr })
  if (!col.res.ok) throw new Error(`Fetch collection failed: ${col.res.status} ${col.text}`)

  const fields = col.json.fields
  const kind = fields.find((f) => f.name === 'kind')
  if (!kind) throw new Error('Missing kind field')

  // Update kind values: replace linkedin_pdf/cv with document.
  kind.values = ['document', 'portfolio', 'behance', 'dribbble']

  // Add docType select if missing.
  let docType = fields.find((f) => f.name === 'docType')
  if (!docType) {
    docType = {
      type: 'select',
      name: 'docType',
      required: false,
      system: false,
      values: ['cv', 'certificate', 'portfolio', 'linkedin', 'other'],
      options: { maxSelect: 1 },
    }
    fields.push(docType)
  } else {
    docType.values = ['cv', 'certificate', 'portfolio', 'linkedin', 'other']
    docType.options = docType.options || { maxSelect: 1 }
    docType.options.maxSelect = 1
  }

  // Update file mime types to include images (certs sometimes are PNG/JPG)
  const file = fields.find((f) => f.name === 'file')
  if (file && file.type === 'file') {
    file.options = file.options || {}
    file.options.maxSelect = 1
    file.options.mimeTypes = Array.from(
      new Set([...(file.options.mimeTypes || []), 'application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
    )
  }

  const patch = {
    ...col.json,
    fields,
  }

  const updated = await req(joinUrl(baseUrl, `/api/collections/${col.json.id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...hdr },
    body: JSON.stringify(patch),
  })

  if (!updated.res.ok) throw new Error(`Update failed: ${updated.res.status} ${updated.text}`)
  console.log('[migrate] updated profile_imports')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
