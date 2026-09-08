/**
 * Phase 4B-1: reaction web collector shared types.
 */

export const REACTION_WEB_SOURCE_TYPES = [
  'official_web',
  'rss',
  'news',
  'blog',
  'press_release',
  'other_web',
  // legacy / SNS placeholders kept for typing compatibility
  'web',
  'other',
  'x',
  'instagram',
] as const

export type ReactionWebSourceType = (typeof REACTION_WEB_SOURCE_TYPES)[number]

export type RelevanceLevel = 'exact' | 'likely' | 'weak' | 'irrelevant'

export type CandidateKind =
  | 'official_url'
  | 'event_source'
  | 'extra_url'
  | 'rss'
  | 'press'
  | 'blog_news'

export type UrlCandidate = {
  url: string
  kind: CandidateKind
  hintedType?: ReactionWebSourceType
}

export type EventContext = {
  id: number
  title: string
  venue: string | null
  official_url: string | null
  source_url: string | null
  start_date: string | null
  end_date: string | null
  area: string | null
}

export type ParsedPage = {
  finalUrl: string
  contentKind: 'html' | 'rss' | 'atom'
  title: string | null
  description: string | null
  siteName: string | null
  publishedAt: string | null
  canonicalUrl: string | null
  /** internal review only; already truncated */
  excerpt: string
  /** RSS: one row per matched item */
  items?: Array<{
    title: string | null
    link: string | null
    publishedAt: string | null
    excerpt: string
  }>
}

export type CollectDecision =
  | 'save'
  | 'skip_irrelevant'
  | 'skip_duplicate'
  | 'skip_fetch'
  | 'skip_robots'
  | 'skip_unsafe_url'
  | 'skip_parse'
  | 'skip_max_write'

export type CollectPlanRow = {
  candidateUrl: string
  finalUrl: string | null
  normalizedUrl: string | null
  sourceType: ReactionWebSourceType | null
  sourceName: string | null
  relevance: RelevanceLevel | null
  excerptChars: number
  decision: CollectDecision
  reason: string
  observedAt: string | null
  excerptForReview: string | null
}
