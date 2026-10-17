import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { candidateDisplayName } from './candidateName.js'

test('candidates are named by first and last name, or by their full name', () => {
  assert.equal(candidateDisplayName({ firstName: 'Ada', lastName: 'Lovelace', fullName: 'Otra' }), 'Ada Lovelace')
  assert.equal(candidateDisplayName({ fullName: 'Grace Hopper', email: 'g@example.org' }), 'Grace Hopper')
  assert.equal(candidateDisplayName({ name: 'Linus', email: 'l@example.org' }), 'Linus')
  assert.equal(candidateDisplayName({ email: 'x@example.org' }), '')
  assert.equal(candidateDisplayName(null), '')
  for (const page of ['PipelineServerPage.vue', 'ReportsPage.vue']) {
    assert.match(readFileSync(new URL(`../pages/${page}`, import.meta.url), 'utf8'), /candidateDisplayName/, page)
  }
})
