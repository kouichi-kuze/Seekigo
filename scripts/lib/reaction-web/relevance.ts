/**
 * Rule-based event relevance for reaction sources (no AI).
 */
import { normalizeTitleForExact, normalizeVenue } from '../../../src/lib/event-dedupe'
import { sameRegistrableHint } from './normalize'
import type { EventContext, ParsedPage, RelevanceLevel } from './types'

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

function titleOverlapScore(eventTitle: string, pageText: string): number {
  const exactA = normalizeTitleForExact(eventTitle)
  const exactB = normalizeTitleForExact(pageText)
  if (exactA && exactB && (exactB.includes(exactA) || exactA.includes(exactB))) {
    return 1
  }
  const a = new Set(tokenize(eventTitle))
  const b = tokenize(pageText)
  if (!a.size || !b.length) return 0
  let hit = 0
  for (const t of b) if (a.has(t)) hit++
  return hit / a.size
}

function venueMatch(eventVenue: string | null, pageText: string): boolean {
  const v = normalizeVenue(eventVenue)
  if (!v || v.length < 2) return false
  const page = normalizeVenue(pageText)
  return Boolean(page && (page.includes(v) || v.includes(page)))
}

function dateProximity(event: EventContext, publishedAt: string | null): boolean {
  if (!publishedAt || !event.start_date) return false
  const pub = Date.parse(publishedAt)
  const start = Date.parse(event.start_date)
  if (Number.isNaN(pub) || Number.isNaN(start)) return false
  const end = event.end_date ? Date.parse(event.end_date) : start
  const endMs = Number.isNaN(end) ? start : end
  // within 180 days before start through 30 days after end
  const windowStart = start - 180 * 24 * 3600 * 1000
  const windowEnd = endMs + 30 * 24 * 3600 * 1000
  return pub >= windowStart && pub <= windowEnd
}

export function scoreRelevance(
  event: EventContext,
  page: Pick<ParsedPage, 'title' | 'description' | 'excerpt' | 'publishedAt' | 'finalUrl' | 'canonicalUrl'>,
  itemTitle?: string | null,
): { level: RelevanceLevel; score: number; reasons: string[] } {
  const blob = [page.title, itemTitle, page.description, page.excerpt]
    .filter(Boolean)
    .join(' ')
  const reasons: string[] = []
  let score = 0

  const urlForDomain = page.canonicalUrl || page.finalUrl
  if (sameRegistrableHint(event.official_url, urlForDomain)) {
    score += 0.55
    reasons.push('official_domain')
  }
  if (sameRegistrableHint(event.source_url, urlForDomain)) {
    score += 0.35
    reasons.push('event_source_domain')
  }

  const overlap = titleOverlapScore(event.title, blob)
  score += overlap * 0.5
  if (overlap >= 0.99) reasons.push('title_exactish')
  else if (overlap >= 0.4) reasons.push(`title_overlap:${overlap.toFixed(2)}`)

  if (venueMatch(event.venue, blob)) {
    score += 0.2
    reasons.push('venue')
  }
  if (dateProximity(event, page.publishedAt)) {
    score += 0.1
    reasons.push('date_window')
  }

  let level: RelevanceLevel
  if (
    reasons.includes('official_domain') ||
    reasons.includes('title_exactish') ||
    score >= 0.75
  ) {
    level = 'exact'
  } else if (score >= 0.35 || (overlap >= 0.35 && reasons.length > 0)) {
    level = 'likely'
  } else if (score >= 0.15 || overlap >= 0.2) {
    level = 'weak'
  } else {
    level = 'irrelevant'
  }

  return { level, score, reasons }
}

export function isSaveableRelevance(level: RelevanceLevel): boolean {
  return level === 'exact' || level === 'likely'
}
