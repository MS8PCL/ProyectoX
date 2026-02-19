import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'

const env = {
  PORT: Number(process.env.PORT ?? 8787),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? 'false') === 'true',
}

const app = new Hono()

// Minimal CORS (local dev)
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', env.WEB_ORIGIN)
  c.header('Access-Control-Allow-Credentials', 'true')
  c.header('Access-Control-Allow-Headers', 'content-type')
  c.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

app.get('/health', (c) => c.json({ ok: true }))

function getCookie(req, name) {
  const cookie = req.headers.get('cookie')
  if (!cookie) return null
  const parts = cookie.split(';').map((p) => p.trim())
  const hit = parts.find((p) => p.startsWith(`${name}=`))
  if (!hit) return null
  return decodeURIComponent(hit.slice(name.length + 1))
}

function setSidCookie(c, sid) {
  const attrs = [
    `sid=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    env.COOKIE_SECURE ? 'Secure' : '',
    `Max-Age=${60 * 60 * 24}`,
  ].filter(Boolean)

  c.header('Set-Cookie', attrs.join('; '))
}

function clearSidCookie(c) {
  const attrs = [
    'sid=',
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    env.COOKIE_SECURE ? 'Secure' : '',
    'Max-Age=0',
  ].filter(Boolean)

  c.header('Set-Cookie', attrs.join('; '))
}

app.get('/me', (c) => {
  const sid = getCookie(c.req.raw, 'sid')
  if (!sid) return c.json({ user: null })
  // TODO: lookup session in KeyDB + fetch user in PocketBase
  return c.json({ user: { id: 'demo', email: 'demo@local', sid } })
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

app.post('/auth/login', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = LoginSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)

  const sid = `dev_${crypto.randomUUID()}`
  setSidCookie(c, sid)
  return c.json({ ok: true })
})

app.post('/auth/logout', (c) => {
  clearSidCookie(c)
  return c.json({ ok: true })
})

serve({ fetch: app.fetch, port: env.PORT })
console.log(`[api] listening on http://localhost:${env.PORT}`)
