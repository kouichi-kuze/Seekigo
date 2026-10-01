/**
 * Walkerplus Phase 0 — 日付・ID パース（調査用のみ）
 */

/** 環境変数未指定時の取得件数。sync-all もこの件数。 */
export const WALKERPLUS_DEFAULT_MAX_ITEMS = 50
/** WALKERPLUS_MAX_ITEMS で指定できる上限。 */
export const WALKERPLUS_HARD_MAX_ITEMS = 100
/** 一覧1ページあたりの件数。ページ数の見積もりにだけ使う。 */
export const WALKERPLUS_LIST_PAGE_SIZE = 10
/** 100件までのときに、1ページの抽出が少なくても件数上限まで進めるページ数。 */
export const WALKERPLUS_HARD_MAX_LIST_PAGES = 15

/** 以前の定数名。既定件数（ハード上限ではない）。 */
export const WALKERPLUS_PHASE_MAX_ITEMS = WALKERPLUS_DEFAULT_MAX_ITEMS

export function resolveWalkerplusMaxItems(raw?: string | null): number {
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return WALKERPLUS_DEFAULT_MAX_ITEMS
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n) || n < 1) return WALKERPLUS_DEFAULT_MAX_ITEMS
  return Math.min(Math.floor(n), WALKERPLUS_HARD_MAX_ITEMS)
}

export function resolveWalkerplusMaxListPages(
  maxItems: number,
  raw?: string | null,
): number {
  const pagesToFill = Math.max(
    1,
    Math.ceil(maxItems / WALKERPLUS_LIST_PAGE_SIZE),
  )
  const slack = maxItems > WALKERPLUS_DEFAULT_MAX_ITEMS ? 5 : 0
  const auto = Math.min(pagesToFill + slack, WALKERPLUS_HARD_MAX_LIST_PAGES)
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return auto
  const n = Number.parseInt(trimmed, 10)
  if (!Number.isFinite(n) || n < 1) return auto
  return Math.min(Math.floor(n), WALKERPLUS_HARD_MAX_LIST_PAGES)
}

export type WalkerplusListEvent = {
  source_name: 'walkerplus'
  source_event_id: string | null
  title: string
  detail_url: string
  date_text: string | null
  start_date: string | null
  end_date: string | null
  venue: string | null
  area_text: string | null
  summary: string | null
  categories: string[]
  image_url: string | null
  fetched_at: string
}

export function cleanText(value: string | undefined | null): string | null {
  if (!value) return null
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > 0 ? text : null
}

export function toAbsoluteUrl(
  href: string | undefined | null,
  baseUrl: string,
): string | null {
  const trimmed = href?.trim()
  if (!trimmed || trimmed.startsWith('javascript:') || trimmed === '#') {
    return null
  }
  try {
    return new URL(trimmed, baseUrl).href
  } catch {
    return null
  }
}

/** /event/ar0313e593530/ → ar0313e593530 */
export function extractWalkerplusEventId(detailUrl: string): string | null {
  const m = detailUrl.match(/\/event\/(ar\d+e\d+)\/?/i)
  return m ? m[1].toLowerCase() : null
}

/** YYYY-MM-DD（年省略は null） */
export function parseYmdToken(token: string | null | undefined): string | null {
  if (!token) return null
  const cleaned = token.trim().replace(/\([^)]*\)/g, '').replace(/\s+/g, '')

  const iso = cleaned.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  }

  const jp = cleaned.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
  if (jp) {
    return `${jp[1]}-${jp[2].padStart(2, '0')}-${jp[3].padStart(2, '0')}`
  }

  return null
}

/**
 * Walkerplus 日本語日付。
 * 年省略の終了日は推測せず end_date=null。
 */
export function parseWalkerplusDateText(raw: string | null | undefined): {
  date_text: string | null
  start_date: string | null
  end_date: string | null
} {
  if (!raw) {
    return { date_text: null, start_date: null, end_date: null }
  }

  let text = raw.replace(/\s+/g, ' ').trim()
  text = text.replace(/^(開催中|終了間近|終了間際)\s*/u, '').trim()
  const date_text = text || null

  const fullRange = text.match(
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?\s*[〜～\-－—~]\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?/,
  )
  if (fullRange) {
    return {
      date_text,
      start_date: parseYmdToken(fullRange[1]),
      end_date: parseYmdToken(fullRange[2]),
    }
  }

  const startEndShort = text.match(
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?\s*[〜～\-－—~]\s*(\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?/,
  )
  if (startEndShort) {
    return {
      date_text,
      start_date: parseYmdToken(startEndShort[1]),
      end_date: null,
    }
  }

  const openEnd = text.match(
    /^(?:開催中\s*)?[〜～\-－—~]\s*(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?/,
  )
  if (openEnd) {
    const day = parseYmdToken(openEnd[1])
    return { date_text, start_date: null, end_date: day }
  }

  const fromOnly = text.match(
    /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?\s*から/,
  )
  if (fromOnly) {
    const day = parseYmdToken(fromOnly[1])
    return { date_text, start_date: day, end_date: null }
  }

  const single = text.match(/(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)(?:\([^)]*\))?/)
  if (single) {
    const day = parseYmdToken(single[1])
    return { date_text, start_date: day, end_date: day }
  }

  return { date_text, start_date: null, end_date: null }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function randomGapMs(minMs: number, maxMs: number): number {
  return minMs + Math.floor(Math.random() * (maxMs - minMs + 1))
}
