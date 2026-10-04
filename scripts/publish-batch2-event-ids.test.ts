import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PUBLISH_BATCH2_EVENT_IDS } from './data/publish-batch2-event-ids'
import { WALKERPLUS_BATCH2_SOURCE_IDS } from './data/walkerplus-batch2-ids'

test('publish batch 2 is the explicit 75 event ids', () => {
  const ids = [...PUBLISH_BATCH2_EVENT_IDS]
  assert.equal(ids.length, 75)
  assert.equal(new Set(ids).size, 75)
  assert.deepEqual(
    ids.slice(0, 72),
    Array.from({ length: 72 }, (_, index) => 229 + index),
  )
  assert.deepEqual(ids.slice(72), [303, 304, 307])
  for (const ended of [301, 302, 305, 306, 308]) {
    assert.equal(ids.includes(ended), false)
  }
  assert.equal(WALKERPLUS_BATCH2_SOURCE_IDS.length, 70)
})
