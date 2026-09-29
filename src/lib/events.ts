import { supabase } from './supabase'
import type { EventVisitAttrs } from './event-visit-attrs'
import { tokyoTodayYmd } from './display'
import {
  displaySpansForEvent,
  loadOccurrenceIndex,
  nextAttendableDate,
  resolveScheduleStatus,
  scheduleIncludesAnyDate,
  scheduleIncludesDate,
  startClockOnDate,
  type DateSpan,
  type OccurrenceDateRow,
} from './event-schedule'

/** events テーブルの一覧・詳細表示用フィールド */
export type Event = {
  id?: string
  title: string
  slug?: string | null
  start_date: string | null
  end_date: string | null
  start_time?: string | null
  end_time?: string | null
  venue: string | null
  area: string | null
  municipality?: string | null
  address?: string | null
  price_text: string | null
  summary: string | null
  /** 料金区分。未設定は null。公開の無料判定はここを使う。 */
  price_type?: 'free' | 'partially_paid' | 'paid' | 'varies' | null
  is_kids: boolean | null
  is_indoor: boolean | null
  is_night: boolean | null
  category?: string[] | null
  official_url: string | null
  status?: string
  /** 一覧判定用。開催回があればその期間、無ければ親の日付。 */
  schedule_spans?: DateSpan[]
  /** 開催回の行。無いイベントは未設定で、時刻は親を使う。 */
  occurrence_rows?: OccurrenceDateRow[]
  [key: string]: unknown
} & EventVisitAttrs

/** 一覧ページ向けの追加フィルタ（必要に応じて拡張する） */
export type EventFilters = {
  isFree?: boolean
  isKids?: boolean
  isIndoor?: boolean
  isNight?: boolean
  area?: string
}

function tokyoToday(): string {
  return tokyoTodayYmd()
}

async function withScheduleSpans(events: Event[]): Promise<Event[]> {
  const index = await loadOccurrenceIndex(supabase)
  return events.map((event) => {
    const eventId = Number(event.id)
    const rows =
      index && Number.isFinite(eventId) ? index.get(eventId) : undefined
    return {
      ...event,
      schedule_spans: displaySpansForEvent(index, event),
      occurrence_rows: rows && rows.length > 0 ? rows : undefined,
    }
  })
}

function eventNumericId(event: Event): number {
  const id = Number(event.id)
  return Number.isFinite(id) ? id : 0
}

function clockRank(clock: string | null): string {
  return clock ?? '99:99'
}

/** 本日開催を先に、その中は次の開催日・開始時刻・id。 */
function compareExploreEvents(today: string, left: Event, right: Event): number {
  const leftStatus = resolveScheduleStatus(left.schedule_spans ?? [], {
    start_date: null,
    end_date: null,
  }, today)
  const rightStatus = resolveScheduleStatus(right.schedule_spans ?? [], {
    start_date: null,
    end_date: null,
  }, today)
  const rank = (status: string | null) =>
    status === 'today' ? 0 : status === 'upcoming' ? 1 : 2
  const byStatus = rank(leftStatus) - rank(rightStatus)
  if (byStatus !== 0) return byStatus

  const leftDate = nextAttendableDate(left.schedule_spans ?? [], today) ?? '9999-99-99'
  const rightDate = nextAttendableDate(right.schedule_spans ?? [], today) ?? '9999-99-99'
  if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1

  const leftClock = startClockOnDate(
    left.occurrence_rows,
    left.start_time,
    left.schedule_spans ?? [],
    leftDate,
  )
  const rightClock = startClockOnDate(
    right.occurrence_rows,
    right.start_time,
    right.schedule_spans ?? [],
    rightDate,
  )
  const byClock = clockRank(leftClock).localeCompare(clockRank(rightClock))
  if (byClock !== 0) return byClock
  return eventNumericId(left) - eventNumericId(right)
}

function compareByClockThenId(day: string, left: Event, right: Event): number {
  const leftClock = startClockOnDate(
    left.occurrence_rows,
    left.start_time,
    left.schedule_spans ?? [],
    day,
  )
  const rightClock = startClockOnDate(
    right.occurrence_rows,
    right.start_time,
    right.schedule_spans ?? [],
    day,
  )
  const byClock = clockRank(leftClock).localeCompare(clockRank(rightClock))
  if (byClock !== 0) return byClock
  return eventNumericId(left) - eventNumericId(right)
}

/** 終了以外。日付不明は除外しない。 */
function isCurrentOrUpcoming(event: Event): boolean {
  return (
    resolveScheduleStatus(event.schedule_spans ?? [], {
      start_date: null,
      end_date: null,
    }) !== 'ended'
  )
}

let scheduledPublishedPromise: Promise<Event[]> | null = null

/** 公開イベントと開催回を、ビルド中に1回だけ読む。 */
export function loadScheduledPublishedEvents(): Promise<Event[]> {
  if (!scheduledPublishedPromise) {
    scheduledPublishedPromise = fetchScheduledPublishedEvents()
  }
  return scheduledPublishedPromise
}

async function fetchScheduledPublishedEvents(): Promise<Event[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'published')
    .order('start_date', { ascending: true })
  if (error) {
    console.error(error)
    return []
  }
  return withScheduleSpans((data ?? []) as Event[])
}

/**
 * 公開中かつ終了していないイベント。
 * 開催回があればそれを正にする。今日・今週末以外の探索一覧はここを使う。
 */
export async function getPublishedEvents(
  filters: EventFilters = {},
): Promise<Event[]> {
  const today = tokyoToday()
  const scheduled = await loadScheduledPublishedEvents()
  return scheduled
    .filter((event) => {
      if (!isCurrentOrUpcoming(event)) return false
      if (
        filters.isFree === true &&
        event.price_type !== 'free' &&
        event.price_type !== 'partially_paid'
      ) {
        return false
      }
      if (filters.isKids === true && event.is_kids !== true) return false
      if (filters.isIndoor === true && event.is_indoor !== true) return false
      if (filters.isNight === true && event.is_night !== true) return false
      if (filters.area && event.area !== filters.area) return false
      return true
    })
    .sort((left, right) => compareExploreEvents(today, left, right))
}

/** 無料イベント */
export function getFreeEvents(): Promise<Event[]> {
  return getPublishedEvents({ isFree: true })
}

/** 子ども向けイベント */
export function getKidsEvents(): Promise<Event[]> {
  return getPublishedEvents({ isKids: true })
}

function isPlaceSlug(value: string): boolean {
  return /^[a-z0-9-]+$/.test(value)
}

/**
 * 自治体ページ用。区市町村スラッグで公開イベントを返す。
 * municipality 未設定の既存行だけ、area が同じ自治体スラッグのとき含める。
 * municipality が別の自治体なら、古い area だけでは入れない。
 */
export async function getMunicipalityEvents(
  municipality: string,
): Promise<Event[]> {
  const slug = municipality.trim().toLowerCase()
  if (!isPlaceSlug(slug)) return []

  const today = tokyoToday()
  const scheduled = await loadScheduledPublishedEvents()
  return scheduled
    .filter((event) => {
      const municipality = event.municipality?.trim().toLowerCase() ?? ''
      const area = event.area?.trim().toLowerCase() ?? ''
      const inPlace = municipality === slug || (!municipality && area === slug)
      return inPlace && isCurrentOrUpcoming(event)
    })
    .sort((left, right) => compareExploreEvents(today, left, right))
}

/** 街ページ用。area が六本木・原宿などの街スラッグの公開イベント。 */
export function getAreaEvents(area: string): Promise<Event[]> {
  return getPublishedEvents({ area })
}

/**
 * 今日、実際の開催日に含まれるイベント（Asia/Tokyo）。
 * 開催回のあいだの日は含めない。
 */
export async function getTodayEvents(): Promise<{
  today: string
  events: Event[]
}> {
  const today = tokyoToday()

  const scheduled = await loadScheduledPublishedEvents()
  return {
    today,
    events: scheduled
      .filter((event) => scheduleIncludesDate(event.schedule_spans ?? [], today))
      .sort((left, right) => compareByClockThenId(today, left, right)),
  }
}

function tokyoThisWeekend(): { saturday: string; sunday: string } {
  const today = tokyoToday()
  const [year, month, day] = today.split('-').map(Number)
  // カレンダー日付としての曜日を安定して取るため UTC 正午で扱う
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  const weekday = base.getUTCDay() // 0=日 … 6=土

  const daysToSaturday =
    weekday === 0 ? -1 : weekday === 6 ? 0 : 6 - weekday

  const saturdayDate = new Date(base)
  saturdayDate.setUTCDate(base.getUTCDate() + daysToSaturday)

  const sundayDate = new Date(saturdayDate)
  sundayDate.setUTCDate(saturdayDate.getUTCDate() + 1)

  const toYmd = (date: Date) => date.toISOString().slice(0, 10)

  return {
    saturday: toYmd(saturdayDate),
    sunday: toYmd(sundayDate),
  }
}

/**
 * 今週末（土・日）の実際の開催日と重なるイベント（Asia/Tokyo）。
 * 親の開始日〜終了日が土日をまたぐだけでは含めない。
 */
export async function getThisWeekendEvents(): Promise<{
  saturday: string
  sunday: string
  events: Event[]
}> {
  const { saturday, sunday } = tokyoThisWeekend()

  const scheduled = await loadScheduledPublishedEvents()
  return {
    saturday,
    sunday,
    events: scheduled
      .filter((event) =>
        scheduleIncludesAnyDate(event.schedule_spans ?? [], [saturday, sunday]),
      )
      .sort((left, right) => {
        const firstDay = (event: Event) =>
          scheduleIncludesDate(event.schedule_spans ?? [], saturday)
            ? saturday
            : sunday
        const leftDay = firstDay(left)
        const rightDay = firstDay(right)
        if (leftDay !== rightDay) return leftDay < rightDay ? -1 : 1
        return compareByClockThenId(leftDay, left, right)
      }),
  }
}

/**
 * slug で公開中イベントを1件取得する。
 * 見つからない場合は null。
 */
export async function getEventBySlug(slug: string): Promise<Event | null> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'published')
    .eq('slug', slug)
    .maybeSingle()

  if (error) {
    console.error(error)
    return null
  }

  return (data as Event | null) ?? null
}
