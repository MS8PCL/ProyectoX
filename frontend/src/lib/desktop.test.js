import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createPinia, setActivePinia } from 'pinia'
import { api, apiAllPages, apiForm, desktopRequest, getDesktopState } from './api.js'
import {
  isDesktop, DESKTOP_TIMEOUT_MS, DESKTOP_MAX_FILE_BYTES, DESKTOP_MAX_UPLOAD_BYTES,
  DESKTOP_MAX_CHUNK_BYTES, uploadDesktopFile,
} from './desktopBridge.js'
import { encodeDesktopForm, DESKTOP_MAX_FORM_BYTES } from './desktopApi.js'
import { useAuthStore } from '../stores/auth.js'

const originalFetch = globalThis.fetch
const originalWindow = globalThis.window
let bridge
function fakeBridge() {
  const listeners = []
  const waiters = []
  const legacyRequests = []
  const legacyWaiters = []
  return {
    sent: [],
    addEventListener(type, listener) { assert.equal(type, 'message'); listeners.push(listener) },
    postMessage(message) {
      this.sent.push(message)
      if (message.operation === 'legacyApi') {
        if (legacyWaiters.length) legacyWaiters.shift()(message)
        else legacyRequests.push(message)
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].operation === message.operation) {
          waiters[i].resolve(message)
          waiters.splice(i, 1)
        }
      }
      this.handle?.(message)
    },
    nextLegacyRequest() {
      return legacyRequests.length ? Promise.resolve(legacyRequests.shift()) : new Promise((resolve) => legacyWaiters.push(resolve))
    },
    waitFor(operation) {
      const request = this.sent.find((message) => message.operation === operation)
      return request ? Promise.resolve(request) : new Promise((resolve) => waiters.push({ operation, resolve }))
    },
    emit(data) { for (const listener of listeners) listener({ data }) },
    reply(request, result, error) {
      this.emit({ id: request.id, ok: !error, result, error })
    },
  }
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex').toUpperCase() }

function uploadHost({ chunkBytes = DESKTOP_MAX_CHUNK_BYTES, failAt, alterBegin, alterAck, alterFinish } = {}) {
  const uploads = new Map()
  bridge.handle = (request) => {
    const { operation, payload } = request
    if (!operation.startsWith('upload')) return
    if (operation === failAt) {
      bridge.reply(request, null, { code: 'upload_failed', message: 'Upload interrupted' })
      return
    }
    if (operation === 'uploadBegin') {
      const uploadId = randomUUID()
      uploads.set(uploadId, { ...payload, chunks: [], offset: 0, finished: false })
      bridge.reply(request, alterBegin ? alterBegin({ uploadId, chunkBytes }) : { uploadId, chunkBytes })
    } else if (operation === 'uploadChunk') {
      const upload = uploads.get(payload.uploadId)
      const bytes = Buffer.from(payload.base64, 'base64')
      assert.equal(payload.base64, bytes.toString('base64'))
      assert.ok(bytes.length > 0 && bytes.length <= DESKTOP_MAX_CHUNK_BYTES)
      assert.equal(payload.offset, upload.offset)
      assert.equal(payload.sha256, hash(bytes))
      assert.match(payload.sha256, /^[0-9A-F]{64}$/)
      upload.chunks.push(bytes)
      upload.offset += bytes.length
      const ack = { uploadId: payload.uploadId, offset: upload.offset }
      bridge.reply(request, alterAck ? alterAck(ack) : ack)
    } else if (operation === 'uploadFinish') {
      const upload = uploads.get(payload.uploadId)
      assert.equal(upload.offset, upload.size)
      assert.equal(payload.sha256, hash(Buffer.concat(upload.chunks)))
      assert.match(payload.sha256, /^[0-9A-F]{64}$/)
      upload.finished = true
      const finish = { uploadId: payload.uploadId, fileName: upload.fileName, mime: upload.mime, size: upload.size }
      bridge.reply(request, alterFinish ? alterFinish(finish) : finish)
    } else assert.fail(`Unexpected upload operation ${operation}`)
  }
  return uploads
}

function metadata(revision, readOnly = false, appliedOperationIds = []) {
  return { revision, readOnly, appliedOperationIds }
}
async function posted() {
  return bridge.nextLegacyRequest()
}
async function seed(revision, readOnly = false) {
  const pending = api('/state')
  const request = await posted()
  bridge.reply(request, { state: {}, __desktop: metadata(revision, readOnly) })
  await pending
}

beforeEach(() => {
  bridge = fakeBridge()
  globalThis.window = { chrome: { webview: bridge } }
  globalThis.fetch = () => { throw new Error('Desktop must not use HTTP') }
  setActivePinia(createPinia())
})
afterEach(() => {
  globalThis.window = originalWindow
  globalThis.fetch = originalFetch
})

test('desktop detection and missing revision reject writes without posting', async () => {
  assert.equal(isDesktop(), true)
  await assert.rejects(api('/listings', { method: 'POST', body: '{}' }), { code: 'revision_required' })
  assert.equal(bridge.sent.length, 0)
  delete globalThis.window.chrome.webview
  assert.equal(isDesktop(), false)
  await assert.rejects(desktopRequest('getState'), { code: 'bridge_unavailable' })
})

test('legacy envelope, parsed JSON body and stripped metadata', async () => {
  await seed(10)
  const pending = api('/listings', { method: 'post', body: '{"title":"Original UI"}' })
  const request = await posted()
  assert.equal(request.operation, 'legacyApi')
  assert.equal(request.payload.path, '/listings')
  assert.equal(request.payload.method, 'POST')
  assert.deepEqual(request.payload.body, { title: 'Original UI' })
  assert.equal(request.payload.expectedRevision, 10)
  assert.match(request.payload.operationId, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
  assert.notEqual(request.id, request.payload.operationId)
  bridge.reply(request, { item: { id: 'listing-1' }, __desktop: metadata(11, false, [request.payload.operationId]) })
  assert.deepEqual(await pending, { item: { id: 'listing-1' } })
  assert.deepEqual(getDesktopState(), metadata(11, false, [request.payload.operationId]))
  const copy = getDesktopState()
  copy.appliedOperationIds.push('not-real')
  assert.equal(getDesktopState().appliedOperationIds.length, 1)
})

test('concurrent responses correlate and stale reads cannot regress revision or readOnly', async () => {
  await seed(20)
  const read = api('/listings')
  const readRequest = await posted()
  const write = api('/listings', { method: 'PUT', body: { title: 'New' } })
  const writeRequest = await posted()
  bridge.reply(writeRequest, { saved: true, __desktop: metadata(21) })
  assert.deepEqual(await write, { saved: true })
  bridge.reply(readRequest, { items: [], __desktop: metadata(20, true) })
  assert.deepEqual(await read, { items: [] })
  assert.equal(getDesktopState().revision, 21)
  assert.equal(getDesktopState().readOnly, false)
})

test('invalid revision metadata is rejected without changing confirmed state', async () => {
  for (const revision of [-1, 1.5, '22', Number.MAX_SAFE_INTEGER + 1]) {
    const pending = api('/state')
    const request = await posted()
    bridge.reply(request, { state: {}, __desktop: metadata(revision) })
    await assert.rejects(pending, { code: 'invalid_metadata', uncertain: true })
    assert.equal(getDesktopState().revision, 21)
  }
})

test('read-only and invalid bodies reject before sending; no password or registration endpoints', async () => {
  await seed(30, true)
  const count = bridge.sent.length
  await assert.rejects(api('/listings/1', { method: 'DELETE' }), { code: 'read_only' })
  for (const path of ['/auth/login', '/auth/register', '/register', '/auth/logout', '/auth/login?next=/']) {
    await assert.rejects(api(path, { method: 'POST', body: '{}' }), { code: 'windows_auth' })
  }
  await assert.rejects(api('/x', { method: 'POST', body: 'not json' }), { code: 'invalid_body' })
  await assert.rejects(api('/x', { method: 'POST', body: new Blob(['x']) }), { code: 'invalid_body' })
  await assert.rejects(api('https://example.com/x'), { code: 'invalid_path' })
  assert.equal(bridge.sent.length, count)
  await seed(31)
})

test('multipart stages even small files and legacyApi receives references without base64', async () => {
  const uploads = uploadHost()
  const form = new FormData()
  form.append('tag', 'a')
  form.append('tag', 'b')
  form.append('cv', new Blob([new Uint8Array([0, 255, 42])], { type: 'application/pdf' }), 'cv.pdf')
  const pending = apiForm('/profile/imports/file', form)
  const request = await bridge.waitFor('legacyApi')
  const uploadId = [...uploads.keys()][0]
  assert.equal(uploads.get(uploadId).finished, true)
  assert.equal(request.payload.method, 'POST')
  assert.equal(request.payload.expectedRevision, 31)
  assert.deepEqual(request.payload.body, { parts: [
    { name: 'tag', value: 'a' }, { name: 'tag', value: 'b' },
    { name: 'cv', uploadId, fileName: 'cv.pdf', mime: 'application/pdf', size: 3 },
  ] })
  assert.deepEqual(bridge.sent.map((message) => message.operation), ['uploadBegin', 'uploadChunk', 'uploadFinish', 'legacyApi'])
  assert.equal(bridge.sent[1].payload.base64, 'AP8q')
  bridge.reply(request, { imported: 1, __desktop: metadata(32) })
  assert.deepEqual(await pending, { imported: 1 })
})

test('multipart bounds file bytes, text bytes and part count before dispatch', async () => {
  const largeFile = new FormData()
  // Structural entries let limits be tested without allocating oversized files.
  const oversized = { name: 'large.pdf', type: 'application/pdf', size: DESKTOP_MAX_FILE_BYTES + 1 }
  largeFile.append('file', new Blob([]), 'empty.pdf')
  await assert.rejects(encodeDesktopForm({ entries: () => [['file', oversized]][Symbol.iterator]() }), { code: 'form_too_large' })
  await assert.rejects(apiForm('/upload', largeFile), { code: 'form_too_large' })
  const largeText = new FormData()
  largeText.append('text', 'ñ'.repeat(DESKTOP_MAX_FORM_BYTES))
  await assert.rejects(encodeDesktopForm(largeText), { code: 'form_too_large' })
  const many = new FormData()
  for (let i = 0; i < 129; i++) many.append('x', '')
  await assert.rejects(encodeDesktopForm(many), { code: 'form_too_large' })
  assert.equal(bridge.sent.length, 0)
})

test('host conflict is surfaced with original operationId and no retry', async () => {
  const pending = api('/listings/1', { method: 'PATCH', body: '{}' })
  const request = await posted()
  bridge.reply(request, null, { code: 'conflict', message: 'Los datos han cambiado.' })
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'conflict')
    assert.equal(error.message, 'Los datos han cambiado.')
    assert.equal(error.operationId, request.payload.operationId)
    assert.equal(error.expectedRevision, 32)
    return true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bridge.sent.length, 1)
})

test('direct operations remain separate; timeout is uncertain and late messages do not retry', async () => {
  assert.ok(DESKTOP_TIMEOUT_MS > 20_000)
  const pending = desktopRequest('documentPick', { kind: 'cv' }, { timeoutMs: 25 })
  const request = bridge.sent[0]
  assert.equal(request.operation, 'documentPick')
  assert.deepEqual(request.payload, { kind: 'cv' })
  await assert.rejects(pending, { code: 'bridge_timeout', uncertain: true, requestId: request.id })
  bridge.reply(request, { fileName: 'late.pdf' })
  assert.equal(bridge.sent.length, 1)
  const download = desktopRequest('documentDownload', { id: 'file-1' })
  bridge.reply(bridge.sent[1], { saved: true })
  assert.deepEqual(await download, { saved: true })
})

test('bridge size and send errors are explicit', async () => {
  await assert.rejects(desktopRequest('documentSave', { text: 'x'.repeat(1024 * 1024) }), { code: 'message_too_large' })
  bridge.postMessage = () => { throw new Error('Disconnected') }
  await assert.rejects(desktopRequest('getState'), { code: 'bridge_send_failed', uncertain: true })
})

test('Windows bootstrap takes actual identity and role without fabricating credentials', async () => {
  const auth = useAuthStore()
  const pending = auth.bootstrap()
  const request = await posted()
  assert.equal(request.payload.path, '/me')
  const user = { id: 'windows-sid', email: '', role: 'rrhh', displayName: 'Windows User', authMode: 'windows' }
  bridge.reply(request, { user, __desktop: metadata(40) })
  await pending
  assert.deepEqual(auth.user, user)
  assert.equal(auth.isAuthed, true)
  await assert.rejects(auth.login('fake@example.com', 'fake'), { code: 'windows_auth' })
  await assert.rejects(auth.logout(), { code: 'windows_auth' })
  await assert.rejects(auth.register(), /registration is disabled/)
  assert.equal(bridge.sent.length, 1)
})

test('desktop auth failures stay connection errors, not silently logged-out sessions', async () => {
  const auth = useAuthStore()
  const pending = auth.bootstrap()
  const request = await posted()
  bridge.reply(request, null, { code: 'storage_unavailable', message: 'Sin conexión al host.' })
  await assert.rejects(pending, { code: 'storage_unavailable' })
  assert.equal(auth.user, null)
  assert.equal(auth.connectionError.code, 'storage_unavailable')
  await assert.rejects(auth.bootstrap(), { code: 'storage_unavailable' })
  assert.equal(bridge.sent.length, 1)
})

test('guest role from Windows host is not upgraded to rrhh', async () => {
  const auth = useAuthStore()
  const pending = auth.bootstrap()
  bridge.reply(await posted(), { user: { id: 'guest-sid', email: '', role: 'guest', displayName: 'Guest', authMode: 'windows' } })
  await pending
  assert.equal(auth.user.role, 'guest')
})

test('desktop rejects non-Windows identity', async () => {
  const auth = useAuthStore()
  const pending = auth.bootstrap()
  bridge.reply(await posted(), { user: { id: 'web-user', email: 'web@example.com', role: 'rrhh' } })
  await assert.rejects(pending, { code: 'windows_identity_required' })
})

test('GET auth/windows is forwarded and writes without metadata are uncertain', async () => {
  const identity = api('/auth/windows')
  const identityRequest = await posted()
  assert.equal(identityRequest.payload.method, 'GET')
  assert.equal(identityRequest.payload.path, '/auth/windows')
  bridge.reply(identityRequest, { user: { authMode: 'windows', role: 'rrhh' } })
  assert.deepEqual(await identity, { user: { authMode: 'windows', role: 'rrhh' } })
  const pending = api('/listings', { method: 'POST', body: '{}' })
  const request = await posted()
  bridge.reply(request, { item: { id: 'unconfirmed' } })
  await assert.rejects(pending, { code: 'invalid_metadata', uncertain: true, operationId: request.payload.operationId })
  assert.equal(getDesktopState().revision, 40)
})

test('malformed and unrelated bridge responses do not masquerade as success', async () => {
  const pending = desktopRequest('getState')
  const request = bridge.sent[0]
  bridge.reply({ id: 'unrelated' }, { revision: 999 })
  bridge.emit({ id: request.id, ok: 'not-a-boolean', result: {} })
  await assert.rejects(pending, { code: 'invalid_response', uncertain: true })
})

test('notifications unwrap only the exact desktop GET route after updating revision', async () => {
  const items = [{ id: 'real-host-notification', title: 'Host event' }]
  const pending = api('/notifications')
  bridge.reply(await posted(), { items, __desktop: metadata(41) })
  assert.deepEqual(await pending, items)
  assert.equal(getDesktopState().revision, 41)
  for (const path of ['/notifications?limit=5', '/notifications/', '/notifications/1', '/listings']) {
    const pending = api(path)
    bridge.reply(await posted(), { items: [], __desktop: metadata(41) })
    assert.deepEqual(await pending, { items: [] })
  }
  const post = api('/notifications', { method: 'POST', body: '{}' })
  bridge.reply(await posted(), { items: [], __desktop: metadata(42) })
  assert.deepEqual(await post, { items: [] })
  const empty = api('/notifications', { method: 'get' })
  bridge.reply(await posted(), { items: [], __desktop: metadata(42) })
  assert.deepEqual(await empty, [])
})

test('browser JSON and multipart HTTP contracts remain unchanged', async () => {
  delete globalThis.window.chrome.webview
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, json: async () => ({ items: [] }) }
  }
  assert.deepEqual(await api('/listings', { method: 'POST', body: '{}', headers: { 'x-test': 'yes' } }), { items: [] })
  assert.equal(calls[0].url, '/api/listings')
  assert.equal(calls[0].init.credentials, 'include')
  assert.deepEqual(calls[0].init.headers, { 'content-type': 'application/json', 'x-test': 'yes' })
  const form = new FormData()
  await apiForm('/upload', form)
  assert.equal(calls[1].init.body, form)
  assert.equal(calls[1].init.headers, undefined)
  assert.equal(calls[1].init.credentials, 'include')
  assert.deepEqual(await api('/notifications'), { items: [] })
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' })
  await assert.rejects(api('/me'), /API 403: Forbidden/)
})

test('browser auth failure still means logged out, without desktop connection error', async () => {
  delete globalThis.window.chrome.webview
  globalThis.fetch = async () => { throw new Error('Offline') }
  const auth = useAuthStore()
  await auth.bootstrap()
  assert.equal(auth.isAuthed, false)
  assert.equal(auth.booted, true)
  assert.equal(auth.connectionError, null)
})

test('multi-file chunk integration waits for each ack, hashes chunks and whole files, then commits once', async () => {
  const uploads = uploadHost({ chunkBytes: 128 * 1024 })
  const handle = bridge.handle
  let heldChunk
  bridge.handle = (request) => {
    if (request.operation === 'uploadChunk' && !heldChunk) { heldChunk = request; return }
    handle(request)
  }
  const data = new Uint8Array(2 * 1024 * 1024 + 17)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const form = new FormData()
  form.append('notes', 'Real documents')
  form.append('documents', new Blob([data], { type: 'application/pdf' }), 'first.pdf')
  form.append('documents', new Blob(['doc'], { type: 'application/msword' }), 'second.doc')
  const pending = apiForm('/interno/applications/application-1/documents', form)
  await bridge.waitFor('uploadChunk')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(bridge.sent.map((message) => message.operation), ['uploadBegin', 'uploadChunk'])
  handle(heldChunk)
  const request = await bridge.waitFor('legacyApi')
  assert.equal(uploads.size, 2)
  const [first, second] = [...uploads.values()]
  assert.equal(first.finished, true)
  assert.equal(second.finished, true)
  assert.deepEqual(Buffer.concat(first.chunks), Buffer.from(data))
  assert.equal(first.chunks.length, 17)
  assert.deepEqual(Buffer.concat(second.chunks), Buffer.from('doc'))
  const operations = bridge.sent.map((message) => message.operation)
  assert.equal(operations.filter((op) => op === 'uploadBegin').length, 2)
  assert.equal(operations.filter((op) => op === 'uploadFinish').length, 2)
  const firstFinish = operations.indexOf('uploadFinish')
  assert.equal(operations[firstFinish + 1], 'uploadBegin')
  assert.equal(operations.at(-1), 'legacyApi')
  assert.equal(request.payload.expectedRevision, 42)
  assert.match(request.payload.operationId, /^[0-9a-f-]{36}$/)
  assert.equal(request.payload.body.parts.length, 3)
  assert.equal(JSON.stringify(request.payload.body).includes('base64'), false)
  assert.ok(new TextEncoder().encode(JSON.stringify(request)).length < 1024 * 1024)
  bridge.reply(request, { documents: [{ id: 'committed-document' }], __desktop: metadata(43, false, [request.payload.operationId]) })
  assert.deepEqual(await pending, { documents: [{ id: 'committed-document' }] })
  assert.equal(getDesktopState().revision, 43)
})

test('all form limits are validated before any file is uploaded', async () => {
  const file = (size, name = 'cv.pdf') => ({ name, size, type: 'application/pdf' })
  const structuralForm = (entries) => ({ entries: () => entries[Symbol.iterator]() })
  await assert.rejects(encodeDesktopForm(structuralForm([
    ['first', file(40 * 1024 * 1024)], ['second', file(25 * 1024 * 1024)],
  ])), { code: 'form_too_large' })
  assert.equal(DESKTOP_MAX_UPLOAD_BYTES, 64 * 1024 * 1024)
  await assert.rejects(encodeDesktopForm(structuralForm([
    ['first', file(1)], ['text', 'x'.repeat(DESKTOP_MAX_FORM_BYTES)], ['more', 'x'],
  ])), { code: 'form_too_large' })
  // JSON escaping can exceed the message limit even with <=512 KiB of text.
  await assert.rejects(encodeDesktopForm(structuralForm([
    ['first', file(1)], ['text', '\u0000'.repeat(200 * 1024)],
  ])), { code: 'message_too_large' })
  await assert.rejects(encodeDesktopForm(structuralForm([
    ['first', file(1)], ['n'.repeat(1024 * 1024), ''],
  ])), { code: 'message_too_large' })
  assert.equal(bridge.sent.length, 0)
})

test('exact text budget is accepted; file byte budgets do not consume the text budget', async () => {
  const form = new FormData()
  form.append('notes', 'x'.repeat(DESKTOP_MAX_FORM_BYTES))
  const encoded = await encodeDesktopForm(form)
  assert.equal(encoded.parts[0].value.length, DESKTOP_MAX_FORM_BYTES)
  assert.equal(bridge.sent.length, 0)
})

test('host default chunk size sends exactly 256 KiB plus the final remainder', async () => {
  const uploads = uploadHost()
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(DESKTOP_MAX_CHUNK_BYTES + 1)], { type: 'application/pdf' }), 'cv.pdf')
  const result = await encodeDesktopForm(form)
  const upload = uploads.get(result.parts[0].uploadId)
  assert.deepEqual(upload.chunks.map((chunk) => chunk.length), [DESKTOP_MAX_CHUNK_BYTES, 1])
  assert.equal(upload.finished, true)
  assert.equal(Object.hasOwn(result.parts[0], 'base64'), false)
  assert.equal(bridge.sent.some((message) => message.operation === 'legacyApi'), false)
})

test('upload error aborts at begin, chunk or finish with no retry and no legacy mutation', async () => {
  for (const failAt of ['uploadBegin', 'uploadChunk', 'uploadFinish']) {
    bridge = fakeBridge()
    globalThis.window.chrome.webview = bridge
    uploadHost({ failAt })
    const form = new FormData()
    form.append('file', new Blob(['content'], { type: 'application/pdf' }), 'cv.pdf')
    await assert.rejects(apiForm('/profile/imports/file', form), { code: 'upload_failed' })
    const operations = bridge.sent.map((message) => message.operation)
    assert.equal(operations.at(-1), failAt)
    assert.equal(operations.filter((op) => op === failAt).length, 1)
    assert.equal(operations.includes('legacyApi'), false)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bridge.sent.length, operations.length)
  }
})

test('invalid upload configuration, offsets and finish metadata stop the sequence', async () => {
  const cases = [
    { alterBegin: (begin) => ({ ...begin, chunkBytes: DESKTOP_MAX_CHUNK_BYTES + 1 }), last: 'uploadBegin' },
    { alterBegin: (begin) => ({ ...begin, chunkBytes: 0 }), last: 'uploadBegin' },
    { alterBegin: (begin) => ({ ...begin, chunkBytes: 1.5 }), last: 'uploadBegin' },
    { alterBegin: (begin) => ({ ...begin, uploadId: 'invalid' }), last: 'uploadBegin' },
    { alterAck: (ack) => ({ ...ack, offset: ack.offset - 1 }), last: 'uploadChunk' },
    { alterAck: (ack) => ({ ...ack, uploadId: randomUUID() }), last: 'uploadChunk' },
    { alterFinish: (finish) => ({ ...finish, size: finish.size + 1 }), last: 'uploadFinish' },
    { alterFinish: (finish) => ({ ...finish, fileName: 'other.pdf' }), last: 'uploadFinish' },
  ]
  for (const options of cases) {
    bridge = fakeBridge()
    globalThis.window.chrome.webview = bridge
    uploadHost(options)
    const form = new FormData()
    form.append('file', new Blob(['content'], { type: 'application/pdf' }), 'cv.pdf')
    await assert.rejects(apiForm('/profile/imports/file', form), { code: 'invalid_upload_response', uncertain: true })
    assert.equal(bridge.sent.at(-1).operation, options.last)
    assert.equal(bridge.sent.some((message) => message.operation === 'legacyApi'), false)
  }
})

test('read-only forms do not create staging uploads', async () => {
  await seed(44, true)
  const count = bridge.sent.length
  const form = new FormData()
  form.append('file', new Blob(['content'], { type: 'application/pdf' }), 'cv.pdf')
  await assert.rejects(apiForm('/profile/imports/file', form), { code: 'read_only' })
  assert.equal(bridge.sent.length, count)
})

test('upload timeout is uncertain, stops before finish/legacyApi and ignores late ack without retry', async () => {
  await seed(45)
  bridge.sent.length = 0
  uploadHost()
  const handle = bridge.handle
  let heldChunk
  bridge.handle = (request) => {
    if (request.operation === 'uploadChunk') { heldChunk = request; return }
    handle(request)
  }
  const originalSetTimeout = globalThis.setTimeout
  // Compress only bridge timers; production remains at 30 seconds.
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === DESKTOP_TIMEOUT_MS ? 25 : delay, ...args)
  try {
    const form = new FormData()
    form.append('file', new Blob(['content'], { type: 'application/pdf' }), 'cv.pdf')
    await assert.rejects(apiForm('/profile/imports/file', form), (error) => {
      assert.equal(error.code, 'bridge_timeout')
      assert.equal(error.uncertain, true)
      assert.equal(error.uploadId, heldChunk.payload.uploadId)
      return true
    })
    handle(heldChunk)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(bridge.sent.map((message) => message.operation), ['uploadBegin', 'uploadChunk'])
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
})

test('exact 50 MiB/file and 64 MiB/form limits pass preflight without large test allocations', async () => {
  const file = (size) => ({
    name: 'cv.pdf', type: 'application/pdf', size,
    async arrayBuffer() { throw new Error('Reached file read after successful preflight') },
  })
  for (const entries of [
    [['file', file(DESKTOP_MAX_FILE_BYTES)]],
    [['first', file(32 * 1024 * 1024)], ['second', file(32 * 1024 * 1024)]],
  ]) {
    await assert.rejects(encodeDesktopForm({ entries: () => entries[Symbol.iterator]() }), /Reached file read/)
  }
  assert.equal(bridge.sent.length, 0)
})

test('missing crypto.subtle or mismatched file size aborts before uploadBegin', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { randomUUID } })
    await assert.rejects(uploadDesktopFile({ size: 1, name: 'cv.pdf', type: 'application/pdf', arrayBuffer: async () => new Uint8Array([1]).buffer }), { code: 'crypto_unavailable' })
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else delete globalThis.crypto
  }
  await assert.rejects(uploadDesktopFile({ size: 2, arrayBuffer: async () => new Uint8Array([1]).buffer }), { code: 'invalid_file' })
  assert.equal(bridge.sent.length, 0)
})

test('paginated reads fetch every page instead of the host default of 20', async () => {
  const entries = Array.from({ length: 450 }, (_, i) => ({ id: `audit-${i}` }))
  const pending = apiAllPages('/enterprise/audit-log')
  for (let page = 1; page <= 3; page++) {
    const request = await posted()
    assert.equal(request.payload.path, `/enterprise/audit-log?page=${page}&perPage=200`)
    bridge.reply(request, {
      ok: true, items: entries.slice((page - 1) * 200, page * 200), totalItems: 450, page, perPage: 200, totalPages: 3,
      __desktop: metadata(1),
    })
  }
  assert.deepEqual((await pending).map((entry) => entry.id), entries.map((entry) => entry.id))
})
