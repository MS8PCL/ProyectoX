import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { t, setLocale, currentLocale } from './i18n.js'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const source = readFileSync(new URL('./i18n.js', import.meta.url), 'utf8')
// Inspect dictionaries directly: locale fallback must not mask a missing translation.
const messages = runInNewContext(source.replace(/^export /gm, '') + '\nmessages')
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let storage
let reloads

beforeEach(() => {
  storage = new Map()
  reloads = 0
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { reload: () => { reloads++ } } },
  })
  setLocale('es')
  reloads = 0
})

afterEach(() => {
  for (const [name, descriptor] of [['localStorage', originalStorage], ['window', originalWindow]]) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else delete globalThis[name]
  }
})

function literalKeys(text) {
  // Only complete quoted arguments to bare t(): no properties or dynamic expressions.
  return [...text.matchAll(/(?<![\w$.])\bt\s*\(\s*(['"])([^'"\r\n]+)\1\s*(?=[,)])/g)]
    .map((match) => match[2])
}

function collectKeys(directory, keys = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) collectKeys(file, keys)
    else if (/\.(vue|[cm]?js|tsx?)$/.test(file) &&
      !/\.(test|spec)\./.test(entry.name) && entry.name !== 'i18n.js') {
      for (const key of literalKeys(readFileSync(file, 'utf8'))) {
        if (!keys.has(key)) keys.set(key, [])
        keys.get(key).push(path.relative(sourceRoot, file))
      }
    }
  }
  return keys
}

function lookup(dictionary, key) {
  return key.split('.').reduce((value, part) =>
    value && Object.hasOwn(value, part) ? value[part] : undefined, dictionary)
}

for (const locale of ['es', 'en']) {
  test(`all frontend literal keys exist directly in ${locale}`, (context) => {
    setLocale(locale)
    const keys = collectKeys(sourceRoot)
    assert.ok(keys.size >= 355, 'Source scan must include Vue pages and stores')
    const missing = []
    for (const [key, files] of keys) {
      const value = lookup(messages[locale], key)
      if (typeof value !== 'string' || !value.trim() || value === key) {
        missing.push(`${key}: ${files.join(', ')}`)
      } else {
        assert.equal(t(key), value, key)
      }
    }
    assert.deepEqual(missing, [], `Missing ${locale} translations:\n${missing.join('\n')}`)
    context.diagnostic(`${keys.size} literal keys checked; ${missing.length} missing`)
  })
}

test('literal scan excludes dynamic identifiers, properties and partial expressions', () => {
  assert.deepEqual(literalKeys(`
    t('home.dashboard'); t("profile.title", { n: 2 });
    t(key); t('home.' + section); t(\`home.\${section}\`);
    object.t('not.a.translation'); object?.t('also.not');
    script({ t: 'property' }); other_t('not.a.call');
  `), ['home.dashboard', 'profile.title'])
})

const addedExistingSectionKeys = new Set([
  'pipeline.addCandidate', 'pipeline.importOptionalTitle', 'pipeline.importOptionalDesc',
  'pipeline.cvOptional', 'pipeline.attachmentsOptional', 'pipeline.unnamedCandidate',
  'pipeline.importInvalidEmail', 'pipeline.importInvalidBirthDate', 'pipeline.importTextTooLong',
  'pipeline.importInvalidFile', 'pipeline.importTooManyFiles', 'pipeline.importFileTooLarge',
  'pipeline.importTotalTooLarge', 'pipeline.importPreviewErrors', 'pipeline.importMissingListing',
  'pipeline.importWebRequirements',
  'audit.subtitle', 'hireTools.submitting', 'rbac.subtitle', 'pipeline.skillsPlaceholder',
  'reports.subtitle', 'reports.reportType', 'reports.date', 'reports.action',
  'pipeline.fieldFirstName', 'pipeline.fieldLastName', 'pipeline.fieldEmail', 'pipeline.fieldBirthDate',
  'pipeline.fieldCoverLetter', 'pipeline.importResults', 'pipeline.subtitleShared',
  'pipeline.loadError', 'pipeline.docsLoadError', 'reports.loadError',
  'hireTools.missingFields', 'home.metricsError',
  'publish.editOffer', 'publish.deleteOffer', 'publish.deleteOfferConfirm', 'publish.cancelEdit', 'publish.saveOffer', 'publish.offerUpdated', 'publish.offerDeleted',
  'outbox.detailCandidate', 'outbox.detailListing', 'outbox.detailDepartment', 'outbox.detailJobTitle', 'outbox.detailStartDate',
  'outbox.detailCostCenter', 'outbox.detailManager', 'outbox.detailAccess', 'outbox.detailHardware', 'outbox.detailNotes',
])

test('new candidate import labels and dynamic validation codes exist directly in both languages', () => {
  for (const locale of ['es', 'en']) {
    setLocale(locale)
    for (const key of addedExistingSectionKeys) {
      if (!key.startsWith('pipeline.')) continue
      const value = lookup(messages[locale], key)
      assert.equal(typeof value, 'string', `${locale}: ${key}`)
      assert.ok(value.trim(), `${locale}: ${key}`)
      assert.equal(t(key), value)
    }
  }
})

function originalEntries(dictionary, prefix = '') {
  const entries = []
  for (const [name, value] of Object.entries(dictionary)) {
    const key = prefix ? `${prefix}.${name}` : name
    if (key === 'onboarding' || key === 'profile' || addedExistingSectionKeys.has(key)) continue
    if (typeof value === 'string') entries.push([key, value])
    else entries.push(...originalEntries(value, key))
  }
  return entries
}

for (const [locale, expectedHash] of [
  ['es', '1d6238ce20741855e3a5cf5f9e43e71e496c994cd7b10155fb53f2811ef91f6e'],
  ['en', '7e66971c4a24b428a1b66558887a667b65da491b3145f8fb8fad7647db5942c4'],
]) {
  test(`all 335 original ${locale} dictionary texts remain unchanged`, () => {
    // Baseline hashes were captured before adding translations, including unused keys.
    const entries = originalEntries(messages[locale]).sort(([a], [b]) => a.localeCompare(b))
    assert.equal(entries.length, 335)
    assert.equal(createHash('sha256').update(JSON.stringify(entries)).digest('hex'), expectedHash)
  })
}

test('interpolates numeric parameters in both languages, including zero', () => {
  for (const locale of ['es', 'en']) {
    setLocale(locale)
    for (const key of ['notifications.minAgo', 'notifications.hourAgo', 'notifications.dayAgo', 'profile.skillsAdded']) {
      for (const n of [0, 7]) {
        assert.equal(t(key, { n }), lookup(messages[locale], key).replace('{n}', String(n)))
      }
    }
  }
})

test('interpolates multiple parameters as plain strings without replacement syntax or recursion', () => {
  const name = '<img src=x onerror=alert(1)> $& {title}'
  const title = 'Analista & RRHH'
  assert.equal(t('candidate.emailBody', { name, title }),
    `Hola ${name},\n\nCon respecto a tu candidatura para el puesto de ${title} en Pharmamar:\n\n`)
  assert.equal(t('notifications.minAgo', { n: false }), 'hace false min')
  assert.equal(typeof t('notifications.minAgo', { n: '5' }), 'string')
})

test('leaves missing, inherited and unsafe parameter values untouched', () => {
  for (const params of [undefined, null, {}, Object.create({ n: 5 }),
    { n: null }, { n: undefined }, { n: NaN }, { n: Infinity }, { n: Symbol('n') },
    { n: () => 5 }, { n: { toString() { throw new Error('Must not execute') } } }]) {
    assert.equal(t('notifications.minAgo', params), 'hace {n} min')
  }
  assert.equal(t('candidate.emailBody', { name: 'Ana' }),
    'Hola Ana,\n\nCon respecto a tu candidatura para el puesto de {title} en Pharmamar:\n\n')
})

test('unknown keys and object paths remain visible rather than hiding missing translations', () => {
  assert.equal(t('missing.translation', { n: 1 }), 'missing.translation')
  assert.equal(t('home'), 'home')
  assert.equal(t('home.toString'), 'home.toString')
  assert.equal(t('__proto__.title'), '__proto__.title')
})

test('defaults to Spanish for missing or invalid persisted locales', () => {
  storage.clear()
  assert.equal(currentLocale(), 'es')
  for (const locale of ['', 'fr', 'ES', 'es-ES', 'undefined', 'toString', '__proto__', 'constructor']) {
    storage.set('px_locale', locale)
    assert.equal(currentLocale(), 'es', locale)
    for (const key of collectKeys(sourceRoot).keys()) {
      assert.equal(t(key), lookup(messages.es, key), `${locale}: ${key}`)
    }
  }
})

test('setLocale persists supported locales, normalizes invalid ones and reloads once', () => {
  for (const locale of ['en', 'es', 'fr', '__proto__', undefined, null]) {
    const expected = locale === 'en' ? 'en' : 'es'
    const before = reloads
    setLocale(locale)
    assert.equal(storage.get('px_locale'), expected)
    assert.equal(currentLocale(), expected)
    assert.equal(reloads, before + 1)
    assert.equal(t('nav.home'), expected === 'en' ? 'Home' : 'Inicio')
  }
})

test('storage failures still use Spanish and allow reload', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() { throw new Error('Storage unavailable') },
      setItem() { throw new Error('Storage unavailable') },
    },
  })
  assert.equal(currentLocale(), 'es')
  assert.equal(t('onboarding.nextBtn'), 'Siguiente')
  setLocale('en')
  assert.equal(reloads, 1)
})
