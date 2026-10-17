import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isDesktopMode, loadState, saveState, resetState } from './storage.js'

// Evaluate the real stores with only their framework/API boundaries stubbed.
function defineStore(_id, options) {
  return () => {
    const store = options.state()
    for (const [name, getter] of Object.entries(options.getters || {})) {
      Object.defineProperty(store, name, { get: () => getter(store) })
    }
    for (const [name, action] of Object.entries(options.actions || {})) {
      store[name] = action.bind(store)
    }
    return store
  }
}

async function readStore(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const imports = `const { defineStore, api, isDesktopMode, loadState, saveState${path.endsWith('/app.js') ? ', useNotificationsStore' : ''} } = globalThis.__desktopTest;\n`
  return import('data:text/javascript;base64,' + Buffer.from(imports + source.replace(/^import .*;?\r?\n/gm, '')).toString('base64'))
}

test('desktop storage and original stores', async (t) => {
  t.mock.method(console, 'error', () => {})
  const originals = Object.fromEntries(['window', 'document', 'localStorage', '__desktopTest'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => {
    for (const [key, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const cache = new Map()
  let storageCalls = 0
  globalThis.localStorage = {
    getItem(key) { storageCalls++; return cache.get(key) ?? null },
    setItem(key, value) { storageCalls++; cache.set(key, value) },
    removeItem(key) { storageCalls++; cache.delete(key) },
  }
  globalThis.window = { chrome: { webview: {} }, matchMedia: () => ({ matches: true, addEventListener() {} }) }
  globalThis.document = { documentElement: { setAttribute() {} } }
  const notifications = []
  const emptyHost = async (path, init) => {
    assert.equal(init, undefined)
    if (path === '/state') return { state: null }
    if (path === '/listings') return { items: [] }
    assert.fail(`Unexpected bootstrap request: ${path}`)
  }
  let request = emptyHost
  globalThis.__desktopTest = { defineStore, api: (...args) => request(...args), isDesktopMode, loadState, saveState, useNotificationsStore: () => ({ add: (n) => notifications.push(n) }) }
  const { useAppStore, createDefaultState } = await readStore('../stores/app.js')
  const { useAuditStore } = await readStore('../stores/audit.js')
  const { useNotificationsStore } = await readStore('../stores/notifications.js')

  await t.test('desktop never accesses business localStorage, even with old data', () => {
    cache.set('proyecto_x_v2', JSON.stringify({ candidates: [{ name: 'Legacy demo' }] }))
    storageCalls = 0
    assert.equal(isDesktopMode(), true)
    assert.equal(loadState(), null)
    assert.equal(saveState({ candidates: [] }), false)
    resetState()
    assert.equal(storageCalls, 0)
    assert.ok(cache.has('proyecto_x_v2'))
  })

  await t.test('web storage path is unchanged', () => {
    delete window.chrome.webview
    assert.equal(isDesktopMode(), false)
    assert.equal(saveState({ candidates: [{ id: 'real' }] }), true)
    assert.deepEqual(loadState(), { candidates: [{ id: 'real' }] })
    resetState()
    assert.equal(loadState(), null)
    window.chrome.webview = {}
  })

  await t.test('empty desktop has normal settings, no demo and no bootstrap write', async () => {
    const calls = []
    request = async (path, init) => { calls.push([path, init]); return emptyHost(path, init) }
    const app = useAppStore()
    await app.bootstrap()
    assert.equal(app.booted, true)
    assert.deepEqual(app.state, createDefaultState())
    assert.deepEqual(calls, [['/state', undefined], ['/listings', undefined]])
    assert.deepEqual(useAuditStore().entries, [])
    assert.deepEqual(useNotificationsStore().items, [])
  })

  await t.test('concurrent bootstrap shares the read and keeps real legacy data', async () => {
    let finish
    let calls = 0
    request = (path, init) => {
      calls++
      if (path === '/state') return new Promise((resolve) => { finish = resolve })
      return emptyHost(path, init)
    }
    const app = useAppStore()
    const first = app.bootstrap()
    const second = app.bootstrap()
    finish({ state: { v: 2, candidates: [{ id: 'real', name: 'Madrid' }], profile: { candidato: { name: 'Manu' } } } })
    await Promise.all([first, second])
    assert.equal(calls, 2)
    assert.equal(app.state.candidates[0].name, 'Madrid')
    assert.equal(app.state.profile.candidato.name, 'Manu')
  })

  await t.test('desktop bootstrap waits for imported listings without role-dependent reads or writes', async () => {
    const app = useAppStore()
    const calls = []
    let finishListings
    const stored = {
      ...createDefaultState(), role: 'empresa',
      listings: [{ id: 'ett-1', kind: 'ett', title: 'Old listing' }],
      favorites: ['ett-1'], applications: [{ id: 'application-1' }],
      candidates: [{ id: 'candidate-1', name: 'Real person' }],
      lists: [{ id: 'list-1', name: 'Real list' }],
      listMembers: { 'list-1': ['candidate-1'] },
      pipeline: { 'ett-1': [{ id: 'row-1', candidateId: 'candidate-1' }] },
      candidateFavorites: { 'ett-1': ['candidate-1'] },
    }
    request = (path, init) => {
      calls.push([path, init])
      assert.equal(init, undefined)
      if (path === '/state') return Promise.resolve({ state: stored })
      assert.equal(path, '/listings')
      assert.equal(app.booted, false)
      return new Promise((resolve) => { finishListings = resolve })
    }
    const loading = app.bootstrap()
    await new Promise(setImmediate)
    assert.equal(app.booted, false)
    const others = Object.fromEntries(Object.entries(app.state).filter(([key]) => key !== 'listings'))
    finishListings({ items: [
      { id: 'ett-1', kind: 'ett', title: 'Imported ETT', created: '2026-01-02T00:00:00Z' },
      { id: 'intern-1', kind: 'becario', title: 'Imported internship', created: '2026-01-01T00:00:00Z' },
    ] })
    await loading
    assert.equal(app.booted, true)
    assert.deepEqual(app.listings.map(({ id, kind, title }) => ({ id, kind, title })), [
      { id: 'ett-1', kind: 'ett', title: 'Imported ETT' },
      { id: 'intern-1', kind: 'becario', title: 'Imported internship' },
    ])
    assert.deepEqual(Object.fromEntries(Object.entries(app.state).filter(([key]) => key !== 'listings')), others)
    assert.deepEqual(calls, [['/state', undefined], ['/listings', undefined]])
  })

  await t.test('preferences-only state still loads the feed and fills missing collections', async () => {
    request = async (path, init) => {
      assert.equal(init, undefined)
      if (path === '/state') return { state: { theme: 'terminal', homeMode: 'console' } }
      assert.equal(path, '/listings')
      return { items: [{ id: 'real-job', kind: 'empleo', title: 'Real job' }] }
    }
    const app = useAppStore()
    await app.bootstrap()
    assert.equal(app.listings[0].title, 'Real job')
    assert.equal(app.state.homeMode, 'console')
    for (const key of ['favorites', 'applications', 'candidates', 'lists']) assert.deepEqual(app.state[key], [])
    for (const key of ['listMembers', 'pipeline', 'candidateFavorites']) assert.deepEqual(app.state[key], {})
    const defaultProfiles = createDefaultState().profile
    assert.deepEqual(app.state.profile, {
      candidato: defaultProfiles.candidato,
      empresa: { ...defaultProfiles.empresa, public: true },
    })
  })

  await t.test('listings failure or malformed response is reported, keeps bootstrap unready and permits retry', async () => {
    for (const response of [new Error('Listings disconnected'), {}, { items: null }]) {
      const app = useAppStore()
      const before = notifications.length
      request = async (path, init) => {
        assert.equal(init, undefined)
        if (path === '/state') return { state: null }
        assert.equal(path, '/listings')
        if (response instanceof Error) throw response
        return response
      }
      await assert.rejects(app.bootstrap(), /Listings disconnected|Respuesta \/listings inválida/)
      assert.equal(app.booted, false)
      assert.deepEqual(app.state, createDefaultState())
      assert.equal(notifications.length, before + 1)
      assert.equal(app.toast.kind, 'err')
      request = emptyHost
      await app.bootstrap()
      assert.equal(app.booted, true)
    }
  })

  await t.test('listing kinds survive import, server creation and application summaries in desktop and web', async () => {
    for (const desktop of [true, false]) {
      if (desktop) window.chrome.webview = {}
      else delete window.chrome.webview
      const app = useAppStore()
      // Isolate mappings from persistence, already covered by the queue tests.
      app._persist = async () => {}
      const kinds = ['empleo', 'freelance', 'ett', 'becario']
      app.importStateFromJsonText(JSON.stringify({ ...createDefaultState(), listings: kinds.map((kind) => ({ id: kind, kind })) }))
      assert.deepEqual(app.listings.map((listing) => listing.kind), kinds)
      for (const kind of kinds) {
        for (const includeKind of [true, false]) {
          request = async (path, init) => {
            assert.equal(path, '/listings')
            assert.equal(init.method, 'POST')
            assert.equal(JSON.parse(init.body).kind, kind)
            return { item: { id: `${kind}-${includeKind}`, ...(includeKind ? { kind } : {}) } }
          }
          assert.equal((await app.createListingServer({ kind, title: 'Real listing' })).kind, kind)
        }
      }
      request = async (path) => {
        assert.equal(path, '/me/applications')
        return { items: [], listings: Object.fromEntries(kinds.map((kind) => [kind, { id: kind, kind }])) }
      }
      await app.refreshMyApplicationsFromServer()
      for (const kind of kinds) assert.equal(app.listings.find((listing) => listing.id === kind).kind, kind)
      app.importStateFromJsonText(JSON.stringify({ ...createDefaultState(), listings: [{ id: 'unknown', kind: 'unknown' }] }))
      assert.equal(app.listings[0].kind, 'empleo')
    }
    window.chrome.webview = {}
  })

  await t.test('failed/invalid reads reject, report and permit retry without fallback', async () => {
    for (const response of [new Error('Disconnected'), {}, { state: [] }]) {
      request = async () => { if (response instanceof Error) throw response; return response }
      const app = useAppStore()
      const before = notifications.length
      await assert.rejects(app.bootstrap())
      assert.equal(app.booted, false)
      assert.equal(app.state, null)
      assert.equal(notifications.length, before + 1)
      request = emptyHost
      await app.bootstrap()
      assert.equal(app.booted, true)
    }
  })

  await t.test('writes serialize and include mutations made during an in-flight write', async () => {
    request = emptyHost
    const app = useAppStore()
    await app.bootstrap()
    const writes = []
    const finishes = []
    request = (path, init) => {
      assert.equal(path, '/state')
      assert.equal(init.method, 'PUT')
      writes.push(JSON.parse(init.body).state)
      return new Promise((resolve) => finishes.push(resolve))
    }
    app.state.profile.candidato.name = 'First'
    const first = app._persist()
    await new Promise(setImmediate)
    app.state.profile.candidato.name = 'Latest'
    const second = app._persist()
    assert.equal(writes.length, 1)
    finishes[0]({ ok: true })
    await first
    await new Promise(setImmediate)
    assert.equal(writes.length, 2)
    assert.equal(writes[1].profile.candidato.name, 'Latest')
    finishes[1]({ ok: true })
    await second
  })

  await t.test('write failure rejects and notifies, without cache; later writes can recover', async () => {
    request = emptyHost
    const app = useAppStore()
    await app.bootstrap()
    const before = notifications.length
    storageCalls = 0
    request = async () => { throw new Error('Write failed') }
    await assert.rejects(app._persist(), /Write failed/)
    assert.equal(notifications.length, before + 1)
    assert.equal(app.toast.kind, 'err')
    assert.equal(storageCalls, 0)
    request = async () => ({ ok: true })
    await app._persist()
  })

  await t.test('audit page treats successful empty data as authoritative and never uses desktop demo fallback', async () => {
    const pageSource = await readFile(new URL('../pages/AuditLogPage.vue', import.meta.url), 'utf8')
    const script = pageSource.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '')
    const makePage = new Function('computed', 'ref', 'onMounted', 'watch', 'useAuditStore', 't', 'apiAllPages', 'isDesktopMode', script + '\nreturn { allEntries, apiError };')
    for (const desktop of [true, false]) {
      if (desktop) window.chrome.webview = {}
      else delete window.chrome.webview
      for (const fails of [false, true]) {
        let mounted
        const page = makePage((fn) => ({ get value() { return fn() } }), (value) => ({ value }), (fn) => { mounted = fn }, () => {}, useAuditStore, (key) => key, async () => {
          if (fails) throw new Error('Audit unavailable')
          return []
        }, isDesktopMode)
        await mounted()
        assert.equal(page.apiError.value, fails)
        assert.equal(page.allEntries.value.length, !desktop && fails ? 20 : 0)
      }
    }
    window.chrome.webview = {}
  })

  await t.test('audit entries written with only "at" keep their real time', async () => {
    const pageSource = await readFile(new URL('../pages/AuditLogPage.vue', import.meta.url), 'utf8')
    const script = pageSource.match(/<script setup>([\s\S]*?)<\/script>/)[1].replace(/^import .*\r?\n/gm, '')
    const makePage = new Function('computed', 'ref', 'onMounted', 'watch', 'useAuditStore', 't', 'apiAllPages', 'isDesktopMode', script + '\nreturn { allEntries };')
    window.chrome.webview = {}
    let mounted
    const page = makePage((fn) => ({ get value() { return fn() } }), (value) => ({ value }), (fn) => { mounted = fn }, () => {}, useAuditStore, (key) => key,
      async () => [{ id: 'doc', at: '2026-01-02T03:04:05.000Z', action: 'POST /interno/listings/:id/import_candidate' }], isDesktopMode)
    await mounted()
    assert.equal(page.allEntries.value[0].timestamp, '2026-01-02T03:04:05.000Z')
  })

  await t.test('web still seeds audit and notifications', () => {
    delete window.chrome.webview
    assert.equal(useAuditStore().entries.length, 20)
    assert.equal(useNotificationsStore().items.length, 5)
    window.chrome.webview = {}
  })
})
