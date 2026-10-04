import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WALKERPLUS_BATCH1_SOURCE_IDS } from './data/walkerplus-batch1-ids'
import {
  WALKERPLUS_BATCH2_LIST_PERIODS,
  WALKERPLUS_BATCH2_SOURCE_IDS,
} from './data/walkerplus-batch2-ids'
import { WALKERPLUS_BATCH3_SOURCE_IDS } from './data/walkerplus-batch3-ids'
import {
  parseWalkerplusDiscreteDates,
  planWalkerplusSchedule,
} from './lib/walkerplus-sessions'

test('batch 1 is frozen at the confirmed 87 ids', () => {
  assert.equal(WALKERPLUS_BATCH1_SOURCE_IDS.length, 87)
  assert.equal(new Set(WALKERPLUS_BATCH1_SOURCE_IDS).size, 87)
  assert.equal(
    WALKERPLUS_BATCH1_SOURCE_IDS.every((id) => /^ar\d+e\d+$/.test(id)),
    true,
  )
})

test('batch 2 is frozen at 70 ids and separated from batch 1', () => {
  assert.equal(WALKERPLUS_BATCH2_SOURCE_IDS.length, 70)
  assert.equal(new Set(WALKERPLUS_BATCH2_SOURCE_IDS).size, 70)
  assert.equal(
    WALKERPLUS_BATCH2_SOURCE_IDS.every((id) => /^ar\d+e\d+$/.test(id)),
    true,
  )
  assert.equal(
    WALKERPLUS_BATCH2_SOURCE_IDS.some((id) =>
      (WALKERPLUS_BATCH1_SOURCE_IDS as readonly string[]).includes(id),
    ),
    false,
  )
  assert.equal(
    WALKERPLUS_BATCH2_SOURCE_IDS.every((id) =>
      Boolean(WALKERPLUS_BATCH2_LIST_PERIODS[id]),
    ),
    true,
  )
})

test('batch 3 is frozen separately from batch 1 and batch 2', () => {
  assert.equal(WALKERPLUS_BATCH3_SOURCE_IDS.length, 71)
  assert.equal(new Set(WALKERPLUS_BATCH3_SOURCE_IDS).size, 71)
  assert.equal(
    WALKERPLUS_BATCH3_SOURCE_IDS.every((id) => /^ar\d+e\d+$/.test(id)),
    true,
  )
  const earlier = new Set<string>([
    ...WALKERPLUS_BATCH1_SOURCE_IDS,
    ...WALKERPLUS_BATCH2_SOURCE_IDS,
  ])
  assert.equal(
    WALKERPLUS_BATCH3_SOURCE_IDS.some((id) => earlier.has(id)),
    false,
  )
})

test('adjacent listed days stay one span', () => {
  const dates = parseWalkerplusDiscreteDates('2026年10月3日(土)・4日(日)')
  assert.deepEqual(dates, ['2026-10-03', '2026-10-04'])
  const plan = planWalkerplusSchedule({
    listPeriod: '2026年10月3日(土)・4日(日)',
    startDate: '2026-10-03',
    endDate: '2026-10-04',
    today: '2026-09-30',
  })
  assert.equal(plan.occurrences.length, 0)
  assert.equal(plan.start_date, '2026-10-03')
  assert.equal(plan.end_date, '2026-10-04')
})

test('a skipped day becomes occurrences and the parent is only the next day', () => {
  const plan = planWalkerplusSchedule({
    listPeriod: '2026年10月10日(土)・12日(月)',
    startDate: '2026-10-10',
    endDate: '2026-10-12',
    startTime: '10:00',
    endTime: '16:00',
    today: '2026-09-30',
  })
  assert.deepEqual(
    plan.occurrences.map((item) => item.start_date),
    ['2026-10-10', '2026-10-12'],
  )
  assert.equal(plan.start_date, '2026-10-10')
  assert.equal(plan.end_date, '2026-10-10')
  assert.equal(plan.occurrences[0].start_time, '10:00')
})

test('a continuous range is not split', () => {
  assert.equal(parseWalkerplusDiscreteDates('2026年10月30日(金)～11月8日(日)'), null)
})
