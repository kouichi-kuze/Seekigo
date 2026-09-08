/** Phase 4B-2: X reaction collector types */

import type { XPostClass } from './classify'

export type RelevanceLevel = 'exact' | 'likely' | 'weak' | 'irrelevant'

export type XEventContext = {
  id: number
  title: string
  venue: string | null
  official_url: string | null
  source_url: string | null
  start_date: string | null
  end_date: string | null
  area: string | null
}

export type XPost = {
  id: string
  text: string
  created_at: string | null
  lang: string | null
  author_id: string | null
  username: string | null
  urls: string[]
}

export type XCollectDecision =
  | 'save'
  | 'skip_irrelevant'
  | 'skip_duplicate'
  | 'skip_quota'
  | 'skip_cap'
  | 'skip_max_write'

export type XCollectPlanRow = {
  postId: string
  sourceUrl: string
  sourceName: string
  relevance: RelevanceLevel
  classification: XPostClass
  selectionScore: number
  announcementHeavy: boolean
  decision: XCollectDecision
  reason: string
  observedAt: string | null
  excerptChars: number
  excerptPreview: string
  excerptForReview: string | null
}
