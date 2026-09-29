/**
 * 表示用ヘルパー（DB値は変更しない）。
 * 一覧・詳細で共通利用。
 */
import { AREA_LABELS } from './event-field-rules'

export { AREA_LABELS }

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const

/**
 * area slug を日本語表示に変換。
 * 未知の値は無理に変換せずそのまま返す。
 */
export function formatAreaLabel(area: string | null | undefined): string | null {
  if (!area) return null
  const key = area.trim().toLowerCase()
  if (!key) return null
  return AREA_LABELS[key] ?? area.trim()
}

/** AREA_LABELS に無い、既存の自治体スラッグ。機械翻訳ではなくスラッグの表示名。 */
const MUNICIPALITY_PLACE_LABELS: Record<string, string> = {
  bunkyo: '文京区',
  chiyoda: '千代田区',
  fuchu: '府中市',
  kita: '北区',
  kodaira: '小平市',
  koganei: '小金井市',
  koto: '江東区',
  musashino: '武蔵野市',
  nerima: '練馬区',
  ota: '大田区',
  setagaya: '世田谷区',
  shinagawa: '品川区',
  suginami: '杉並区',
  tachikawa: '立川市',
  toshima: '豊島区',
  kichijoji: '吉祥寺',
}

function placePartLabel(
  value: string | null | undefined,
  omitRawSlug = false,
): string | null {
  if (!value?.trim()) return null
  const raw = value.trim()
  const key = raw.toLowerCase()
  const known = AREA_LABELS[key] ?? MUNICIPALITY_PLACE_LABELS[key]
  if (known) return known
  if (omitRawSlug && /^[a-z0-9-]+$/i.test(raw)) return null
  return raw
}

/**
 * 区と街を一つにまとめる。同じ表示名は重ねない。
 * 英訳辞書はないので、英語ページでもこの日本語名をそのまま使う。
 */
export function formatEventPlaceLine(
  municipality: string | null | undefined,
  area: string | null | undefined,
  options?: { omitRawSlug?: boolean },
): string | null {
  const omitRawSlug = options?.omitRawSlug === true
  const ward = placePartLabel(municipality, omitRawSlug)
  const neighborhood = placePartLabel(area, omitRawSlug)
  if (ward && neighborhood) {
    if (ward === neighborhood) return ward
    return `${ward}・${neighborhood}`
  }
  return ward ?? neighborhood
}

function parseYmd(ymd: string): {
  year: number
  month: number
  day: number
  weekday: string
} | null {
  const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  // 曜日は UTC 正午相当で安定計算
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return {
    year,
    month,
    day,
    weekday: WEEKDAYS_JA[date.getUTCDay()],
  }
}

function formatJaDay(
  parts: { year: number; month: number; day: number; weekday: string },
  includeYear: boolean,
): string {
  if (includeYear) {
    return `${parts.year}年${parts.month}月${parts.day}日（${parts.weekday}）`
  }
  return `${parts.month}月${parts.day}日（${parts.weekday}）`
}

/**
 * 開催日の日本語表示。
 * 単日: 2026年8月29日（土）
 * 期間（同年）: 2026年7月17日（金）〜8月30日（日）
 * 年またぎ: 終了側にも年を付与
 */
export function formatEventDateRange(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  options?: { omitStartYear?: boolean },
): string | null {
  if (!startDate) return null
  const showStartYear = !options?.omitStartYear

  const start = parseYmd(startDate)
  if (!start) {
    if (endDate && endDate !== startDate) return `${startDate} 〜 ${endDate}`
    return startDate
  }

  if (!endDate || endDate === startDate) {
    return formatJaDay(start, showStartYear)
  }

  const end = parseYmd(endDate)
  if (!end) {
    return `${formatJaDay(start, showStartYear)} 〜 ${endDate}`
  }

  const sameYear = start.year === end.year
  return `${formatJaDay(start, showStartYear)}〜${formatJaDay(end, !sameYear)}`
}

/** Asia/Tokyo の今日（YYYY-MM-DD） */
export function tokyoTodayYmd(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

/**
 * 開催終了判定（Asia/Tokyo）。
 * - end_date あり: end_date < 今日
 * - end_date なし: start_date < 今日（単日扱い）
 * - start_date / end_date が null・空・解析不能の場合は false（誤判定しない）
 */
export function isEventEnded(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  today: string = tokyoTodayYmd(),
): boolean {
  if (!startDate?.trim()) return false
  if (!parseYmd(today)) return false

  const endRaw = endDate?.trim()
  if (endRaw) {
    if (!parseYmd(endRaw)) return false
    return endRaw < today
  }

  const startRaw = startDate.trim()
  if (!parseYmd(startRaw)) return false
  return startRaw < today
}
