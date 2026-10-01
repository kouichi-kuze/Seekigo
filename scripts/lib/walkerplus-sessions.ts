/**
 * Walkerplus 一覧の「・」区切り開催日。
 * 連続日は1期間のまま。間が空くときだけ event_occurrences にする。
 * 親の開始・終了は、基準日以降の最初の1回。全期間にはしない。
 */

export type WalkerplusOccurrencePlan = {
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
}

export type WalkerplusSchedulePlan = {
  start_date: string
  end_date: string
  occurrences: WalkerplusOccurrencePlan[]
}

function ymd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

/** 「・」で分かれた日だけを返す。範囲（〜）や1日だけは null。 */
export function parseWalkerplusDiscreteDates(period: string | null | undefined): string[] | null {
  if (!period) return null
  const text = period.replace(/\s+/g, '')
  if (!text.includes('・') || /[〜～]/.test(text)) return null

  let year: number | null = null
  let month: number | null = null
  let previousDay: number | null = null
  const dates: string[] = []

  for (const part of text.split('・')) {
    const full = part.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (full) {
      year = Number(full[1])
      month = Number(full[2])
      previousDay = Number(full[3])
      dates.push(ymd(year, month, previousDay))
      continue
    }
    const monthDay = part.match(/(\d{1,2})月(\d{1,2})日/)
    if (monthDay && year != null) {
      month = Number(monthDay[1])
      previousDay = Number(monthDay[2])
      dates.push(ymd(year, month, previousDay))
      continue
    }
    const dayOnly = part.match(/(\d{1,2})日/)
    if (dayOnly && year != null && month != null) {
      let day = Number(dayOnly[1])
      if (previousDay != null && day < previousDay) {
        month += 1
        if (month > 12) {
          month = 1
          year += 1
        }
      }
      previousDay = day
      dates.push(ymd(year, month, day))
      continue
    }
    return null
  }

  const unique = [...new Set(dates)].sort()
  return unique.length >= 2 ? unique : null
}

function hasGap(dates: string[]): boolean {
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] > addDays(dates[i - 1], 1)) return true
  }
  return false
}

export function planWalkerplusSchedule(input: {
  listPeriod?: string | null
  startDate: string
  endDate: string | null
  startTime?: string | null
  endTime?: string | null
  today: string
}): WalkerplusSchedulePlan {
  const fallbackEnd = input.endDate && input.endDate >= input.startDate ? input.endDate : input.startDate
  const discrete = parseWalkerplusDiscreteDates(input.listPeriod)
  if (!discrete || !hasGap(discrete)) {
    const span = discrete ?? [input.startDate, fallbackEnd].sort()
    return {
      start_date: span[0],
      end_date: span[span.length - 1],
      occurrences: [],
    }
  }

  const occurrences = discrete.map((day) => ({
    start_date: day,
    end_date: day,
    start_time: input.startTime ?? null,
    end_time: input.endTime ?? null,
  }))
  const next = occurrences.find((item) => item.end_date >= input.today) ?? occurrences[occurrences.length - 1]
  return {
    start_date: next.start_date,
    end_date: next.end_date,
    occurrences,
  }
}
