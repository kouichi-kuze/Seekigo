/**
 * 詳細ページの開催日・開催状態。
 * occurrences があるときは親の start/end を毎日開催とみなさない。
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatEventDateRange, tokyoTodayYmd } from './display'
import { EVENT_UI_EN, formatEventDateRangeEn, formatOccurrenceTimeEn } from './i18n/event-en'
import type { SiteLocale } from './i18n/locale'

export type OccurrenceDateRow = {
  start_date: string | null
  end_date: string | null
  start_time?: string | null
  end_time?: string | null
}

export type DateSpan = { start: string; end: string }

export type ScheduleStatus = 'today' | 'upcoming' | 'ended'

const MAX_VISIBLE_SPANS = 8

function parseYmd(ymd: string): boolean {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function addDaysYmd(ymd: string, days: number): string | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const date = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days),
  )
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 重なる日・隣り合う日は一つの期間にまとめる。 */
export function mergeOccurrenceSpans(rows: OccurrenceDateRow[]): DateSpan[] {
  const intervals: DateSpan[] = []
  for (const row of rows) {
    const start = row.start_date?.trim() ?? ''
    if (!parseYmd(start)) continue
    const endRaw = row.end_date?.trim() || start
    const end = parseYmd(endRaw) && endRaw >= start ? endRaw : start
    intervals.push({ start, end })
  }
  intervals.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))

  const merged: DateSpan[] = []
  for (const span of intervals) {
    const last = merged[merged.length - 1]
    const nextDay = last ? addDaysYmd(last.end, 1) : null
    if (last && nextDay && span.start <= nextDay) {
      if (span.end > last.end) last.end = span.end
      continue
    }
    merged.push({ start: span.start, end: span.end })
  }
  return merged
}

function spanCovers(span: DateSpan, day: string): boolean {
  return span.start <= day && day <= span.end
}

/** 解決済みの開催期間に、その日が含まれるか。間の日は含まない。 */
export function scheduleIncludesDate(spans: DateSpan[], day: string): boolean {
  if (!parseYmd(day)) return false
  return spans.some((span) => spanCovers(span, day))
}

/** 解決済みの開催期間が、指定日のどれかと重なるか。 */
export function scheduleIncludesAnyDate(spans: DateSpan[], days: string[]): boolean {
  return days.some((day) => scheduleIncludesDate(spans, day))
}

function daysBetweenYmd(earlier: string, later: string): number {
  const [ay, am, ad] = earlier.split('-').map(Number)
  const [by, bm, bd] = later.split('-').map(Number)
  const left = Date.UTC(ay, am - 1, ad)
  const right = Date.UTC(by, bm - 1, bd)
  return Math.round((right - left) / 86400000)
}

/**
 * 開催期間同士の最短日数。重なっていれば 0。
 * 期間の長さでは比べない。日付が無いときは null。
 */
export function nearestScheduleDays(
  source: DateSpan[],
  target: DateSpan[],
): number | null {
  if (source.length === 0 || target.length === 0) return null
  let best = Number.POSITIVE_INFINITY
  for (const left of source) {
    for (const right of target) {
      let gap = 0
      if (left.end < right.start) gap = daysBetweenYmd(left.end, right.start)
      else if (right.end < left.start) gap = daysBetweenYmd(right.end, left.start)
      if (gap < best) best = gap
    }
  }
  return Number.isFinite(best) ? best : null
}

function parentSpan(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
): DateSpan | null {
  const start = startDate?.trim() ?? ''
  if (!parseYmd(start)) return null
  const endRaw = endDate?.trim() || start
  const end = parseYmd(endRaw) && endRaw >= start ? endRaw : start
  return { start, end }
}

/** 開催回があればその期間。無ければ親の日付を1期間にする。 */
export function resolveDisplaySpans(
  occurrenceSpans: DateSpan[],
  parent: { start_date?: string | null; end_date?: string | null },
): DateSpan[] {
  if (occurrenceSpans.length > 0) return occurrenceSpans
  const one = parentSpan(parent.start_date, parent.end_date)
  return one ? [one] : []
}

/**
 * occurrences が1件以上あればそれを正にする。
 * 無いか読めないときは親の start_date / end_date。
 * 日付が判断できないときは null（チップを出さない）。
 */
export function resolveScheduleStatus(
  occurrenceSpans: DateSpan[],
  parent: { start_date?: string | null; end_date?: string | null },
  today: string = tokyoTodayYmd(),
): ScheduleStatus | null {
  if (!parseYmd(today)) return null
  const spans = resolveDisplaySpans(occurrenceSpans, parent)
  if (spans.length === 0) return null
  if (spans.some((span) => spanCovers(span, today))) return 'today'
  if (spans.some((span) => span.end >= today)) return 'upcoming'
  return 'ended'
}

function formatSpan(
  span: DateSpan,
  locale: SiteLocale,
  omitStartYear: boolean,
): string {
  if (locale === 'en') {
    return formatEventDateRangeEn(span.start, span.end) ?? span.start
  }
  return (
    formatEventDateRange(span.start, span.end, { omitStartYear }) ?? span.start
  )
}

export function formatScheduleDates(
  occurrenceSpans: DateSpan[],
  parent: { start_date?: string | null; end_date?: string | null },
  locale: SiteLocale,
): string | null {
  const spans = resolveDisplaySpans(occurrenceSpans, parent)
  if (spans.length === 0) return null

  const visible = spans.slice(0, MAX_VISIBLE_SPANS)
  const hidden = spans.length - visible.length
  const firstYear = visible[0]?.start.slice(0, 4)
  const parts = visible.map((span, index) => {
    const omitStartYear =
      locale === 'ja' && index > 0 && span.start.slice(0, 4) === firstYear
    return formatSpan(span, locale, omitStartYear)
  })
  const joiner = locale === 'en' ? ', ' : '、'
  const text = parts.join(joiner)
  if (hidden <= 0) return text
  return locale === 'en' ? `${text} (+${hidden} more)` : `${text} ほか${hidden}開催`
}

type OccurrenceSession = {
  start: string
  end: string
  startTime: string | null
  endTime: string | null
}

function sessionsFromRows(rows: OccurrenceDateRow[]): OccurrenceSession[] {
  const sessions: OccurrenceSession[] = []
  for (const row of rows) {
    const start = row.start_date?.trim() ?? ''
    if (!parseYmd(start)) continue
    const endRaw = row.end_date?.trim() || start
    const end = parseYmd(endRaw) && endRaw >= start ? endRaw : start
    sessions.push({
      start,
      end,
      startTime: normalizeClock(row.start_time),
      endTime: normalizeClock(row.end_time),
    })
  }
  sessions.sort(
    (left, right) =>
      left.start.localeCompare(right.start) ||
      left.end.localeCompare(right.end) ||
      (left.startTime ?? '99:99').localeCompare(right.startTime ?? '99:99'),
  )
  return sessions
}

function sessionTimeLabel(session: OccurrenceSession, locale: SiteLocale): string | null {
  if (locale === 'en') {
    return formatOccurrenceTimeEn(session.startTime, session.endTime)
  }
  if (session.startTime && session.endTime) {
    return `${session.startTime}〜${session.endTime}`
  }
  if (session.startTime) return `${session.startTime}〜`
  if (session.endTime) return `〜${session.endTime}`
  return null
}

/** 開催回のどれかに時刻があるときだけ、日付と時刻をまとめた表示。無ければ null。 */
export function formatTimedOccurrenceSchedule(
  rows: OccurrenceDateRow[],
  locale: SiteLocale,
): string | null {
  const sessions = sessionsFromRows(rows)
  if (!sessions.some((session) => session.startTime || session.endTime)) return null

  const groups: OccurrenceSession[][] = []
  for (const session of sessions) {
    const last = groups[groups.length - 1]
    const head = last?.[0]
    const sameDay =
      head &&
      head.start === head.end &&
      session.start === session.end &&
      head.start === session.start
    if (last && sameDay) last.push(session)
    else groups.push([session])
  }

  const visible = groups.slice(0, MAX_VISIBLE_SPANS)
  const hidden = groups.length - visible.length
  const firstYear = visible[0]?.[0]?.start.slice(0, 4)
  const parts = visible.map((group, index) => {
    const head = group[0]
    const omitStartYear =
      locale === 'ja' && index > 0 && head.start.slice(0, 4) === firstYear
    const date = formatSpan(head, locale, omitStartYear)
    const times = group
      .map((session) => sessionTimeLabel(session, locale))
      .filter((time): time is string => Boolean(time))
    if (times.length === 0) return date
    return `${date} ${times.join(locale === 'en' ? ', ' : '、')}`
  })
  const text = parts.join(locale === 'en' ? ', ' : '、')
  if (hidden <= 0) return text
  return locale === 'en' ? `${text} (+${hidden} more)` : `${text} ほか${hidden}開催`
}

/**
 * 親の時刻を詳細の時刻行に出してよいか。
 * 開催回が複数日に分かれているとき、親の1組の時刻を全日程へは使わない。
 */
export function useParentTimeFallback(
  rows: OccurrenceDateRow[] | null | undefined,
): boolean {
  if (!rows || rows.length === 0) return true
  if (rows.some((row) => normalizeClock(row.start_time) || normalizeClock(row.end_time))) {
    return false
  }
  return sessionsFromRows(rows).length <= 1
}

const CARD_VISIBLE_SPANS = 2

/** カード用。詳細と同じ期間表示で、年は省き、3件目以降は「ほか」。 */
export function formatCardScheduleDates(
  occurrenceSpans: DateSpan[],
  parent: { start_date?: string | null; end_date?: string | null },
  locale: SiteLocale,
): string | null {
  const spans = resolveDisplaySpans(occurrenceSpans, parent)
  if (spans.length === 0) return null
  const visible = spans.slice(0, CARD_VISIBLE_SPANS)
  const hidden = spans.length - visible.length
  const parts = visible.map((span) => formatSpan(span, locale, locale === 'ja'))
  const text = parts.join(locale === 'en' ? ', ' : '、')
  if (hidden <= 0) return text
  return locale === 'en' ? `${text}, more` : `${text}ほか`
}

/** 今日以降で、次に実際に開催される日。期間中なら今日。 */
export function nextAttendableDate(spans: DateSpan[], today: string): string | null {
  if (!parseYmd(today)) return null
  let best: string | null = null
  for (const span of spans) {
    if (span.end < today) continue
    const candidate = span.start > today ? span.start : today
    if (!best || candidate < best) best = candidate
  }
  return best
}

function normalizeClock(raw: string | null | undefined): string | null {
  const match = raw?.trim().match(/^(\d{1,2}):(\d{2})/)
  if (!match) return null
  const hour = Number(match[1])
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${match[2]}`
}

function rowCoversDay(row: OccurrenceDateRow, day: string): boolean {
  const start = row.start_date?.trim() ?? ''
  if (!parseYmd(start)) return false
  const endRaw = row.end_date?.trim() || start
  const end = parseYmd(endRaw) && endRaw >= start ? endRaw : start
  return start <= day && day <= end
}

/**
 * その日の開始時刻。開催回がある日は開催回だけを見る。
 * 親の時刻は、開催回が無いときだけ使う。
 */
export function startClockOnDate(
  rows: OccurrenceDateRow[] | undefined,
  parentStartTime: string | null | undefined,
  spans: DateSpan[],
  day: string,
): string | null {
  if (!parseYmd(day)) return null
  if (rows && rows.length > 0) {
    const clocks = rows
      .filter((row) => rowCoversDay(row, day))
      .map((row) => normalizeClock(row.start_time))
      .filter((clock): clock is string => Boolean(clock))
      .sort()
    return clocks[0] ?? null
  }
  if (!scheduleIncludesDate(spans, day)) return null
  return normalizeClock(parentStartTime)
}

export function formatEventTimeRangeJa(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): string | null {
  const clock = (raw: string): string | null => {
    const match = raw.trim().match(/^(\d{1,2}):(\d{2})/)
    if (!match) return raw.trim() || null
    const hour = Number(match[1])
    if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
    return `${String(hour).padStart(2, '0')}:${match[2]}`
  }
  const start = startTime?.trim() ? clock(startTime) : null
  const end = endTime?.trim() ? clock(endTime) : null
  if (!start && !end) return null
  if (start && end) return `${start}〜${end}`
  return start ?? end
}

export type DetailChip = { id: string; label: string }

export function buildEventDetailChips(input: {
  locale: SiteLocale
  status: ScheduleStatus | null
  priceType?: string | null
  isKids?: boolean | null
  isIndoor?: boolean | null
  isNight?: boolean | null
}): DetailChip[] {
  const ja = input.locale !== 'en'
  const chips: DetailChip[] = []
  if (input.status === 'today') {
    chips.push({
      id: 'status',
      label: ja ? '本日開催' : EVENT_UI_EN.happeningToday,
    })
  } else if (input.status === 'upcoming') {
    chips.push({
      id: 'status',
      label: ja ? '開催予定' : EVENT_UI_EN.upcoming,
    })
  } else if (input.status === 'ended') {
    chips.push({
      id: 'status',
      label: ja ? '開催終了' : EVENT_UI_EN.ended,
    })
  }
  const priceChip =
    input.priceType === 'free'
      ? ja
        ? '無料'
        : EVENT_UI_EN.free
      : input.priceType === 'partially_paid'
        ? ja
          ? '一部有料'
          : EVENT_UI_EN.partiallyPaid
        : input.priceType === 'paid'
          ? ja
            ? '有料'
            : EVENT_UI_EN.paid
          : input.priceType === 'varies'
            ? ja
              ? '内容による'
              : EVENT_UI_EN.varies
            : null
  if (priceChip) {
    chips.push({ id: 'price', label: priceChip })
  }
  if (input.isKids === true) {
    chips.push({ id: 'kids', label: ja ? '子ども向け' : EVENT_UI_EN.forKids })
  }
  if (input.isIndoor === true) {
    chips.push({ id: 'indoor', label: ja ? '屋内' : EVENT_UI_EN.indoor })
  }
  if (input.isNight === true) {
    chips.push({ id: 'night', label: ja ? '夜' : EVENT_UI_EN.night })
  }
  return chips
}

type OccurrenceIndex = Map<number, OccurrenceDateRow[]>

const occurrenceIndexCache = new WeakMap<
  SupabaseClient,
  Promise<OccurrenceIndex | null>
>()

function isMissingOccurrenceAccess(message: string): boolean {
  return /permission denied|row-level security|does not exist|Could not find the table|schema cache/i.test(
    message,
  )
}

/**
 * 公開中イベントに紐づく開催回を、ビルド中に1回だけ読む。
 * 権限がないときは null。行が無い event_id は Map に入らない。
 */
export function loadOccurrenceIndex(
  client: SupabaseClient,
): Promise<OccurrenceIndex | null> {
  const cached = occurrenceIndexCache.get(client)
  if (cached) return cached
  const pending = fetchOccurrenceIndex(client)
  occurrenceIndexCache.set(client, pending)
  return pending
}

async function fetchOccurrenceIndex(
  client: SupabaseClient,
): Promise<OccurrenceIndex | null> {
  const index: OccurrenceIndex = new Map()
  const pageSize = 1000
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client
      .from('event_occurrences')
      .select('event_id, start_date, end_date, start_time, end_time')
      .order('event_id', { ascending: true })
      .order('start_date', { ascending: true })
      .range(from, from + pageSize - 1)
    if (error) {
      if (!isMissingOccurrenceAccess(error.message ?? '')) {
        console.error('[event-occurrences]', error.message)
      }
      return null
    }
    for (const row of data ?? []) {
      const eventId = Number(row.event_id)
      if (!Number.isFinite(eventId)) continue
      const list = index.get(eventId) ?? []
      list.push({
        start_date: row.start_date,
        end_date: row.end_date,
        start_time: row.start_time,
        end_time: row.end_time,
      })
      index.set(eventId, list)
    }
    if ((data ?? []).length < pageSize) break
  }
  return index
}

/** 読めない・権限がないときは null。行が無ければ空配列。 */
export async function fetchEventOccurrences(
  client: SupabaseClient,
  eventId: number,
): Promise<OccurrenceDateRow[] | null> {
  const index = await loadOccurrenceIndex(client)
  if (!index) return null
  return index.get(eventId) ?? []
}

/** 開催回があればその期間。無ければ親の日付。 */
export function displaySpansForEvent(
  index: OccurrenceIndex | null,
  event: { id?: number | string | null; start_date?: string | null; end_date?: string | null },
): DateSpan[] {
  const eventId = Number(event.id)
  const rows =
    index && Number.isFinite(eventId) ? (index.get(eventId) ?? []) : []
  const merged = rows.length > 0 ? mergeOccurrenceSpans(rows) : []
  return resolveDisplaySpans(merged, event)
}
