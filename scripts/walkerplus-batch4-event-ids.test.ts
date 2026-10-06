import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WALKERPLUS_BATCH4_EVENT_IDS } from './data/walkerplus-batch4-event-ids'

test('walkerplus batch 4 image targets are event ids 456 through 505', () => {
  const ids = [...WALKERPLUS_BATCH4_EVENT_IDS]
  assert.equal(ids.length, 50)
  assert.equal(new Set(ids).size, 50)
  assert.deepEqual(
    ids,
    Array.from({ length: 50 }, (_, index) => 456 + index),
  )
})
