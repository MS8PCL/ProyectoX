import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { desktopApi, getDesktopState, DESKTOP_MAX_PENDING_OPERATIONS } from './desktopApi.js'
import { DESKTOP_TIMEOUT_MS, desktopRequest } from './desktopBridge.js'

const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
let bridge

function mockBridge() {
  const listeners = []
  const queue = []
  const waiters = []
  return {
    sent: [], throwOnSend: false,
    addEventListener(type, listener) { assert.equal(type, 'message'); listeners.push(listener) },
    postMessage(message) {
      const wire = JSON.parse(JSON.stringify(message))
      this.sent.push(wire)
      if (waiters.length) waiters.shift()(wire)
      else queue.push(wire)
      if (this.throwOnSend) throw new Error('WebView disconnected during send')
    },
    next() { return queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve) => waiters.push(resolve)) },
    emit(data) { for (const listener of listeners) listener({ data }) },
    reply(request, result, error) { this.emit({ id: request.id, ok: !error, result, error }) },
  }
}
function metadata(revision = getDesktopState().revision + 1) {
  return { revision, readOnly: false, appliedOperationIds: [] }
}
async function refresh(revision = (getDesktopState().revision ?? 0) + 1) {
  const pending = desktopApi('/state')
  const request = await bridge.next()
  assert.equal(request.payload.path, '/state')
  bridge.reply(request, { state: {}, __desktop: metadata(revision) })
  await pending
}
async function rejectMutation(path, body, code, extra = {}) {
  const pending = desktopApi(path, { method: 'POST', body })
  let error
  const rejected = assert.rejects(pending, (caught) => { error = caught; return true })
  const request = await bridge.next()
  bridge.reply(request, null, { code, message: code, ...extra })
  await rejected
  return { request, error }
}
async function confirm(path, body, method = 'POST') {
  const pending = desktopApi(path, { method, body })
  const request = await bridge.next()
  bridge.reply(request, { saved: true, __desktop: metadata() })
  assert.deepEqual(await pending, { saved: true })
  return request
}

beforeEach(async () => {
  bridge = mockBridge()
  globalThis.window = { chrome: { webview: bridge } }
  globalThis.fetch = () => { throw new Error('No HTTP fallback allowed') }
  await refresh()
  bridge.sent.length = 0
})
afterEach(() => {
  globalThis.window = originalWindow
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

test('manual retry after a lost commit response replays the original receipt before revision conflict', async () => {
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === DESKTOP_TIMEOUT_MS ? 25 : delay, ...args)
  const pending = desktopApi('/replay/create', { method: 'POST', body: '{"name":"one record","count":1}' })
  let firstError
  const rejected = assert.rejects(pending, (error) => { firstError = error; return error.code === 'bridge_timeout' && error.uncertain })
  const first = await bridge.next()
  // Simulate a host commit whose response is lost, with a durable operation receipt.
  const receipts = new Map([[first.payload.operationId, { item: { id: 'only-created-record' } }]])
  let committedRecords = 1
  await rejected
  assert.equal(firstError.operationId, first.payload.operationId)
  assert.equal(firstError.expectedRevision, first.payload.expectedRevision)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(bridge.sent.length, 1, 'No automatic retry')
  await refresh(first.payload.expectedRevision + 5)
  const retry = desktopApi('/replay/create', { method: 'post', body: { count: 1, name: 'one record' } })
  const replay = await bridge.next()
  assert.notEqual(replay.id, first.id)
  assert.equal(replay.payload.operationId, first.payload.operationId)
  assert.equal(replay.payload.expectedRevision, first.payload.expectedRevision)
  // The host resolves receipts BEFORE checking the newer current revision.
  const receipt = receipts.get(replay.payload.operationId)
  if (receipt) bridge.reply(replay, { ...receipt, __desktop: metadata(getDesktopState().revision) })
  else { committedRecords++; assert.fail('Retry created a duplicate operation') }
  assert.deepEqual(await retry, { item: { id: 'only-created-record' } })
  assert.equal(committedRecords, 1)
  // A late response for the old request cannot reintroduce its pending identity.
  bridge.reply(first, { ...receipt, __desktop: metadata() })
  const newSubmission = await confirm('/replay/create', { name: 'one record', count: 1 })
  assert.notEqual(newSubmission.payload.operationId, first.payload.operationId, 'Success clears pending')
  assert.equal(newSubmission.payload.expectedRevision, replay.payload.expectedRevision + 5)
})

test('nested JSON property order and parsed JSON strings share one canonical operation', async () => {
  const original = { z: 2, nested: { b: 2, a: 1 }, list: [{ b: 4, a: 3 }, null] }
  const { request, error } = await rejectMutation('/canonical/order', original, 'store_unavailable')
  assert.equal(error.uncertain, true)
  await refresh()
  const retry = await confirm('/canonical/order', '{"list":[{"a":3,"b":4},null],"nested":{"a":1,"b":2},"z":2}', 'post')
  assert.equal(retry.payload.operationId, request.payload.operationId)
  assert.equal(retry.payload.expectedRevision, request.payload.expectedRevision)
})

test('wire JSON is snapshotted before asynchronous hashing', async () => {
  const body = { nested: { count: 1 }, omit: undefined, list: [undefined, 2] }
  const pending = desktopApi('/canonical/snapshot', { method: 'POST', body })
  const rejected = assert.rejects(pending, { code: 'io_error', uncertain: true })
  body.nested.count = 99
  body.list.push(3)
  const first = await bridge.next()
  assert.deepEqual(first.payload.body, { nested: { count: 1 }, list: [null, 2] })
  bridge.reply(first, null, { code: 'io_error', message: 'Uncertain write' })
  await rejected
  const retry = await confirm('/canonical/snapshot', { list: [null, 2], nested: { count: 1 } })
  assert.equal(retry.payload.operationId, first.payload.operationId)
})

test('path, method, values and array order are part of the identity', async () => {
  const body = { rows: [1, 2] }
  const { request: original } = await rejectMutation('/canonical/identity', body, 'store_unavailable')
  for (const [path, method, changed] of [
    ['/canonical/other', 'POST', body],
    ['/canonical/identity', 'PUT', body],
    ['/canonical/identity', 'POST', { rows: [2, 1] }],
    ['/canonical/identity', 'POST', { rows: [1, 3] }],
  ]) {
    const separate = await confirm(path, changed, method)
    assert.notEqual(separate.payload.operationId, original.payload.operationId)
  }
  const replay = await confirm('/canonical/identity', body)
  assert.equal(replay.payload.operationId, original.payload.operationId)
})

test('availability, I/O, send and metadata failures preserve identity without automatic retry', async () => {
  for (const code of ['store_unavailable', 'storage_unavailable', 'io_error', 'io_failure', 'IOException', 'bridge_send_failed', 'bridge_timeout', 'host_error']) {
    const path = `/uncertain/${code}`
    const { request, error } = await rejectMutation(path, { value: 1 }, code)
    assert.equal(error.uncertain, true)
    assert.equal(error.operationId, request.payload.operationId)
    await refresh()
    const retry = await confirm(path, { value: 1 })
    assert.equal(retry.payload.operationId, request.payload.operationId)
    assert.equal(retry.payload.expectedRevision, request.payload.expectedRevision)
  }
})

test('host uncertain flag preserves an otherwise unknown error', async () => {
  const { request, error } = await rejectMutation('/uncertain/host-flag', {}, 'custom_failure', { uncertain: true })
  assert.equal(error.uncertain, true)
  const retry = await confirm('/uncertain/host-flag', {})
  assert.equal(retry.payload.operationId, request.payload.operationId)
})

test('missing or invalid result metadata and malformed bridge responses preserve the operation', async () => {
  for (const [suffix, result, malformed] of [
    ['missing', { saved: true }, false],
    ['invalid', { saved: true, __desktop: { ...metadata(), revision: 'invalid' } }, false],
    ['malformed', {}, true],
  ]) {
    const path = `/uncertain/metadata-${suffix}`
    const pending = desktopApi(path, { method: 'POST', body: {} })
    const rejected = assert.rejects(pending, { code: malformed ? 'invalid_response' : 'invalid_metadata', uncertain: true })
    const first = await bridge.next()
    if (malformed) bridge.emit({ id: first.id, ok: 'invalid', result })
    else bridge.reply(first, result)
    await rejected
    const retry = await confirm(path, {})
    assert.equal(retry.payload.operationId, first.payload.operationId)
    assert.equal(retry.payload.expectedRevision, first.payload.expectedRevision)
  }
})

test('actual postMessage failure preserves UUID and original revision for the next manual call', async () => {
  bridge.throwOnSend = true
  const pending = desktopApi('/uncertain/send', { method: 'POST', body: { value: 1 } })
  const rejected = assert.rejects(pending, { code: 'bridge_send_failed', uncertain: true })
  const first = await bridge.next()
  await rejected
  assert.equal(bridge.sent.length, 1)
  bridge.throwOnSend = false
  await refresh()
  const retry = await confirm('/uncertain/send', { value: 1 })
  assert.equal(retry.payload.operationId, first.payload.operationId)
  assert.equal(retry.payload.expectedRevision, first.payload.expectedRevision)
})

test('definitive host rejection clears pending; next manual call uses fresh identity and read revision', async () => {
  for (const code of ['invalid', 'invalid_request', 'invalid_body', 'invalid_revision', 'forbidden', 'unauthorized', 'conflict', 'read_only', 'readOnly']) {
    const path = `/definitive/${code}`
    const { request, error } = await rejectMutation(path, { value: 1 }, code)
    assert.equal(error.uncertain, false)
    await refresh()
    const currentRevision = getDesktopState().revision
    const next = await confirm(path, { value: 1 })
    assert.notEqual(next.payload.operationId, request.payload.operationId)
    assert.equal(next.payload.expectedRevision, currentRevision)
  }
})

test('simultaneous explicit calls share an identity and a late failure does not resurrect confirmed pending', async () => {
  const first = desktopApi('/concurrent/manual', { method: 'POST', body: { a: 1, b: 2 } })
  const second = desktopApi('/concurrent/manual', { method: 'POST', body: { b: 2, a: 1 } })
  const secondRejected = assert.rejects(second, { code: 'store_unavailable', uncertain: true })
  const requests = [await bridge.next(), await bridge.next()]
  // Hash completions need not preserve call order; wire body order identifies each caller.
  const request1 = requests.find((request) => Object.keys(request.payload.body)[0] === 'a')
  const request2 = requests.find((request) => Object.keys(request.payload.body)[0] === 'b')
  assert.equal(request1.payload.operationId, request2.payload.operationId)
  bridge.reply(request1, { saved: true, __desktop: metadata() })
  await first
  bridge.reply(request2, null, { code: 'store_unavailable', message: 'Late failure' })
  await secondRejected
  const next = await confirm('/concurrent/manual', { a: 1, b: 2 })
  assert.notEqual(next.payload.operationId, request1.payload.operationId)
})

test('exact document upload references replay without adding fields or hashing file-name/size guesses', async () => {
  const body = { parts: [{ name: 'file', uploadId: '00000000-0000-0000-0000-000000000001', fileName: 'cv.pdf', mime: 'application/pdf', size: 3 }] }
  const { request } = await rejectMutation('/documents/referenced', body, 'store_unavailable')
  const changedRefs = { parts: [{ ...body.parts[0], uploadId: '00000000-0000-0000-0000-000000000002' }] }
  const independent = await confirm('/documents/referenced', changedRefs)
  assert.notEqual(independent.payload.operationId, request.payload.operationId, 'Different uploads cannot be assumed to contain the same bytes')
  const replay = await confirm('/documents/referenced', body)
  assert.equal(replay.payload.operationId, request.payload.operationId)
  assert.deepEqual(replay.payload.body, body)
  assert.equal(Object.hasOwn(replay.payload.body.parts[0], 'sha256'), false)
})

test('direct bridge marks storage and I/O errors uncertain even without a host flag', async () => {
  for (const code of ['store_unavailable', 'io_error']) {
    const pending = desktopRequest('getState')
    const rejected = assert.rejects(pending, { code, uncertain: true })
    bridge.reply(await bridge.next(), null, { code, message: code })
    await rejected
  }
})

test('128 unresolved operations are never evicted; new writes fail explicitly while replay and reads still work', async () => {
  assert.equal(DESKTOP_MAX_PENDING_OPERATIONS, 128)
  const originals = []
  for (let i = 0; i < DESKTOP_MAX_PENDING_OPERATIONS; i++) {
    const { request } = await rejectMutation(`/quota/${i}`, { index: i }, 'store_unavailable')
    originals.push(request)
  }
  const count = bridge.sent.length
  await assert.rejects(desktopApi('/quota/new', { method: 'POST', body: {} }), { code: 'pending_operations_full' })
  assert.equal(bridge.sent.length, count, 'Overflow must not send a write or silently remove an identity')
  await refresh()
  const replay = await confirm('/quota/0', { index: 0 })
  assert.equal(replay.payload.operationId, originals[0].payload.operationId)
  assert.equal(replay.payload.expectedRevision, originals[0].payload.expectedRevision)
  await confirm('/quota/new', {})
  for (let i = 1; i < originals.length; i++) {
    const retry = await confirm(`/quota/${i}`, { index: i })
    assert.equal(retry.payload.operationId, originals[i].payload.operationId)
    assert.equal(retry.payload.expectedRevision, originals[i].payload.expectedRevision)
  }
})
