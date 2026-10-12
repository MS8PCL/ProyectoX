import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isPipelineListing } from './listingKinds.js'

test('the pipeline and reports manage every hiring offer that Publicar creates', () => {
  for (const kind of ['empleo', 'ett', 'becario']) assert.equal(isPipelineListing({ kind }), true, kind)
  for (const kind of ['freelance', undefined, '']) assert.equal(isPipelineListing({ kind }), false, String(kind))
  for (const page of ['PipelineServerPage.vue', 'ReportsPage.vue']) {
    const source = readFileSync(new URL(`../pages/${page}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\.filter\(\(l\) => l\.kind === 'empleo'\)/, page)
    assert.match(source, /isPipelineListing/, page)
  }
})
