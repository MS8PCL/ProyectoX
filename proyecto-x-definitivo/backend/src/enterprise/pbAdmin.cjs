const { pbAdminAuth, pbRequestAuthed } = require('../pb.cjs')

let cache = { token: '', at: 0 }

async function adminPbToken(env) {
  const now = Date.now()
  if (cache.token && now - cache.at < 1000 * 60 * 5) return cache.token
  if (!env.PB_ADMIN_EMAIL || !env.PB_ADMIN_PASSWORD) throw new Error('Missing PB admin env')
  const admin = await pbAdminAuth(env.POCKETBASE_URL, env.PB_ADMIN_EMAIL, env.PB_ADMIN_PASSWORD)
  const token = admin?.token || ''
  if (!token) throw new Error('PocketBase admin token missing')
  cache = { token, at: now }
  return token
}

async function pbAdminRequest(env, path, init) {
  const token = await adminPbToken(env)
  return await pbRequestAuthed(env.POCKETBASE_URL, token, path, init)
}

module.exports = { adminPbToken, pbAdminRequest }
