import { DESKTOP_MAX_FILE_BYTES, DESKTOP_MAX_UPLOAD_BYTES } from './desktopBridge.js'

const textLimits = { firstName: 80, lastName: 120, email: 120, birthDate: 40, coverLetter: 5000 }
// The bridge permits 128 multipart parts, including these five text fields.
const maxParts = 128

export function validateCandidateImportRow(row = {}, now = new Date(), legacyWeb = false) {
  const fields = Object.fromEntries(Object.keys(textLimits).map((key) => [key, String(row[key] ?? '').trim()]))
  const cv = row.cv ?? null
  const certs = row.certs ?? []
  const attachments = row.attachments ?? []
  const result = { ...fields, cv, certs, attachments, errorCode: '' }
  const fail = (errorCode) => ({ ...result, errorCode })
  if (Object.entries(textLimits).some(([key, limit]) => fields[key].length > limit)) return fail('pipeline.importTextTooLong')
  if (fields.email && !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(fields.email)) return fail('pipeline.importInvalidEmail')
  if (fields.birthDate) {
    const date = new Date(`${fields.birthDate}T00:00:00Z`)
    const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.birthDate) || fields.birthDate.startsWith('0000-') || Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== fields.birthDate || fields.birthDate > tomorrow) return fail('pipeline.importInvalidBirthDate')
  }
  if (!Array.isArray(certs) || !Array.isArray(attachments)) return fail('pipeline.importInvalidFile')
  const files = [...(cv === null ? [] : [cv]), ...certs, ...attachments]
  if (files.some((f) => typeof File === 'undefined' || !(f instanceof File) || !f.name.trim() ||
    !Number.isSafeInteger(f.size) || f.size < 1)) return fail('pipeline.importInvalidFile')
  if (files.length + Object.keys(textLimits).length > maxParts) return fail('pipeline.importTooManyFiles')
  if (files.some((f) => f.size > DESKTOP_MAX_FILE_BYTES)) return fail('pipeline.importFileTooLarge')
  if (files.reduce((total, f) => total + f.size, 0) > DESKTOP_MAX_UPLOAD_BYTES) return fail('pipeline.importTotalTooLarge')
  if (legacyWeb) {
    const allowedTypes = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
    if (Object.values(fields).some((value) => !value) || cv === null || attachments.length ||
      files.some((file) => !allowedTypes.includes(file.type))) return fail('pipeline.importWebRequirements')
  }
  return result
}

export function buildCandidateImportForm(row) {
  const validated = validateCandidateImportRow(row)
  if (validated.errorCode) throw Object.assign(new Error(validated.errorCode), { code: validated.errorCode })
  const form = new FormData()
  for (const key of Object.keys(textLimits)) form.set(key, validated[key])
  if (validated.cv !== null) form.append('cv', validated.cv, validated.cv.name)
  for (const file of validated.certs) form.append('certificates', file, file.name)
  for (const file of validated.attachments) form.append('attachments', file, file.name)
  return form
}
