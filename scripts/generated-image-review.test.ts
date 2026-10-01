import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyDisplayedApprovals } from '../src/lib/generated-image-review'
import { groupListedEvents, listGroupLabel } from '../src/lib/event-list-groups'

test('classifyDisplayedApprovals accepts only listed pending rows with a url', () => {
  const result = classifyDisplayedApprovals(
    [10, 11, 12, 13, 14, 15],
    [
      { id: 10, generated_image_status: 'pending', generated_image_url: '/images/event-generated/10.webp' },
      { id: 11, generated_image_status: 'approved', generated_image_url: '/images/event-generated/11.webp' },
      { id: 12, generated_image_status: 'rejected', generated_image_url: '/images/event-generated/12.webp' },
      { id: 13, generated_image_status: 'blocked', generated_image_url: null },
      { id: 14, generated_image_status: 'none', generated_image_url: null },
      { id: 15, generated_image_status: 'pending', generated_image_url: '  ' },
    ],
  )
  assert.deepEqual(result.approveIds, [10])
  assert.deepEqual(result.failedIds, [11, 12, 13, 14, 15])
})

test('classifyDisplayedApprovals fails ids that were not on the loaded rows', () => {
  const result = classifyDisplayedApprovals(
    [1, 2],
    [{ id: 2, generated_image_status: 'pending', generated_image_url: '/a.webp' }],
  )
  assert.deepEqual(result.approveIds, [2])
  assert.deepEqual(result.failedIds, [1])
})

test('groupListedEvents keeps order and starts a group when status changes', () => {
  const groups = groupListedEvents(
    [
      { id: 1, status: 'today' },
      { id: 2, status: 'today' },
      { id: 3, status: 'upcoming' },
      { id: 4, status: 'upcoming' },
    ],
    (event) => event.status,
  )
  assert.deepEqual(
    groups.map((group) => ({ key: group.key, ids: group.events.map((event) => event.id) })),
    [
      { key: 'today', ids: [1, 2] },
      { key: 'upcoming', ids: [3, 4] },
    ],
  )
  assert.equal(listGroupLabel('today'), '本日開催')
  assert.equal(listGroupLabel('upcoming'), 'これから開催')
  assert.equal(listGroupLabel('other'), null)
})

test('groupListedEvents does not drop a single status list', () => {
  const groups = groupListedEvents([{ id: 8 }], () => 'today')
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].events.map((event) => event.id), [8])
})
