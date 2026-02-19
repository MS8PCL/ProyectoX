function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '')
  if (!p) return b
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`
}

async function pbRequest(baseUrl, path, init) {
  const url = joinUrl(baseUrl, path)
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init && init.headers ? init.headers : {}),
    },
  })

  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }

  if (!res.ok) {
    const msg = (json && (json.message || json.error || JSON.stringify(json))) || text || res.statusText
    const err = new Error(`PocketBase ${res.status}: ${msg}`)
    err.status = res.status
    err.body = json
    throw err
  }

  return json
}

async function pbAuthWithPassword(baseUrl, email, password) {
  return await pbRequest(baseUrl, '/api/collections/users/auth-with-password', {
    method: 'POST',
    body: JSON.stringify({ identity: email, password }),
  })
}

async function pbAdminAuth(baseUrl, email, password) {
  // PocketBase renamed admins to _superusers in newer versions.
  // Try new endpoint first, then legacy.
  try {
    return await pbRequest(baseUrl, '/api/collections/_superusers/auth-with-password', {
      method: 'POST',
      body: JSON.stringify({ identity: email, password }),
    })
  } catch (e) {
    const is404 = e && (e.status === 404 || e.statusCode === 404)
    if (!is404) throw e
    return await pbRequest(baseUrl, '/api/admins/auth-with-password', {
      method: 'POST',
      body: JSON.stringify({ identity: email, password }),
    })
  }
}

async function pbCreateUser(baseUrl, adminToken, email, password, role) {
  return await pbRequest(baseUrl, '/api/collections/users/records', {
    method: 'POST',
    headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
    body: JSON.stringify({
      email,
      password,
      passwordConfirm: password,
      role: role || 'worker',
    }),
  })
}

function pbRequestAuthed(baseUrl, token, path, init) {
  return pbRequest(baseUrl, path, {
    ...init,
    headers: {
      ...(init && init.headers ? init.headers : {}),
      Authorization: `Bearer ${token}`,
    },
  })
}

module.exports = {
  pbRequest,
  pbRequestAuthed,
  pbAuthWithPassword,
  pbAdminAuth,
  pbCreateUser,
}
