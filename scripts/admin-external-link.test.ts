import assert from 'node:assert/strict'
import { test } from 'node:test'
import { safeHttpUrl, sourcePageLabel } from '../src/lib/admin/external-link'

test('safeHttpUrl keeps http and https', () => {
  assert.equal(safeHttpUrl('https://www.walkerplus.com/event/ar0313e1/'), 'https://www.walkerplus.com/event/ar0313e1/')
  assert.equal(safeHttpUrl(' http://example.com/a '), 'http://example.com/a')
})

test('safeHttpUrl rejects empty and non-http URLs', () => {
  assert.equal(safeHttpUrl(''), null)
  assert.equal(safeHttpUrl(null), null)
  assert.equal(safeHttpUrl('javascript:alert(1)'), null)
  assert.equal(safeHttpUrl('not a url'), null)
})

test('source labels stay readable across sources', () => {
  assert.equal(sourcePageLabel('gotokyo'), 'GO TOKYO')
  assert.equal(sourcePageLabel('enjoytokyo'), 'EnjoyTokyo')
  assert.equal(sourcePageLabel('minato_opendata'), '港区オープンデータ')
})
