// One-off migration: copy KeyDB px:state:user:* into PocketBase user_state.

const Redis = require('ioredis')

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '')
  const p = String(path || '')
  return `${b}${p.startsWith('/') ? '' : '/'}${p}`
}

async function pbReq(url, init) {
  const res = await fetch(url, init)
  const text = await res.text().catch(() => '')
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) throw new Error(`PB ${res.status}: ${text}`)
  return json
}

async function adminToken(baseUrl, email, password) {
  const payload = JSON.stringify({ identity: email, password })
  let r = await fetch(joinUrl(baseUrl, '/api/collections/_superusers/auth-with-password'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  if (r.status === 404) {
    r = await fetch(joinUrl(baseUrl, '/api/admins/auth-with-password'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
  }
  const j = await r.json()
  if (!r.ok) throw new Error(`Admin auth failed: ${r.status} ${JSON.stringify(j)}`)
  return j.token
}

async function upsert(baseUrl, token, userId, state) {
  const params = new URLSearchParams({ perPage: '1', page: '1', filter: `userId=\"${userId}\"` })
  const list = await pbReq(joinUrl(baseUrl, `/api/collections/user_state/records?${params.toString()}`), {
    headers: { Authorization: `Bearer ${token}` },
  })
  const rec = list?.items?.[0]
  const payload = { userId, state }

  if (rec?.id) {
    await pbReq(joinUrl(baseUrl, `/api/collections/user_state/records/${rec.id}`), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
  } else {
    await pbReq(joinUrl(baseUrl, '/api/collections/user_state/records'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    })
  }
}

async function main() {
  const keydbUrl = process.env.KEYDB_URL || 'redis://keydb:6379'
  const pbUrl = process.env.POCKETBASE_URL || 'http://pocketbase:8090'
  const email = process.env.PB_ADMIN_EMAIL
  const password = process.env.PB_ADMIN_PASSWORD
  if (!email || !password) throw new Error('Missing PB admin env')

  const redis = new Redis(keydbUrl)
  const token = await adminToken(pbUrl, email, password)

  let cursor = '0'
  let n = 0

  do {
    const res = await redis.scan(cursor, 'MATCH', 'px:state:user:*', 'COUNT', '100')
    cursor = res[0]
    const keys = res[1] || []
    for (const k of keys) {
      const userId = String(k).split(':').slice(-1)[0]
      const raw = await redis.get(k)
      if (!raw) continue
      let state = null
      try {
        state = JSON.parse(raw)
      } catch {
        continue
      }

      await upsert(pbUrl, token, userId, state)
      n += 1
    }
  } while (cursor !== '0')

  await redis.quit()
  console.log(`[migrate] copied ${n} states into PocketBase user_state`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
