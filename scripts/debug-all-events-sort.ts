import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { fetchAdminEventList } from '../src/lib/admin/queries'
import { classifyAdminEventTiming, getAdminEventSortKey } from '../src/lib/admin/event-sort'
import { isEventEnded, tokyoTodayYmd } from '../src/lib/display'

config()

const url = process.env.PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(1)
}

const admin = createClient(url, key, { auth: { persistSession: false } })
const today = tokyoTodayYmd()
console.log('today:', today)

const events = await fetchAdminEventList(admin, { kind: 'all' })
console.log('total:', events.length)

const top20 = events.slice(0, 20).map((ev, i) => ({
  index: i,
  id: ev.id,
  title: (ev.title ?? '').slice(0, 40),
  start: ev.start_date,
  end: ev.end_date,
  group: classifyAdminEventTiming(ev, today),
  sortKey: getAdminEventSortKey(ev, today),
  isEnded: isEventEnded(ev.start_date, ev.end_date, today),
}))

console.log('\nTOP 20:')
console.table(top20)

const endedInTop10 = events
  .slice(0, 10)
  .filter((e) => classifyAdminEventTiming(e, today) === 'ended')
console.log('\nended in top 10:', endedInTop10.length, endedInTop10.map((e) => e.id))

const badDates = events.filter((e) => {
  const s = e.start_date?.trim() ?? ''
  return s && !/^\d{4}-\d{2}-\d{2}$/.test(s)
})
console.log('\nnon-YMD start_date count:', badDates.length)
if (badDates.length) {
  console.table(
    badDates.slice(0, 10).map((e) => ({ id: e.id, start: e.start_date, end: e.end_date })),
  )
}

const looksEnded = events.slice(0, 15).filter((e) => {
  const s = e.start_date?.trim() ?? ''
  return s && s < today && !isEventEnded(e.start_date, e.end_date, today)
})
console.log('\ntop15 with past start but NOT ended (ongoing long-run):')
console.table(
  looksEnded.map((e) => ({
    id: e.id,
    start: e.start_date,
    end: e.end_date,
    group: classifyAdminEventTiming(e, today),
  })),
)

const firstEndedIdx = events.findIndex((e) => classifyAdminEventTiming(e, today) === 'ended')
if (firstEndedIdx >= 0) {
  const ev = events[firstEndedIdx]!
  console.log('\nfirst ended at index', firstEndedIdx, {
    id: ev.id,
    title: ev.title,
    start: ev.start_date,
    end: ev.end_date,
    isEnded: isEventEnded(ev.start_date, ev.end_date, today),
  })
}

// published + end_date null but start past → isEventEnded true but dashboard ended count misses
const endedNoEndDate = events.filter(
  (e) =>
    isEventEnded(e.start_date, e.end_date, today) &&
    !(e.end_date?.trim() && e.end_date.trim() < today),
)
console.log('\nended via start-only (no end_date):', endedNoEndDate.map((e) => e.id))

console.log('\nALL ENDED (bottom section):')
console.table(
  events
    .filter((e) => classifyAdminEventTiming(e, today) === 'ended')
    .map((e) => ({
      id: e.id,
      status: e.status,
      start: e.start_date,
      end: e.end_date,
    })),
)
