export const DESKTOP_TIMEOUT_MS = 30_000
export const DESKTOP_MAX_MESSAGE_BYTES = 1024 * 1024
export const DESKTOP_MAX_FILE_BYTES = 50 * 1024 * 1024
export const DESKTOP_MAX_UPLOAD_BYTES = 64 * 1024 * 1024
export const DESKTOP_MAX_CHUNK_BYTES = 256 * 1024

export function isDesktop() {
  return !!globalThis.window?.chrome?.webview
}

export class DesktopError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DesktopError'
    this.code = code
    Object.assign(this, details)
  }
}

export function isDefinitiveDesktopError(error) {
  const code = String(error?.code || '').toLowerCase()
  if (['invalid_metadata', 'invalid_response', 'invalid_upload_response'].includes(code)) return false
  return code === 'invalid' || code.startsWith('invalid_') ||
    ['forbidden', 'unauthorized', 'conflict', 'read_only', 'readonly',
      'unsupported_operation', 'unsupported_collection', 'not_found'].includes(code)
}

function hostErrorIsUncertain(error) {
  const code = String(error?.code || '').toLowerCase()
  if (isDefinitiveDesktopError(error)) return false
  return !!error?.uncertain ||
    ['store_unavailable', 'storage_unavailable', 'bridge_timeout', 'bridge_send_failed',
      'invalid_metadata', 'invalid_response', 'ioexception'].includes(code) || /(^|_)io($|_)/.test(code)
}

export function desktopUuid() {
  if (!globalThis.crypto?.randomUUID) {
    throw new DesktopError('crypto_unavailable', 'No se puede generar un identificador seguro para la operación.')
  }
  return globalThis.crypto.randomUUID()
}

export function assertDesktopMessageSize(operation, payload, id = '00000000-0000-0000-0000-000000000000') {
  if (new TextEncoder().encode(JSON.stringify({ id, operation, payload })).byteLength > DESKTOP_MAX_MESSAGE_BYTES) {
    throw new DesktopError('message_too_large', 'La solicitud supera el límite del bridge (1 MiB). Use el transporte de documentos del host.')
  }
}

export async function desktopSha256(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new DesktopError('crypto_unavailable', 'El transporte de documentos requiere crypto.subtle para verificar SHA-256.')
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
}

function base64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}

/** Stages one file in the existing DocumentApi instance; never retries any step. */
export async function uploadDesktopFile(file) {
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > DESKTOP_MAX_FILE_BYTES) {
    throw new DesktopError('form_too_large', 'Cada archivo debe tener entre 1 byte y 50 MiB.')
  }
  const fileName = file.name || 'blob'
  const mime = file.type || 'application/octet-stream'
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size) throw new DesktopError('invalid_file', 'La longitud del archivo no coincide con su tamaño declarado.')
  const wholeHash = await desktopSha256(bytes)
  let uploadId
  try {
    const begin = await desktopRequest('uploadBegin', { fileName, mime, size: bytes.length })
    if (!begin || typeof begin.uploadId !== 'string' ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(begin.uploadId) ||
        !Number.isSafeInteger(begin.chunkBytes) || begin.chunkBytes < 1 || begin.chunkBytes > DESKTOP_MAX_CHUNK_BYTES) {
      throw new DesktopError('invalid_upload_response', 'El host ha devuelto una configuración de subida inválida.', { uncertain: true })
    }
    uploadId = begin.uploadId
    for (let offset = 0; offset < bytes.length; offset += begin.chunkBytes) {
      const chunk = bytes.subarray(offset, Math.min(offset + begin.chunkBytes, bytes.length))
      const ack = await desktopRequest('uploadChunk', { uploadId, offset, base64: base64(chunk), sha256: await desktopSha256(chunk) })
      if (!ack || ack.uploadId !== uploadId || ack.offset !== offset + chunk.length) {
        throw new DesktopError('invalid_upload_response', 'El host no ha confirmado el offset del chunk enviado.', { uncertain: true })
      }
    }
    const finish = await desktopRequest('uploadFinish', { uploadId, sha256: wholeHash })
    if (!finish || finish.uploadId !== uploadId || finish.fileName !== fileName || finish.mime !== mime || finish.size !== bytes.length) {
      throw new DesktopError('invalid_upload_response', 'El host no ha confirmado los metadatos del archivo subido.', { uncertain: true })
    }
    return { uploadId, fileName: finish.fileName, mime: finish.mime, size: finish.size }
  } catch (error) {
    if (uploadId) error.uploadId = uploadId
    throw error
  }
}

// One listener per WebView, with independent correlation for concurrent requests.
const connections = new WeakMap()
function connection(bridge) {
  let pending = connections.get(bridge)
  if (pending) return pending
  pending = new Map()
  bridge.addEventListener('message', (event) => {
    const message = event.data
    if (!message || typeof message !== 'object') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    clearTimeout(request.timer)
    if (message.ok === true) request.resolve(message.result)
    else if (message.ok === false) {
      request.reject(new DesktopError(
        message.error?.code || 'host_error',
        message.error?.message || 'El host desktop no pudo completar la solicitud.',
        { requestId: message.id, uncertain: hostErrorIsUncertain(message.error) },
      ))
    } else {
      request.reject(new DesktopError('invalid_response', 'Respuesta inválida del host desktop.', {
        requestId: message.id, uncertain: true,
      }))
    }
  })
  connections.set(bridge, pending)
  return pending
}

/** Direct host operations (document pick/download etc.), without HTTP or local fallbacks. */
// These wait on a Windows dialog or confirmation; 30 s reported "uncertain" while the user
// was still choosing a folder, although the host completed the action afterwards.
export const DESKTOP_INTERACTIVE_TIMEOUT_MS = 10 * 60_000
const INTERACTIVE_OPERATIONS = new Set(['documentAction', 'openMail'])
export function desktopRequest(operation, payload = {}, {
  timeoutMs = INTERACTIVE_OPERATIONS.has(operation) ? DESKTOP_INTERACTIVE_TIMEOUT_MS : DESKTOP_TIMEOUT_MS,
} = {}) {
  const bridge = globalThis.window?.chrome?.webview
  if (!bridge) return Promise.reject(new DesktopError('bridge_unavailable', 'No hay conexión con el host desktop.'))
  if (typeof operation !== 'string' || !operation || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new DesktopError('invalid_request', 'Solicitud desktop inválida.'))
  }
  const id = desktopUuid()
  const message = { id, operation, payload }
  try { assertDesktopMessageSize(operation, payload, id) } catch (error) { return Promise.reject(error) }
  return new Promise((resolve, reject) => {
    const pending = connection(bridge)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new DesktopError('bridge_timeout',
        'El host desktop no ha respondido. El resultado puede ser incierto; consulte el estado antes de repetir la operación.',
        { requestId: id, operationId: payload?.operationId, uncertain: true }))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    try {
      bridge.postMessage(message)
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      reject(new DesktopError('bridge_send_failed', 'No se pudo enviar la solicitud al host desktop.', {
        requestId: id, operationId: payload?.operationId, uncertain: true,
      }))
    }
  })
}
