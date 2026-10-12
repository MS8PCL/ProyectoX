import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

// Exercise the real startup/guard source with only its UI/runtime dependencies stubbed.
// No browser, GUI, persistence, or Vue page is launched by these tests.
const source = await readFile(new URL('../main.js', import.meta.url), 'utf8')
const executable = source.replace(/^import .*;\r?$/gm, '').replace('void start();', 'globalThis.startup = start();')
const routerSource = await readFile(new URL('../router/index.js', import.meta.url), 'utf8')

async function harness({ desktop = true, authError, stateError, state = null, revision = 0 } = {}) {
  const calls = []
  const overlays = []
  const auth = {
    user: { role: 'rrhh', authMode: 'windows' }, isAuthed: true,
    async bootstrap() { calls.push('auth'); if (authError) throw authError },
  }
  const appStore = {
    state: { role: 'candidato' },
    async bootstrap() { calls.push('app-bootstrap') },
    async _persist() { calls.push('persist') },
  }
  const router = { beforeEach(guard) { this.guard = guard; calls.push('guard') } }
  const app = { use(plugin) { calls.push(plugin === router ? 'router' : 'pinia') }, mount() { calls.push('mount') } }
  function element(tag) {
    return { tag, style: {}, children: [], setAttribute() {}, append(...children) { this.children.push(...children) } }
  }
  const context = {
    createApp: () => app, createPinia: () => ({}), App: {}, router,
    useAuthStore: () => auth, useAppStore: () => appStore,
    isDesktop: () => desktop, getDesktopState: () => ({ revision }),
    async api(path) { calls.push(path); if (stateError) throw stateError; return { state } },
    document: {
      getElementById(id) { return overlays.find((overlay) => overlay.id === id) },
      createElement: element,
      body: { append(overlay) { overlays.push(overlay) } },
    },
  }
  vm.runInNewContext(executable, context)
  await context.startup
  return { calls, overlays, auth, appStore, router }
}

test('desktop startup accepts explicit empty state and installs guard before router', async () => {
  const { calls, overlays } = await harness()
  assert.deepEqual(calls, ['pinia', 'guard', 'auth', '/state', 'router', 'mount'])
  assert.equal(overlays.length, 0)
})

test('desktop identity or state connection failures display overlay without login or app mount', async () => {
  for (const options of [{ authError: new Error('Windows host unavailable') }, { stateError: new Error('SMB unavailable') }]) {
    const { calls, overlays } = await harness(options)
    assert.equal(calls.includes('mount'), false)
    assert.equal(calls.includes('router'), false)
    assert.equal(overlays.length, 1)
    assert.equal(overlays[0].id, 'desktop-connection-error')
    const card = overlays[0].children[0]
    assert.match(card.children[0].textContent, /No se pudo conectar/)
    assert.equal(card.children[1].textContent, (options.authError || options.stateError).message)
  }
})

test('desktop invalid startup state or missing revision fails explicitly', async () => {
  for (const options of [{ state: [] }, { state: 'invalid' }, { revision: null }]) {
    const { calls, overlays } = await harness(options)
    assert.equal(calls.includes('mount'), false)
    assert.equal(overlays.length, 1)
  }
})

test('desktop guard redirects login to original home and changes presentation without persisting', async () => {
  const { calls, router, appStore } = await harness({ state: {} })
  const redirect = await router.guard({ meta: { public: true }, name: 'login' })
  assert.equal(redirect.name, 'home')
  assert.equal(await router.guard({ meta: { requiresAuth: true }, name: 'home', fullPath: '/' }), true)
  assert.equal(appStore.state.role, 'empresa')
  assert.equal(calls.includes('persist'), false)
  assert.equal(calls.includes('/onboarding/status'), false)
})

test('desktop guard aborts on app-store bootstrap failure instead of redirecting login', async () => {
  const { router, appStore, overlays } = await harness()
  appStore.bootstrap = async () => { throw new Error('Storage connection failed') }
  assert.equal(await router.guard({ meta: { requiresAuth: true }, name: 'home' }), false)
  assert.equal(overlays.length, 1)
})

test('browser starts without desktop preflight and retains logged-out login routing', async () => {
  const { calls, router, auth, overlays } = await harness({ desktop: false })
  assert.deepEqual(calls, ['pinia', 'guard', 'router', 'mount'])
  auth.isAuthed = false
  const redirect = await router.guard({ meta: { requiresAuth: true }, fullPath: '/buscar' })
  assert.equal(redirect.name, 'login')
  assert.equal(redirect.query.next, '/buscar')
  assert.equal(overlays.length, 0)
})

test('router selects hash only for desktop and keeps existing route components', () => {
  assert.match(routerSource, /history: isDesktop\(\) \? createWebHashHistory\(\) : createWebHistory\(\)/)
  assert.match(routerSource, /import\("\.\.\/layouts\/AppLayout.vue"\)/)
  assert.match(routerSource, /import\("\.\.\/pages\/HomePage.vue"\)/)
})
