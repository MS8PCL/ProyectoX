import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { File } from 'node:buffer'
import { desktopApi, DESKTOP_MAX_PENDING_OPERATIONS } from './desktopApi.js'
import { DESKTOP_TIMEOUT_MS, DESKTOP_MAX_CHUNK_BYTES } from './desktopBridge.js'

const originalWindow = globalThis.window
const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
let host
const path = '/interno/applications/application-1/documents'
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex').toUpperCase()

function documentHost() {
  const listeners = []
  const uploads = new Map()
  const receipts = new Map()
  const writes = []
  const waiters = []
  return {
    uploads, receipts, packets: [], revision: 0, commits: 0, mode: 'success', rejectCode: 'invalid_request',
    addEventListener(type, listener) { assert.equal(type, 'message'); listeners.push(listener) },
    reply(request, result, error) {
      for (const listener of listeners) listener({ data: { id: request.id, ok: !error, result, error } })
    },
    metadata() { return { revision: this.revision, readOnly: false, appliedOperationIds: [...receipts.keys()] } },
    error(request, code) { this.reply(request, null, { code, message: code }) },
    nextWrite() { return writes.length ? Promise.resolve(writes.shift()) : new Promise((resolve) => waiters.push(resolve)) },
    postMessage(message) {
      const request = JSON.parse(JSON.stringify(message))
      this.packets.push(request)
      const { operation, payload } = request
      if (operation === 'uploadBegin') {
        const uploadId = randomUUID()
        uploads.set(uploadId, { ...payload, chunks: [], offset: 0, finished: false })
        this.reply(request, { uploadId, chunkBytes: DESKTOP_MAX_CHUNK_BYTES })
      } else if (operation === 'uploadChunk') {
        const upload = uploads.get(payload.uploadId)
        const bytes = Buffer.from(payload.base64, 'base64')
        assert.equal(payload.offset, upload.offset)
        assert.equal(payload.sha256, hash(bytes))
        assert.ok(bytes.length <= DESKTOP_MAX_CHUNK_BYTES)
        upload.chunks.push(bytes)
        upload.offset += bytes.length
        this.reply(request, { uploadId: payload.uploadId, offset: upload.offset })
      } else if (operation === 'uploadFinish') {
        const upload = uploads.get(payload.uploadId)
        assert.equal(upload.offset, upload.size)
        assert.equal(payload.sha256, hash(Buffer.concat(upload.chunks)))
        upload.finished = true
        this.reply(request, { uploadId: payload.uploadId, fileName: upload.fileName, mime: upload.mime, size: upload.size })
      } else {
        assert.equal(operation, 'legacyApi')
        if (payload.method === 'GET') {
          this.reply(request, { state: {}, __desktop: this.metadata() })
          return
        }
        if (waiters.length) waiters.shift()(request)
        else writes.push(request)
        // DocumentApi resolves durable receipts before checking revision or consumed uploads.
        const receipt = receipts.get(payload.operationId)
        if (receipt) {
          assert.deepEqual(payload.body, receipt.body)
          this.reply(request, { ...receipt.result, __desktop: this.metadata() })
          return
        }
        if (this.mode === 'reject') { this.error(request, this.rejectCode); return }
        if (this.mode === 'beforeCommit') { this.error(request, 'store_unavailable'); return }
        if (payload.expectedRevision !== this.revision) { this.error(request, 'conflict'); return }
        const files = payload.body?.parts?.filter((part) => Object.hasOwn(part, 'uploadId')) || []
        for (const part of files) {
          assert.deepEqual(Object.keys(part).sort(), ['fileName', 'mime', 'name', 'size', 'uploadId'])
          const upload = uploads.get(part.uploadId)
          if (!upload?.finished) { this.error(request, 'invalid_request'); return }
          assert.equal(upload.fileName, part.fileName)
          assert.equal(upload.mime, part.mime)
          assert.equal(upload.size, part.size)
        }
        const result = { saved: true, documentId: `document-${++this.commits}` }
        receipts.set(payload.operationId, { body: payload.body, result })
        this.revision++
        for (const part of files) uploads.delete(part.uploadId)
        if (this.mode === 'lostCommit') return
        if (this.mode === 'afterCommit') { this.error(request, 'store_unavailable'); return }
        this.reply(request, { ...result, __desktop: this.metadata() })
      }
    },
  }
}
function form({ bytes = 'abc', fileName = 'cv.pdf', mime = 'application/pdf', note = 'private fields', fieldName = 'documents', reordered = false } = {}) {
  const data = new FormData()
  const file = new File([bytes], fileName, { type: mime })
  if (reordered) data.append('source', 'pipeline')
  data.append('note', note)
  data.append(fieldName, file)
  if (!reordered) data.append('source', 'pipeline')
  return data
}
const uploadCount = () => host.packets.filter((packet) => packet.operation.startsWith('upload')).length
async function refresh() { await desktopApi('/state') }
async function uncertain(route = path, data = form(), mode = 'afterCommit') {
  host.mode = mode
  const pending = desktopApi(route, { method: 'POST', body: data })
  const rejected = assert.rejects(pending, { code: 'store_unavailable', uncertain: true })
  const request = await host.nextWrite()
  await rejected
  return request
}
async function confirm(route = path, data = form()) {
  host.mode = 'success'
  const pending = desktopApi(route, { method: 'POST', body: data })
  const request = await host.nextWrite()
  const result = await pending
  assert.equal(result.saved, true)
  return { request, result }
}

beforeEach(async () => {
  host = documentHost()
  globalThis.window = { chrome: { webview: host } }
  globalThis.fetch = () => { throw new Error('No HTTP fallback') }
  // Revisions are monotonic across tests even though the synthetic host is replaced.
  const { getDesktopState } = await import('./desktopApi.js')
  host.revision = (getDesktopState().revision ?? 0) + 1
  await refresh()
  host.packets.length = 0
})
afterEach(() => {
  globalThis.window = originalWindow
  globalThis.fetch = originalFetch
  globalThis.setTimeout = originalSetTimeout
})

test('rebuilt FormData with new File objects replays an uncertain committed operation without new uploads', async () => {
  const initialForm = form()
  const initial = await uncertain(path, initialForm)
  const count = uploadCount()
  assert.equal(count, 3)
  assert.equal(host.uploads.size, 0, 'The committed host already consumed the upload')
  await refresh()
  const rebuilt = form({ reordered: true })
  assert.notEqual(rebuilt.get('documents'), initialForm.get('documents'))
  const { request, result } = await confirm(path, rebuilt)
  assert.equal(request.payload.operationId, initial.payload.operationId)
  assert.equal(request.payload.expectedRevision, initial.payload.expectedRevision)
  assert.deepEqual(request.payload.body, initial.payload.body)
  assert.equal(result.documentId, 'document-1')
  assert.equal(host.commits, 1)
  assert.equal(uploadCount(), count)
  assert.deepEqual(Object.keys(request.payload).sort(), ['body', 'expectedRevision', 'method', 'operationId', 'path'])
})

test('lost multipart commit response times out then explicit replay reuses body and receipt with no retry traffic', async () => {
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay === DESKTOP_TIMEOUT_MS ? 25 : delay, ...args)
  host.mode = 'lostCommit'
  const pending = desktopApi(path, { method: 'POST', body: form() })
  const rejected = assert.rejects(pending, { code: 'bridge_timeout', uncertain: true })
  const initial = await host.nextWrite()
  await rejected
  const count = host.packets.length
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.packets.length, count, 'There was no automatic replay')
  const { request } = await confirm(path, form())
  assert.equal(request.payload.operationId, initial.payload.operationId)
  assert.deepEqual(request.payload.body, initial.payload.body)
  assert.equal(uploadCount(), 3)
  assert.equal(host.commits, 1)
})

test('concurrent identical rebuilt forms share one upload sequence and one operation', async () => {
  host.mode = 'afterCommit'
  const outcomes = await Promise.allSettled([
    desktopApi(path, { method: 'POST', body: form() }),
    desktopApi(path, { method: 'POST', body: form({ reordered: true }) }),
  ])
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
  const [first, replay] = [await host.nextWrite(), await host.nextWrite()]
  assert.equal(replay.payload.operationId, first.payload.operationId)
  assert.deepEqual(replay.payload.body, first.payload.body)
  assert.equal(uploadCount(), 3)
  assert.equal(host.commits, 1)
})

test('invalid commit response metadata preserves cached refs for the next explicit caller retry', async () => {
  const originalReply = host.reply
  host.reply = function (request, result, error) {
    if (request.operation === 'legacyApi' && request.payload.method === 'POST' && result) {
      const { __desktop, ...legacy } = result
      originalReply.call(this, request, legacy, error)
    } else originalReply.call(this, request, result, error)
  }
  const pending = desktopApi(path, { method: 'POST', body: form() })
  const rejected = assert.rejects(pending, { code: 'invalid_metadata', uncertain: true })
  const first = await host.nextWrite()
  await rejected
  host.reply = originalReply
  const { request } = await confirm(path, form())
  assert.equal(request.payload.operationId, first.payload.operationId)
  assert.deepEqual(request.payload.body, first.payload.body)
  assert.equal(uploadCount(), 3)
  assert.equal(host.commits, 1)
})

test('content, file name, MIME, field names, text values and path distinguish multipart intentions', async () => {
  const cases = [
    { bytes: 'abd' }, // Same name/MIME/size but different bytes.
    { fileName: 'other.pdf' },
    { mime: 'application/msword' },
    { fieldName: 'otherDocuments' },
    { note: 'changed fields' },
    { bytes: 'abcd' },
  ]
  for (let i = 0; i < cases.length; i++) {
    const route = `${path}?intent=${i}`
    const original = await uncertain(route)
    await refresh()
    const count = uploadCount()
    const { request: changed } = await confirm(route, form(cases[i]))
    assert.notEqual(changed.payload.operationId, original.payload.operationId)
    assert.notEqual(changed.payload.body.parts[1].uploadId, original.payload.body.parts[1].uploadId)
    assert.equal(uploadCount(), count + 3)
    const { request: replay } = await confirm(route)
    assert.equal(replay.payload.operationId, original.payload.operationId)
    assert.equal(uploadCount(), count + 3)
  }
  const original = await uncertain(`${path}?route=one`)
  await refresh()
  const count = uploadCount()
  const { request: other } = await confirm(`${path}?route=two`)
  assert.notEqual(other.payload.operationId, original.payload.operationId)
  assert.equal(uploadCount(), count + 3)
  await confirm(`${path}?route=one`)
})

test('confirmed success clears references so a later legitimate identical submission uploads anew', async () => {
  const { request: first } = await confirm(path, form())
  const { request: second } = await confirm(path, form())
  assert.notEqual(second.payload.operationId, first.payload.operationId)
  assert.notEqual(second.payload.body.parts[1].uploadId, first.payload.body.parts[1].uploadId)
  assert.equal(uploadCount(), 6)
  assert.equal(host.commits, 2)
})

test('definitive rejection clears UUID and cached references for the next explicit action', async () => {
  for (const code of ['invalid_request', 'forbidden', 'conflict', 'read_only']) {
    const route = `${path}?reject=${code}`
    host.mode = 'reject'
    host.rejectCode = code
    const pending = desktopApi(route, { method: 'POST', body: form() })
    const rejected = assert.rejects(pending, { code, uncertain: false })
    const initial = await host.nextWrite()
    await rejected
    const count = uploadCount()
    await refresh()
    const { request } = await confirm(route, form())
    assert.notEqual(request.payload.operationId, initial.payload.operationId)
    assert.notEqual(request.payload.body.parts[1].uploadId, initial.payload.body.parts[1].uploadId)
    assert.equal(uploadCount(), count + 3)
  }
})

test('expired uncommitted upload rejects the cached replay then next explicit action stages fresh files', async () => {
  const initial = await uncertain(path, form(), 'beforeCommit')
  host.uploads.clear() // Simulate DocumentApi expiry, without a durable business receipt.
  host.mode = 'success'
  const pending = desktopApi(path, { method: 'POST', body: form() })
  const rejected = assert.rejects(pending, { code: 'invalid_request', uncertain: false })
  const replay = await host.nextWrite()
  await rejected
  assert.equal(replay.payload.operationId, initial.payload.operationId)
  assert.deepEqual(replay.payload.body, initial.payload.body)
  assert.equal(uploadCount(), 3, 'No automatic restaging after expiry')
  const { request: next } = await confirm(path, form())
  assert.notEqual(next.payload.operationId, initial.payload.operationId)
  assert.equal(uploadCount(), 6)
  assert.equal(host.commits, 1)
})

test('all size and part limits are checked before reading files or starting uploads', async () => {
  let reads = 0
  class ProbeFile extends File {
    async arrayBuffer() { reads++; return super.arrayBuffer() }
  }
  const make = () => {
    const data = new FormData()
    data.append('documents', new ProbeFile(['abc'], 'cv.pdf', { type: 'application/pdf' }))
    return data
  }
  const oversizedText = make()
  oversizedText.append('notes', 'x'.repeat(512 * 1024 + 1))
  await assert.rejects(desktopApi(path, { method: 'POST', body: oversizedText }), { code: 'form_too_large' })
  const tooMany = make()
  for (let i = 0; i < 128; i++) tooMany.append(`field-${i}`, '')
  await assert.rejects(desktopApi(path, { method: 'POST', body: tooMany }), { code: 'form_too_large' })
  const serialized = make()
  serialized.append('notes', '\u0000'.repeat(200 * 1024))
  await assert.rejects(desktopApi(path, { method: 'POST', body: serialized }), { code: 'message_too_large' })
  class OversizedFile extends ProbeFile { get size() { return 50 * 1024 * 1024 + 1 } }
  const oversizedFile = new FormData()
  oversizedFile.append('documents', new OversizedFile(['abc'], 'cv.pdf', { type: 'application/pdf' }))
  await assert.rejects(desktopApi(path, { method: 'POST', body: oversizedFile }), { code: 'form_too_large' })
  class TotalFile extends ProbeFile { get size() { return 33 * 1024 * 1024 } }
  const oversizedTotal = new FormData()
  oversizedTotal.append('one', new TotalFile(['a'], 'one.pdf', { type: 'application/pdf' }))
  oversizedTotal.append('two', new TotalFile(['b'], 'two.pdf', { type: 'application/pdf' }))
  await assert.rejects(desktopApi(path, { method: 'POST', body: oversizedTotal }), { code: 'form_too_large' })
  assert.equal(reads, 0)
  assert.equal(host.packets.length, 0)
})

test('multipart cache shares the 128-operation quota with JSON and never stages overflow or evicts unresolved refs', async () => {
  const originals = []
  for (let i = 0; i < DESKTOP_MAX_PENDING_OPERATIONS; i++) {
    originals.push(await uncertain(`${path}?quota=${i}`, form(), 'beforeCommit'))
  }
  const count = host.packets.length
  await assert.rejects(desktopApi('/quota/json', { method: 'POST', body: {} }), { code: 'pending_operations_full' })
  await assert.rejects(desktopApi(`${path}?quota=new`, { method: 'POST', body: form() }), { code: 'pending_operations_full' })
  assert.equal(host.packets.length, count, 'New multipart intention must be blocked before staging')
  const { request: replay } = await confirm(`${path}?quota=0`, form())
  assert.equal(replay.payload.operationId, originals[0].payload.operationId)
  assert.deepEqual(replay.payload.body, originals[0].payload.body)
  assert.equal(uploadCount(), DESKTOP_MAX_PENDING_OPERATIONS * 3)
  await confirm('/quota/json', {})
  host.mode = 'reject'
  host.rejectCode = 'invalid_request'
  for (let i = 1; i < originals.length; i++) {
    const pending = desktopApi(`${path}?quota=${i}`, { method: 'POST', body: form() })
    const rejected = assert.rejects(pending, { code: 'invalid_request' })
    const request = await host.nextWrite()
    assert.equal(request.payload.operationId, originals[i].payload.operationId)
    assert.deepEqual(request.payload.body, originals[i].payload.body)
    await rejected
  }
  assert.equal(uploadCount(), DESKTOP_MAX_PENDING_OPERATIONS * 3)
})
