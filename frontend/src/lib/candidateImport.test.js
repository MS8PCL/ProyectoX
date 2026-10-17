import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCandidateImportRow, buildCandidateImportForm } from './candidateImport.js'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { computed, reactive, ref, watch, nextTick } from 'vue'
import { t } from './i18n.js'

const file = (name = 'original.zip', size = 1) => new File([new Uint8Array(size)], name, { type: 'application/octet-stream' })
const code = (row, legacyWeb = false) => validateCandidateImportRow(row, new Date('2026-10-14T12:00:00Z'), legacyWeb).errorCode
const webRow = () => ({ firstName: 'Ana', lastName: 'López', email: 'ana@example.com', birthDate: '2000-02-29', coverLetter: 'Carta', cv: new File(['cv'], 'real.pdf', { type: 'application/pdf' }) })

// Execute the actual modal functions with Vue reactivity; only transport is replaced.
const page = readFileSync(new URL('../pages/PipelineServerPage.vue', import.meta.url), 'utf8')
function modalRuntime(apiForm = async () => ({ ok: true }), desktop = true) {
  const route = reactive({ query: {} })
  const companyListings = ref([])
  const openListingId = ref('')
  const modalSource = page.slice(page.indexOf('const importModal = reactive('), page.indexOf('async function exportListingZip('))
  const querySource = page.slice(page.indexOf('function pickInitialOpen()'), page.indexOf('// Each desktop read'))
  return runInNewContext(`${modalSource}\n${querySource}\n;({ importModal, importPreview, openImportModal, closeImportModal, addImportRow, removeImportRow, toImportEdit, runImport, route, companyListings, openListingId })`, {
    computed, reactive, ref, watch, route, companyListings, openListingId,
    validateCandidateImportRow, buildCandidateImportForm, t, apiForm, isDesktop: () => desktop,
    loadApplications: async () => {}, console: { log() {} },
  })
}

test('double click sends once, blocks closing/editing and never resends completed rows', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const sends = []
  const ui = modalRuntime(async (path, form) => { sends.push({ path, form }); await gate; return { ok: true } })
  ui.openImportModal('listing-1')
  ui.importModal.step = 'preview'
  assert.equal(ui.importPreview.value[0].name, 'Sin nombre')
  const first = ui.runImport()
  await ui.runImport()
  ui.closeImportModal()
  ui.toImportEdit()
  ui.removeImportRow(0)
  ui.addImportRow()
  ui.openImportModal('listing-2')
  assert.equal(ui.importModal.open, true)
  assert.equal(ui.importModal.step, 'preview')
  assert.equal(ui.importModal.rows.length, 1)
  assert.equal(ui.importModal.listingId, 'listing-1')
  assert.equal(sends.length, 1)
  assert.equal(sends[0].path, '/interno/listings/listing-1/import_candidate')
  assert.equal(sends[0].form.has('cv'), false)
  release()
  await first
  await ui.runImport()
  assert.equal(sends.length, 1)
  assert.equal(ui.importModal.results[0].name, 'Sin nombre')
  assert.equal(ui.importModal.loading, false)
  ui.closeImportModal()
  assert.equal(ui.importModal.open, false)
})

test('after a partial failure retries only rows not already imported', async () => {
  let attempt = 0
  const sent = []
  const ui = modalRuntime(async (_path, form) => {
    sent.push(form.get('firstName'))
    if (++attempt === 2) throw new Error('transport failed')
    return { ok: true }
  })
  ui.openImportModal('listing-1')
  ui.importModal.rows[0].firstName = 'Ana'
  ui.addImportRow({ firstName: 'Luis' })
  await ui.runImport()
  assert.equal(ui.importModal.error, 'transport failed')
  assert.equal(ui.importModal.loading, false)
  await ui.runImport()
  assert.deepEqual(sent, ['Ana', 'Luis', 'Luis'])
})

test('query import opens once after resolving a listing, ignores polling and handles query changes', async () => {
  const ui = modalRuntime()
  ui.route.query = { listingId: 'missing', import: '1' }
  await nextTick()
  assert.equal(ui.importModal.open, false)
  ui.companyListings.value = [{ id: 'a' }, { id: 'b' }]
  await nextTick()
  assert.equal(ui.importModal.open, false)
  ui.route.query = { listingId: 'a', import: '1' }
  await nextTick()
  assert.equal(ui.importModal.listingId, 'a')
  ui.closeImportModal()
  ui.companyListings.value = [{ id: 'a' }, { id: 'b' }]
  await nextTick()
  assert.equal(ui.importModal.open, false)
  ui.route.query = { listingId: 'a' }
  await nextTick()
  ui.route.query = { listingId: 'a', import: '1' }
  await nextTick()
  assert.equal(ui.importModal.listingId, 'a')
  ui.route.query = { listingId: 'b', import: '1' }
  await nextTick()
  assert.equal(ui.importModal.listingId, 'b')
  ui.closeImportModal()
  ui.route.query = { listingId: 'later', import: '1' }
  await nextTick()
  assert.equal(ui.importModal.open, false)
  ui.companyListings.value = [{ id: 'later' }, { id: 'a' }]
  await nextTick()
  assert.equal(ui.importModal.listingId, 'later')
})

test('query changes during import are deferred without replacing in-flight rows', async () => {
  let release
  const ui = modalRuntime(() => new Promise((resolve) => { release = resolve }))
  ui.companyListings.value = [{ id: 'a' }, { id: 'b' }]
  ui.route.query = { listingId: 'a', import: '1' }
  await nextTick()
  const pending = ui.runImport()
  ui.route.query = { listingId: 'b', import: '1' }
  await nextTick()
  assert.equal(ui.importModal.listingId, 'a')
  release({ ok: true })
  await pending
  await nextTick()
  assert.equal(ui.importModal.listingId, 'b')
  assert.equal(ui.importModal.rows[0].imported, undefined)
})

test('legacy web accepts complete candidates with PDF, DOC and DOCX files', () => {
  for (const [extension, type] of [['pdf', 'application/pdf'], ['doc', 'application/msword'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]) {
    const row = { ...webRow(), cv: new File(['cv'], `real.${extension}`, { type }), certs: [new File(['cert'], `cert.${extension}`, { type })] }
    assert.equal(code(row, true), '')
    assert.equal(buildCandidateImportForm(row).get('cv').name, `real.${extension}`)
  }
})

test('legacy web requires all text fields and a CV without changing desktop optional mode', () => {
  assert.equal(code({}, true), 'pipeline.importWebRequirements')
  for (const key of ['firstName', 'lastName', 'email', 'birthDate', 'coverLetter', 'cv']) {
    const row = webRow()
    delete row[key]
    assert.equal(code(row, true), 'pipeline.importWebRequirements', key)
    assert.equal(code(row), '', key)
  }
})

test('legacy web rejects unsupported MIME types and attachments while desktop accepts them', () => {
  for (const row of [
    { ...webRow(), cv: file('cv.zip') },
    { ...webRow(), cv: new File(['x'], 'fake.pdf') },
    { ...webRow(), certs: [file('cert.zip')] },
    { ...webRow(), attachments: [file('portfolio.zip')] },
  ]) {
    assert.equal(code(row, true), 'pipeline.importWebRequirements')
    assert.equal(code(row), '')
  }
})

test('browser preview prevents invalid sends and still imports a complete legacy candidate', async () => {
  const sends = []
  const ui = modalRuntime(async (_path, form) => { sends.push(form); return { ok: true } }, false)
  ui.openImportModal('web-listing')
  assert.equal(ui.importPreview.value[0].errorCode, 'pipeline.importWebRequirements')
  await ui.runImport()
  assert.equal(sends.length, 0)
  Object.assign(ui.importModal.rows[0], webRow())
  assert.equal(ui.importPreview.value[0].errorCode, '')
  await ui.runImport()
  assert.equal(sends.length, 1)
  assert.equal(sends[0].get('cv').name, 'real.pdf')
  assert.equal(sends[0].has('attachments'), false)
})

test('year zero is invalid in both modes; DateOnly minimum year remains valid', () => {
  for (const legacyWeb of [false, true]) {
    assert.equal(code({ ...webRow(), birthDate: '0000-01-01' }, legacyWeb), 'pipeline.importInvalidBirthDate')
    assert.equal(code({ ...webRow(), birthDate: '0001-01-01' }, legacyWeb), '')
  }
})

test('all fields are optional; empty and absent rows build without files', () => {
  for (const row of [{}, { firstName: '  ', email: '', cv: null, certs: [], attachments: [] }]) {
    assert.equal(code(row), '')
    const form = buildCandidateImportForm(row)
    assert.deepEqual([...form.keys()], ['firstName', 'lastName', 'email', 'birthDate', 'coverLetter'])
    assert.ok([...form.values()].every((value) => value === ''))
  }
})

test('trims informed text and preserves real filenames and arbitrary formats', () => {
  const cv = file('Mi CV.xlsx')
  const certs = [file('cert.bin'), file('cert.csv')]
  const attachments = [file('portfolio.zip'), file('foto.png')]
  const row = { firstName: ' Ana ', lastName: ' López ', email: ' ana@example.com ', birthDate: '2000-02-29', coverLetter: ' Carta ', cv, certs, attachments }
  assert.equal(code(row), '')
  const form = buildCandidateImportForm(row)
  assert.equal(form.get('firstName'), 'Ana')
  assert.equal(form.get('coverLetter'), 'Carta')
  assert.equal(form.get('cv').name, 'Mi CV.xlsx')
  assert.deepEqual(form.getAll('certificates').map((f) => f.name), ['cert.bin', 'cert.csv'])
  assert.deepEqual(form.getAll('attachments').map((f) => f.name), ['portfolio.zip', 'foto.png'])
})

test('attachments and certificates do not require a CV or identity', () => {
  const form = buildCandidateImportForm({ certs: [file()], attachments: [file()] })
  assert.equal(form.has('cv'), false)
  assert.equal(form.getAll('certificates').length, 1)
  assert.equal(form.getAll('attachments').length, 1)
  assert.equal(form.get('email'), '')
})

test('validates only informed email and real calendar dates', () => {
  for (const email of ['invalid', 'a b@example.com', 'a@@example.com', 'a@', 'a@.', 'a@..com', 'a@-example.com', 'a@exa_mple.com']) assert.equal(code({ email }), 'pipeline.importInvalidEmail')
  for (const birthDate of ['2025-02-29', '2000-02-30', '2026-13-01', '01/01/2000', '2026-10-16']) assert.equal(code({ birthDate }), 'pipeline.importInvalidBirthDate')
  for (const birthDate of ['', '2000-02-29', '2026-10-15']) assert.equal(code({ birthDate }), '')
})

test('checks every text length at and over its limit', () => {
  for (const [field, max] of [['firstName', 80], ['lastName', 120], ['email', 120], ['birthDate', 40], ['coverLetter', 5000]]) {
    assert.equal(code({ [field]: 'x'.repeat(max + 1) }), 'pipeline.importTextTooLong')
    if (!['email', 'birthDate'].includes(field)) assert.equal(code({ [field]: 'x'.repeat(max) }), '')
  }
})

test('rejects non-files, fake files, Blobs, empty files and multiple CVs before building', () => {
  for (const invalid of ['file.pdf', {}, { name: 'fake', size: 1, arrayBuffer() {} }, new Blob(['x']), new Blob([]), file('empty', 0), [file(), file()]]) {
    for (const row of [{ cv: invalid }, { certs: [invalid] }, { attachments: [invalid] }]) {
      assert.equal(code(row), 'pipeline.importInvalidFile')
      assert.throws(() => buildCandidateImportForm(row), { code: 'pipeline.importInvalidFile' })
    }
  }
  for (const row of [{ certs: 'bad' }, { attachments: {} }]) assert.equal(code(row), 'pipeline.importInvalidFile')
})

test('enforces 128 multipart parts including five text fields', () => {
  const small = file()
  assert.equal(code({ attachments: Array(123).fill(small) }), '')
  assert.equal(code({ cv: small, certs: Array(122).fill(small) }), '')
  assert.equal(code({ attachments: Array(124).fill(small) }), 'pipeline.importTooManyFiles')
  assert.equal(code({ cv: small, certs: Array(123).fill(small) }), 'pipeline.importTooManyFiles')
})

test('accepts exact 50 MiB/file and 64 MiB total and rejects one byte over', () => {
  const mib = 1024 * 1024
  const large = file('large.bin', 50 * mib)
  const remainder = file('remainder.bin', 14 * mib)
  assert.equal(code({ cv: large, attachments: [remainder] }), '')
  assert.equal(code({ cv: large, attachments: [remainder, file()] }), 'pipeline.importTotalTooLarge')
  assert.equal(code({ cv: file('oversized.bin', 50 * mib + 1) }), 'pipeline.importFileTooLarge')
})
