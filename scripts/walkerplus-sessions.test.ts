import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WALKERPLUS_BATCH1_SOURCE_IDS } from './data/walkerplus-batch1-ids'
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
