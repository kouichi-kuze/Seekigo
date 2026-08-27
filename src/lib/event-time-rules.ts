/**
 * イベント開催時間の deterministic パーサ。
 * - ソースに明示された時刻のみ採用（AI推測禁止）
 * - 曖昧・複数時間帯は null
 * - 保存形式は日本現地時刻の HH:MM:SS（UTC変換なし）
 */

export type EventTimeParseAction = 'parsed' | 'keep_null' | 'not_found'

export type EventTimeParseResult = {
  start_time: string | null
  end_time: string | null
  action: EventTimeParseAction
  reason: string | null
  raw: string | null
  ranges_found: number
}

const RANGE_SEP = '[〜～\\-~－—–]'

/** DB time 型向け HH:MM:SS */
export function toDbTime(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`
}

/** "HH:MM" / "HH:MM:SS" / "H:MM" → HH:MM:SS */
export function normalizeHmToDb(value: string | null | undefined): string | null {
  if (!value) return null
  const m = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  const second = m[3] != null ? Number(m[3]) : 0
  if (second < 0 || second > 59) return null
  return toDbTime(hour, minute)
}

/**
 * ISO-8601 datetime から日本現地の時刻を抽出。
 * 日付のみ（T なし）は null。
 */
export function extractTimeFromIsoDateTime(
  iso: string | null | undefined,
): string | null {
  if (!iso) return null
  const trimmed = iso.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null
  if (!trimmed.includes('T')) return null

  const m = trimmed.match(
    /T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i,
  )
  if (!m) return null
  return toDbTime(Number(m[1]), Number(m[2]))
}

function parseColonClock(token: string): string | null {
  return normalizeHmToDb(token)
}

/** 日本語時計表記: 午前10時 / 午後6時30分 / 10時00分 / 10時 */
function parseJapaneseClock(token: string): string | null {
  const t = token.replace(/\s+/g, '')
  const m = t.match(/^(午前|午後)?(\d{1,2})時(?:(\d{1,2})分)?$/)
  if (!m) return null
  let hour = Number(m[2])
  const minute = m[3] != null ? Number(m[3]) : 0
  const ampm = m[1]
  if (ampm === '午前') {
    if (hour === 12) hour = 0
  } else if (ampm === '午後') {
    if (hour < 12) hour += 12
  }
  return toDbTime(hour, minute)
}

function parseClockToken(token: string): string | null {
  const cleaned = token.trim()
  return parseColonClock(cleaned) ?? parseJapaneseClock(cleaned)
}

const CLOCK_TOKEN =
  '(?:午前|午後)?\\d{1,2}:\\d{2}(?::\\d{2})?|(?:午前|午後)?\\d{1,2}時(?:\\d{1,2}分)?'

function isLikelyNonTimeContext(before: string, after: string): boolean {
  const ctx = `${before.slice(-12)}${after.slice(0, 12)}`
  if (/\d{4}[/-年]/.test(before.slice(-8) + after.slice(0, 4))) return true
  if (/月\s*$/.test(before) && /日/.test(after)) return true
  if (/第\s*\d+\s*$/.test(before) && /部|話|章/.test(after)) return true
  if (/歳|才|円|¥|税/.test(ctx)) return true
  if (/料金|入場料|大人|小人|高校|中学|小学/.test(ctx)) return true
  return false
}

/** テキスト内の時計トークンを位置付きで列挙（誤認除外） */
export function findClockTokens(
  text: string,
): Array<{ value: string; index: number; raw: string }> {
  const re = new RegExp(CLOCK_TOKEN, 'g')
  const out: Array<{ value: string; index: number; raw: string }> = []
  for (const m of text.matchAll(re)) {
    const raw = m[0]
    const index = m.index ?? 0
    const before = text.slice(Math.max(0, index - 16), index)
    const after = text.slice(index + raw.length, index + raw.length + 16)
    if (isLikelyNonTimeContext(before, after)) continue
    const parsed = parseClockToken(raw)
    if (!parsed) continue
    out.push({ value: parsed, index, raw })
  }
  return out
}

type TimeRange = { start: string; end: string | null }

function findRanges(text: string): TimeRange[] {
  const ranges: TimeRange[] = []
  const re = new RegExp(
    `(${CLOCK_TOKEN})\\s*${RANGE_SEP}\\s*(${CLOCK_TOKEN})`,
    'g',
  )
  for (const m of text.matchAll(re)) {
    const start = parseClockToken(m[1])
    const end = parseClockToken(m[2])
    if (start && end) ranges.push({ start, end })
  }
  return ranges
}

function findLabeledStartEnd(text: string): TimeRange | null {
  const startLabel = text.match(
    new RegExp(
      `(?:開始|開演|開場|スタート)\\s*(?:時間)?\\s*[:：]?\\s*(${CLOCK_TOKEN})`,
    ),
  )
  const endLabel = text.match(
    new RegExp(
      `(?:終了|閉演|閉場|エンド)\\s*(?:時間)?\\s*[:：]?\\s*(${CLOCK_TOKEN})`,
    ),
  )

  const start = startLabel ? parseClockToken(startLabel[1]) : null
  const end = endLabel ? parseClockToken(endLabel[1]) : null

  if (start && end) return { start, end }
  if (start && !end) return { start, end: null }
  return null
}

function hasMultipleScheduleMarkers(text: string): boolean {
  const parts = /第\s*\d+\s*部|午前の部|午後の部|夜の部|昼の部/
  const clocks = findClockTokens(text)
  if (clocks.length < 2) return false

  const weekdayHits = text.match(
    /(?:平日|土日祝?|土日|祝日|休日)[^\n]{0,20}?(?:\d{1,2}:\d{2}|(?:午前|午後)?\d{1,2}時)/g,
  )
  if (weekdayHits && weekdayHits.length >= 2) return true

  if (parts.test(text) && findRanges(text).length >= 2) return true

  if (/各種|日によって|曜日によって|イベントによって異なります/.test(text)) {
    return true
  }

  return false
}

function emptyResult(
  raw: string | null,
  action: EventTimeParseAction,
  reason: string | null,
  ranges_found = 0,
): EventTimeParseResult {
  return {
    start_time: null,
    end_time: null,
    action,
    reason,
    raw,
    ranges_found,
  }
}

/**
 * 開催時間テキストを start_time / end_time に変換。
 * 複数時間帯・例外日・曖昧表記は keep_null。
 */
export function parseEventTimeText(
  raw: string | null | undefined,
): EventTimeParseResult {
  if (raw == null) return emptyResult(null, 'not_found', 'empty')
  const original = raw.replace(/\u00a0/g, ' ').trim()
  if (!original) return emptyResult(null, 'not_found', 'empty')

  const main = original.split('※')[0].replace(/\s+/g, ' ').trim()
  if (!main) return emptyResult(original, 'not_found', 'empty_after_note_strip')

  if (/各種イベントによって異なります|詳細は公式|未定|要確認/.test(main)) {
    return emptyResult(original, 'keep_null', 'non_specific_schedule')
  }

  if (hasMultipleScheduleMarkers(main)) {
    return emptyResult(original, 'keep_null', 'multiple_time_ranges')
  }

  const ranges = findRanges(main)
  const uniqueRangeKeys = [
    ...new Set(ranges.map((r) => `${r.start}-${r.end}`)),
  ]

  if (uniqueRangeKeys.length > 1) {
    return emptyResult(
      original,
      'keep_null',
      'multiple_time_ranges',
      uniqueRangeKeys.length,
    )
  }

  const labeled = findLabeledStartEnd(main)
  const clocks = findClockTokens(main)

  if (/(最終日|を除く|ただし)/.test(main) && clocks.length >= 3) {
    return emptyResult(
      original,
      'keep_null',
      'exception_day_schedule',
      clocks.length,
    )
  }

  if (uniqueRangeKeys.length === 1) {
    const [start, end] = uniqueRangeKeys[0].split('-')
    const extras = clocks.filter((c) => c.value !== start && c.value !== end)
    if (extras.length > 0 && /(最終日|を除く|ただし|平日|土日)/.test(main)) {
      return emptyResult(
        original,
        'keep_null',
        'multiple_time_ranges',
        ranges.length,
      )
    }
    return {
      start_time: start,
      end_time: end,
      action: 'parsed',
      reason: 'single_time_range',
      raw: original,
      ranges_found: 1,
    }
  }

  if (labeled) {
    const extras = clocks.filter((c) => {
      if (c.value === labeled.start) return false
      if (labeled.end && c.value === labeled.end) return false
      return true
    })
    if (extras.length > 0) {
      return emptyResult(
        original,
        'keep_null',
        'multiple_time_ranges',
        extras.length + 1,
      )
    }
    return {
      start_time: labeled.start,
      end_time: labeled.end,
      action: 'parsed',
      reason: labeled.end ? 'labeled_start_end' : 'labeled_start_only',
      raw: original,
      ranges_found: labeled.end ? 1 : 0,
    }
  }

  if (clocks.length === 1 && /開始|開演|開場|スタート/.test(main)) {
    return {
      start_time: clocks[0].value,
      end_time: null,
      action: 'parsed',
      reason: 'single_start_only',
      raw: original,
      ranges_found: 0,
    }
  }

  if (clocks.length === 1) {
    return emptyResult(original, 'keep_null', 'single_time_unlabeled')
  }

  if (clocks.length === 0) {
    return emptyResult(original, 'not_found', 'no_clock_token')
  }

  return emptyResult(original, 'keep_null', 'ambiguous_time_text', clocks.length)
}

/** ページ本文から「開催時間」等のラベル付き行を拾う */
export function extractLabeledTimeRawFromText(pageText: string): string | null {
  const text = pageText.replace(/\u00a0/g, ' ')
  const re =
    /((?:開催時間|開館時間|営業時間|開催時刻|開始時間|開演時間|開場時間)\s*[:：]?\s*[^\n]{0,80})/g
  const hits = [...text.matchAll(re)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  )
  if (hits.length === 0) return null
  return hits.join(' / ')
}

export function logEventTimeParse(opts: {
  title?: string | null
  result: EventTimeParseResult
  source?: string | null
}): void {
  const { title, result, source } = opts
  console.log('[time]')
  if (title) console.log(`title: ${title}`)
  if (source) console.log(`source: ${source}`)
  console.log(`raw: ${result.raw ?? 'null'}`)
  if (result.action === 'parsed') {
    console.log(`start_time: ${result.start_time}`)
    console.log(`end_time: ${result.end_time ?? 'null'}`)
  } else {
    console.log(`action: ${result.action}`)
    console.log(`reason: ${result.reason ?? 'null'}`)
  }
}
