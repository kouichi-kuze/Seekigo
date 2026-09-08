/**
 * Rule-based relevance for X posts (no AI).
 */
import { normalizeTitleForExact, normalizeVenue } from '../../../src/lib/event-dedupe'
import type { RelevanceLevel, XEventContext, XPost } from './types'

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}#]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

function titleOverlap(eventTitle: string, text: string): number {
  const exactA = normalizeTitleForExact(eventTitle)
  const exactB = normalizeTitleForExact(text)
  if (exactA && exactB && (exactB.includes(exactA) || exactA.includes(exactB))) {
    return 1
  }
  // Also check raw case-insensitive includes for Latin titles
  const raw = eventTitle.trim()
  if (raw.length >= 4 && text.toLowerCase().includes(raw.toLowerCase())) {
    return 0.95
  }
  const a = new Set(tokenize(eventTitle).filter((t) => !/^\d{4}$/.test(t)))
  const b = tokenize(text)
  if (!a.size || !b.length) return 0
  let hit = 0
  for (const t of b) if (a.has(t)) hit++
  return hit / a.size
}

function venueInText(venue: string | null, text: string): boolean {
  const v = normalizeVenue(venue)
  if (!v || v.length < 2) return false
  return normalizeVenue(text).includes(v) || text.includes(venue!.trim())
}

function urlMentionsEvent(event: XEventContext, urls: string[]): boolean {
  const targets = [event.official_url, event.source_url].filter(Boolean) as string[]
  if (!targets.length || !urls.length) return false
  for (const u of urls) {
    for (const t of targets) {
      try {
        const a = new URL(u)
        const b = new URL(t)
        if (a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '')) {
          if (a.pathname.length > 1 && b.pathname.length > 1) {
            if (a.pathname.includes(b.pathname.slice(0, 24)) || b.pathname.includes(a.pathname.slice(0, 24))) {
              return true
            }
          }
          // same host alone is weak signal — count as partial via caller
          return true
        }
      } catch {
        /* ignore */
      }
    }
  }
  return false
}

function dateProximity(event: XEventContext, createdAt: string | null): boolean {
  if (!createdAt) return true // Recent Search already limited to 7d
  if (!event.start_date) return true
  const created = Date.parse(createdAt)
  const start = Date.parse(event.start_date)
  if (Number.isNaN(created) || Number.isNaN(start)) return true
  const end = event.end_date ? Date.parse(event.end_date) : start
  const endMs = Number.isNaN(end) ? start : end
  // within 14d before start .. 7d after end (capped by API 7d lookback anyway)
  return created >= start - 14 * 864e5 && created <= endMs + 7 * 864e5
}

export function scoreXPostRelevance(
  event: XEventContext,
  post: XPost,
): { level: RelevanceLevel; score: number; reasons: string[] } {
  const text = post.text || ''
  const reasons: string[] = []
  let score = 0

  const overlap = titleOverlap(event.title, text)
  score += overlap * 0.6
  if (overlap >= 0.99) reasons.push('title_exact')
  else if (overlap >= 0.4) reasons.push(`title_overlap:${overlap.toFixed(2)}`)

  if (venueInText(event.venue, text)) {
    score += 0.25
    reasons.push('venue')
  }
  if (event.area && text.includes(event.area)) {
    score += 0.1
    reasons.push('area')
  }
  if (urlMentionsEvent(event, post.urls)) {
    score += 0.35
    reasons.push('url_mention')
  }
  if (dateProximity(event, post.created_at)) {
    score += 0.05
    reasons.push('date_ok')
  }

  let level: RelevanceLevel
  if (reasons.includes('title_exact') || score >= 0.75) level = 'exact'
  else if (score >= 0.35 || (overlap >= 0.35 && reasons.length >= 2)) level = 'likely'
  else if (score >= 0.15 || overlap >= 0.2) level = 'weak'
  else level = 'irrelevant'

  return { level, score, reasons }
}

export function isSaveableRelevance(level: RelevanceLevel): boolean {
  return level === 'exact' || level === 'likely'
}
