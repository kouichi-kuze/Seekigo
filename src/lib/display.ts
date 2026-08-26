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
): string | null {
  if (!startDate) return null

  const start = parseYmd(startDate)
  if (!start) {
    if (endDate && endDate !== startDate) return `${startDate} 〜 ${endDate}`
    return startDate
  }

  if (!endDate || endDate === startDate) {
    return formatJaDay(start, true)
  }

  const end = parseYmd(endDate)
  if (!end) {
    return `${formatJaDay(start, true)} 〜 ${endDate}`
  }

  const sameYear = start.year === end.year
  return `${formatJaDay(start, true)}〜${formatJaDay(end, !sameYear)}`
}
