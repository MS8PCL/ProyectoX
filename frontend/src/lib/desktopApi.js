import {
  DesktopError, desktopRequest, desktopUuid, assertDesktopMessageSize, uploadDesktopFile,
  DESKTOP_MAX_FILE_BYTES, DESKTOP_MAX_UPLOAD_BYTES, desktopSha256, isDefinitiveDesktopError,
} from './desktopBridge.js'

let state = { revision: null, readOnly: false, appliedOperationIds: [] }
export const DESKTOP_MAX_PENDING_OPERATIONS = 128
// JSON retains only receipt identities. Multipart additionally retains encoded text/reference
// bodies, never File objects or bytes. Both share one bounded, session-only registry.
// Reloading/closing the renderer loses these identities: there is no cross-session replay guarantee.
const pendingOperations = new Map()

function pendingOperation(key, operationId, expectedRevision) {
  let operation = pendingOperations.get(key)
  if (!operation) {
    if (pendingOperations.size >= DESKTOP_MAX_PENDING_OPERATIONS) {
      throw new DesktopError('pending_operations_full', 'Hay 128 operaciones pendientes o inciertas. Resuelva una operación existente antes de iniciar nuevas escrituras; no se ha descartado ninguna.')
    }
    operation = { operationId, expectedRevision, sent: false }
    pendingOperations.set(key, operation)
  }
  return operation
}

function discardOperation(key, operation) {
  if (pendingOperations.get(key) === operation) pendingOperations.delete(key)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
export function getDesktopState() {
  return { ...state, appliedOperationIds: [...state.appliedOperationIds] }
}

function legacyResult(result) {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, '__desktop')) return result
  const metadata = result.__desktop
  if (!metadata || !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 ||
      typeof metadata.readOnly !== 'boolean' || !Array.isArray(metadata.appliedOperationIds) ||
      !metadata.appliedOperationIds.every((id) => typeof id === 'string')) {
    throw new DesktopError('invalid_metadata', 'Metadatos de revisión inválidos del host desktop.', { uncertain: true })
  }
  // An older concurrent read must not roll back a revision confirmed by a write.
  if (state.revision === null || metadata.revision >= state.revision) {
    state = { revision: metadata.revision, readOnly: metadata.readOnly, appliedOperationIds: [...metadata.appliedOperationIds] }
  }
  const { __desktop, ...legacy } = result
  return legacy
}

export const DESKTOP_MAX_FORM_BYTES = 512 * 1024
export const DESKTOP_MAX_FORM_PARTS = 128

function validateDesktopForm(form, request = {}) {
  const entries = Array.from(form.entries())
  if (entries.length > DESKTOP_MAX_FORM_PARTS) throw new DesktopError('form_too_large', 'Demasiadas partes multipart.')
  const parts = []
  let textBytes = 0
  let fileBytes = 0
  // Validate the entire form before creating any staging uploads on the host.
  for (const [name, value] of entries) {
    if (typeof value === 'string') {
      textBytes += new TextEncoder().encode(value).byteLength
      if (textBytes > DESKTOP_MAX_FORM_BYTES) throw new DesktopError('form_too_large', 'Los textos del formulario superan 512 KiB.')
      parts.push({ name, value })
    } else {
      if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > DESKTOP_MAX_FILE_BYTES) {
        throw new DesktopError('form_too_large', 'Cada archivo debe tener entre 1 byte y 50 MiB.')
      }
      fileBytes += value.size
      if (fileBytes > DESKTOP_MAX_UPLOAD_BYTES) throw new DesktopError('form_too_large', 'Los archivos del formulario superan 64 MiB.')
      parts.push({ name, uploadId: '00000000-0000-0000-0000-000000000000', fileName: value.name || 'blob', mime: value.type || 'application/octet-stream', size: value.size })
    }
  }
  assertDesktopMessageSize('legacyApi', {
    path: '', method: 'POST', expectedRevision: Number.MAX_SAFE_INTEGER,
    operationId: '00000000-0000-0000-0000-000000000000', ...request, body: { parts },
  })
  return { entries, parts }
}

async function encodeValidatedForm({ entries, parts }) {
  for (let i = 0; i < entries.length; i++) {
    if (typeof entries[i][1] !== 'string') parts[i] = { name: entries[i][0], ...await uploadDesktopFile(entries[i][1]) }
  }
  return { parts }
}

/** Multipart wire format: {parts:[{name,value}|{name,uploadId,fileName,mime,size}]}. */
export async function encodeDesktopForm(form, request = {}) {
  return encodeValidatedForm(validateDesktopForm(form, request))
}

async function fileFingerprint(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size) throw new DesktopError('invalid_file', 'La longitud del archivo no coincide con su tamaño declarado.')
  return desktopSha256(bytes)
}

async function prepareMultipartOperation(form, request) {
  // All limits, including the serialized envelope, are checked before file reads or staging.
  const validated = validateDesktopForm(form, request)
  const fields = []
  const files = []
  for (let i = 0; i < validated.entries.length; i++) {
    const [name, value] = validated.entries[i]
    if (typeof value === 'string') fields.push(canonicalJson({ name, value }))
    else {
      const { uploadId, ...metadata } = validated.parts[i]
      files.push({ ...metadata, sha256: await fileFingerprint(value) })
    }
  }
  // Text field order is immaterial; file order and duplicate field values remain represented.
  const fingerprint = canonicalJson({ path: request.path, method: request.method, fields: fields.sort(), files })
  const key = `multipart:${await desktopSha256(new TextEncoder().encode(fingerprint))}`
  const operation = pendingOperation(key, request.operationId, request.expectedRevision)
  if (!operation.body && !operation.encoding) {
    // Reserve the shared quota before staging; simultaneous callers await the same upload sequence.
    operation.encoding = encodeValidatedForm(validated).then((body) => {
      operation.body = body
      delete operation.encoding
      return body
    }, (error) => {
      // No legacy mutation was sent: failed staging cannot have committed a business record.
      discardOperation(key, operation)
      throw error
    })
  }
  const body = operation.body || await operation.encoding
  return { key, operation, body }
}

export async function desktopApi(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase()
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new DesktopError('invalid_path', 'La API desktop requiere una ruta legacy relativa.')
  }
  const pathname = path.split('?')[0].replace(/\/+$/, '')
  if (['/auth/login', '/auth/register', '/register', '/auth/logout'].includes(pathname)) {
    throw new DesktopError('windows_auth', 'Desktop utiliza la identidad de Windows; no admite contraseñas, registro público ni cierre de la sesión Windows desde la aplicación.')
  }
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const multipart = typeof FormData !== 'undefined' && init.body instanceof FormData
  // Do not stage files for a mutation that cannot be sent to the host.
  if (multipart && mutation && state.readOnly) throw new DesktopError('read_only', 'El almacenamiento desktop está en modo de solo lectura.')
  if (multipart && mutation && state.revision === null) throw new DesktopError('revision_required', 'Consulte el estado del host antes de guardar; falta la revisión confirmada.')
  const operationId = desktopUuid()
  const expectedRevision = state.revision
  let body = init.body ?? null
  let key
  let operation
  let payload
  let attempted = false
  try {
    if (multipart && mutation) {
      const prepared = await prepareMultipartOperation(body, { path, method, expectedRevision, operationId })
      key = prepared.key
      operation = prepared.operation
      body = prepared.body
    } else if (multipart) body = await encodeDesktopForm(body, { path, method, expectedRevision, operationId })
    else if (typeof body === 'string') {
      try { body = JSON.parse(body) } catch {
        throw new DesktopError('invalid_body', 'El cuerpo de la API desktop debe ser JSON válido.')
      }
    } else if (body !== null && (typeof body !== 'object' || Object.getPrototypeOf(body) !== Object.prototype && !Array.isArray(body))) {
      throw new DesktopError('invalid_body', 'Tipo de cuerpo no soportado por la API desktop.')
    }
    if (mutation && state.readOnly) throw new DesktopError('read_only', 'El almacenamiento desktop está en modo de solo lectura.')
    if (mutation && state.revision === null) throw new DesktopError('revision_required', 'Consulte el estado del host antes de guardar; falta la revisión confirmada.')
    // Clone cached reference bodies too: caller/transport changes cannot corrupt a future replay.
    try { body = JSON.parse(JSON.stringify(body)) } catch {
      throw new DesktopError('invalid_body', 'El cuerpo de la API desktop debe ser serializable como JSON.')
    }
    payload = { path, method, body, expectedRevision, operationId }
    assertDesktopMessageSize('legacyApi', payload)
    if (mutation) {
      if (!operation) {
        key = `json:${await desktopSha256(new TextEncoder().encode(canonicalJson({ path, method, body })))}`
        operation = pendingOperation(key, operationId, expectedRevision)
      }
      // Internal cached body/encoding/sent fields must never leak into the host payload.
      payload.operationId = operation.operationId
      payload.expectedRevision = operation.expectedRevision
      operation.sent = true
    }
    attempted = true
    const result = await desktopRequest('legacyApi', payload)
    if (mutation && (!result || typeof result !== 'object' || !Object.hasOwn(result, '__desktop'))) {
      throw new DesktopError('invalid_metadata', 'El host no ha confirmado la revisión de la escritura; consulte el estado antes de repetirla.', { uncertain: true })
    }
    const legacy = legacyResult(result)
    if (mutation) discardOperation(key, operation)
    return legacy
  } catch (error) {
    if (mutation && operation) {
      if (!operation.sent || (attempted && isDefinitiveDesktopError(error))) discardOperation(key, operation)
      else {
        // A local pre-send failure cannot resolve an earlier uncertain commit of this operation.
        error.uncertain = true
      }
    }
    if (payload) {
      error.operationId = payload.operationId
      error.expectedRevision = payload.expectedRevision
    }
    throw error
  }
}
