import { supabase } from './supabase'

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
  address?: string | null
  price_text: string | null
  summary: string | null
  is_free: boolean | null
  is_kids: boolean | null
  is_indoor: boolean | null
  is_night: boolean | null
  category?: string[] | null
  official_url: string | null
  status?: string
  [key: string]: unknown
}

/** 一覧ページ向けの追加フィルタ（必要に応じて拡張する） */
export type EventFilters = {
  isFree?: boolean
  isKids?: boolean
  isIndoor?: boolean
  isNight?: boolean
  area?: string
}

function tokyoToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

/**
 * 公開中イベントを取得する。
 * 共通条件: status = published, start_date 昇順
 */
export async function getPublishedEvents(
  filters: EventFilters = {},
): Promise<Event[]> {
  let query = supabase
    .from('events')
    .select('*')
    .eq('status', 'published')
    .order('start_date', { ascending: true })

  if (filters.isFree === true) {
    query = query.eq('is_free', true)
  }

  if (filters.isKids === true) {
    query = query.eq('is_kids', true)
  }

  if (filters.isIndoor === true) {
    query = query.eq('is_indoor', true)
  }

  if (filters.isNight === true) {
    query = query.eq('is_night', true)
  }

  if (filters.area) {
    query = query.eq('area', filters.area)
  }

  const { data, error } = await query

  if (error) {
    console.error(error)
    return []
  }

  return (data ?? []) as Event[]
}

/** 無料イベント */
export function getFreeEvents(): Promise<Event[]> {
  return getPublishedEvents({ isFree: true })
}

/** 子ども向けイベント */
export function getKidsEvents(): Promise<Event[]> {
  return getPublishedEvents({ isKids: true })
}

/** エリア別イベント（例: shinjuku / shibuya） */
export function getAreaEvents(area: string): Promise<Event[]> {
  return getPublishedEvents({ area })
}

/**
 * 今日開催中のイベント（Asia/Tokyo）
 * - end_date が null → start_date = 今日のみ
 * - end_date あり → start_date <= 今日 かつ end_date >= 今日
 */
export async function getTodayEvents(): Promise<{
  today: string
  events: Event[]
}> {
  const today = tokyoToday()

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'published')
    .or(
      `and(end_date.is.null,start_date.eq.${today}),and(start_date.lte.${today},end_date.gte.${today})`,
    )
    .order('start_date', { ascending: true })

  if (error) {
    console.error(error)
    return { today, events: [] }
  }

  return { today, events: (data ?? []) as Event[] }
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
 * 今週末（土・日）に開催されるイベント（Asia/Tokyo）
 * - 土日のどちらか1日でも開催期間に含まれるもの
 * - end_date が null → start_date が土曜または日曜
 * - end_date あり → start_date <= 日曜 かつ end_date >= 土曜
 */
export async function getThisWeekendEvents(): Promise<{
  saturday: string
  sunday: string
  events: Event[]
}> {
  const { saturday, sunday } = tokyoThisWeekend()

  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('status', 'published')
    .or(
      [
        `and(end_date.is.null,start_date.eq.${saturday})`,
        `and(end_date.is.null,start_date.eq.${sunday})`,
        `and(start_date.lte.${sunday},end_date.gte.${saturday})`,
      ].join(','),
    )
    .order('start_date', { ascending: true })

  if (error) {
    console.error(error)
    return { saturday, sunday, events: [] }
  }

  return { saturday, sunday, events: (data ?? []) as Event[] }
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
