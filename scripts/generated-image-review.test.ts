import assert from 'node:assert/strict'
import { test } from 'node:test'
import { approveDisplayedGeneratedImages } from '../src/lib/admin-generated-image'
import { classifyDisplayedApprovals } from '../src/lib/generated-image-review'
import { adminFailureRedirect } from '../src/lib/admin-vite-publish'
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

type FakeRow = {
  id: number
  status: string
  generated_image_status: string
  generated_image_url: string | null
  failUpdate?: boolean
}

function createFake(seed: FakeRow[]) {
  const rows = seed.map((row) => ({ ...row }))
  const updates: Array<{ id: number; patch: Record<string, unknown> }> = []

  function from() {
    const filters: Array<[string, unknown]> = []
    let op: 'select' | 'update' = 'select'
    let patch: Record<string, unknown> | null = null

    const run = (single: boolean) => {
      const match = (row: FakeRow) => filters.every(([key, value]) => row[key] === value)
      if (op === 'update' && patch) {
        const found = rows.filter(match)
        const saved = []
        for (const row of found) {
          if (row.failUpdate) continue
          updates.push({ id: row.id, patch })
          Object.assign(row, patch)
          saved.push({ id: row.id })
        }
        return { data: saved, error: null }
      }
      const found = rows.filter(match)
      return { data: single ? (found[0] ?? null) : found, error: null }
    }

    const builder = {
      select() {
        if (op === 'update') return Promise.resolve(run(false))
        return builder
      },
      eq(key: string, value: unknown) {
        filters.push([key, value])
        return builder
      },
      maybeSingle() {
        return Promise.resolve(run(true))
      },
      update(value: Record<string, unknown>) {
        op = 'update'
        patch = value
        return builder
      },
    }
    return builder
  }

  return { rows, updates, from }
}

test('displayed approval updates every posted pending id, not only the first', async () => {
  const fake = createFake([
    { id: 229, status: 'draft', generated_image_status: 'pending', generated_image_url: '/images/event-generated/229.webp' },
    { id: 230, status: 'draft', generated_image_status: 'pending', generated_image_url: '/images/event-generated/230.webp' },
    { id: 231, status: 'draft', generated_image_status: 'pending', generated_image_url: '/images/event-generated/231.webp', failUpdate: true },
    { id: 304, status: 'draft', generated_image_status: 'pending', generated_image_url: '/images/event-generated/304.webp' },
    { id: 307, status: 'draft', generated_image_status: 'blocked', generated_image_url: null },
    { id: 999, status: 'draft', generated_image_status: 'pending', generated_image_url: '/images/event-generated/999.webp' },
  ])

  const result = await approveDisplayedGeneratedImages(fake as never, [229, 230, 231, 304, 307])

  assert.deepEqual(result.approvedIds, [229, 230, 304])
  assert.deepEqual(result.failedIds, [231, 307])
  assert.deepEqual(fake.updates.map((item) => item.id), [229, 230, 304])
  for (const item of fake.updates) {
    assert.deepEqual(Object.keys(item.patch).sort(), ['generated_image_status', 'updated_at'])
    assert.equal(item.patch.generated_image_status, 'approved')
    assert.equal('status' in item.patch, false)
  }
  assert.equal(fake.rows.find((row) => row.id === 999)?.generated_image_status, 'pending')
  assert.equal(fake.rows.find((row) => row.id === 307)?.generated_image_status, 'blocked')
  assert.equal(fake.rows.find((row) => row.id === 229)?.status, 'draft')
  assert.equal(fake.rows.find((row) => row.id === 304)?.status, 'draft')
})

test('bulk approve failure returns to the image review list', () => {
  const redirect = adminFailureRedirect(
    new URLSearchParams({
      intent: 'generated_image_approve_displayed',
      event_id: '229',
    }),
    'failed',
  )
  assert.equal(redirect.startsWith('/admin/events/reviews/image/?error='), true)
  assert.equal(redirect.includes('/admin/events/229/'), false)
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
