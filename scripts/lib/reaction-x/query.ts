/**
 * Build Recent Search query for an event (official operators only).
 * Uses: phrase match, OR, -is:retweet, simple keyword exclusions.
 * Do not invent operators.
 */
import type { XEventContext } from './types'

/** Recent Search query max length (common access tier). */
const MAX_QUERY_LEN = 512

function cleanPhrase(raw: string): string {
  return raw.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
}

function quotePhrase(raw: string): string | null {
  const p = cleanPhrase(raw)
  if (p.length < 2) return null
  // Prefer shorter unique titles for search quality
  const clipped = p.length > 80 ? p.slice(0, 80).trim() : p
  return `"${clipped}"`
}

/** Drop retweets + light noise keywords (literal exclusions). */
const NOISE_EXCLUSIONS = ['-is:retweet', '-求人', '-募集', '-割引コード'].join(' ')

export function shortenTitle(title: string): string | null {
  const t = cleanPhrase(title)
  if (!t) return null
  // Drop year / trailing edition markers for alternate phrase
  const short = t
    .replace(/\b20\d{2}\b/g, '')
    .replace(/第?\d+回/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!short || short === t || short.length < 3) return null
  return short
}

export function buildXSearchQuery(
  event: XEventContext,
  override?: string | null,
): { query: string; parts: string[] } {
  if (override?.trim()) {
    return { query: override.trim().slice(0, MAX_QUERY_LEN), parts: ['override'] }
  }

  const phrases: string[] = []
  const titleQ = quotePhrase(event.title)
  if (titleQ) phrases.push(titleQ)

  const short = shortenTitle(event.title)
  if (short) {
    const sq = quotePhrase(short)
    if (sq && sq !== titleQ) phrases.push(sq)
  }

  // Venue/area: only short, simple tokens (avoid long address-like venue strings)
  const boosters: string[] = []
  for (const raw of [event.area, event.venue]) {
    const v = cleanPhrase(raw ?? '')
    if (!v) continue
    // Prefer compact tokens (e.g. お台場 / 渋谷)
    const parts = v.split(/[・･/／|,，、\s]+/).map((p) => p.trim()).filter(Boolean)
    for (const p of parts) {
      if (p.length >= 2 && p.length <= 12 && !/\d{2,}/.test(p)) {
        boosters.push(p)
      }
    }
  }
  const booster = [...new Set(boosters)].slice(0, 1)[0]
  if (titleQ && booster) {
    const combo = quotePhrase(`${cleanPhrase(event.title)} ${booster}`)
    if (combo) phrases.push(combo)
  }

  const unique = [...new Set(phrases)].slice(0, 3)
  const core = unique.length === 1 ? unique[0] : `(${unique.join(' OR ')})`
  let query = `${core} ${NOISE_EXCLUSIONS}`.replace(/\s+/g, ' ').trim()

  if (query.length > MAX_QUERY_LEN) {
    // Fall back to title-only
    query = `${titleQ ?? unique[0] ?? '"event"'} ${NOISE_EXCLUSIONS}`
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_QUERY_LEN)
  }

  return { query, parts: unique }
}

/**
 * start_time for Recent Search: never older than ~7 days.
 * Tighten toward event window when it falls inside the 7-day lookback.
 */
export function buildSearchStartTime(event: XEventContext, now = new Date()): string {
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000 - 60_000 // 1 min margin
  const earliest = new Date(now.getTime() - sevenDaysMs)

  let start = earliest
  if (event.start_date) {
    const eventStart = Date.parse(`${event.start_date}T00:00:00Z`)
    if (!Number.isNaN(eventStart)) {
      // If event started within the last 7 days, start slightly before event start
      const candidate = new Date(eventStart - 24 * 60 * 60 * 1000)
      if (candidate > earliest) start = candidate
    }
  }

  if (start >= now) {
    start = earliest
  }

  return start.toISOString().replace(/\.\d{3}Z$/, 'Z')
}
