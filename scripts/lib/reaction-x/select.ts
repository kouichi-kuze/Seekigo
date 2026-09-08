/**
 * Select X posts to save under per-event caps and class quotas.
 */
import type { XPostClass } from './classify'
import type { RelevanceLevel } from './types'

export const MAX_X_SOURCES_PER_EVENT = 20
export const CLASS_QUOTAS: Record<XPostClass, number> = {
  experience: 12,
  official: 2,
  media: 2,
  other: 4,
}

export type SelectableXCandidate = {
  postId: string
  classification: XPostClass
  relevance: RelevanceLevel
  selectionScore: number
  announcementHeavy: boolean
}

export function computeSelectionScore(opts: {
  relevanceScore: number
  relevance: RelevanceLevel
  classification: XPostClass
  announcementHeavy: boolean
  titleExact: boolean
  venueMention: boolean
  urlMention: boolean
  createdAt: string | null
}): number {
  let s = opts.relevanceScore * 10
  if (opts.relevance === 'exact') s += 3
  if (opts.classification === 'experience') s += 8
  else if (opts.classification === 'official') s += 2
  else if (opts.classification === 'media') s += 2
  if (opts.announcementHeavy) s -= 6
  if (opts.titleExact) s += 4
  if (opts.venueMention) s += 2
  if (opts.urlMention) s += 2
  if (opts.createdAt) {
    const t = Date.parse(opts.createdAt)
    if (!Number.isNaN(t)) {
      // newer within ~7d lookback gets up to +2
      const ageDays = (Date.now() - t) / 864e5
      s += Math.max(0, 2 - ageDays / 3.5)
    }
  }
  return s
}

/**
 * Fill quotas by class priority: experience → official → media → other.
 * Within class: higher selectionScore first.
 */
export function selectWithQuotas(
  candidates: SelectableXCandidate[],
  remainingSlots: number,
): { selectedIds: Set<string>; filled: Record<XPostClass, number> } {
  const slots = Math.max(0, remainingSlots)
  const filled: Record<XPostClass, number> = {
    experience: 0,
    official: 0,
    media: 0,
    other: 0,
  }
  const selectedIds = new Set<string>()
  if (slots <= 0) return { selectedIds, filled }

  const order: XPostClass[] = ['experience', 'official', 'media', 'other']
  const byClass = new Map<XPostClass, SelectableXCandidate[]>()
  for (const c of order) byClass.set(c, [])
  for (const c of candidates) {
    byClass.get(c.classification)?.push(c)
  }
  for (const c of order) {
    byClass.get(c)!.sort((a, b) => b.selectionScore - a.selectionScore)
  }

  let used = 0
  for (const cls of order) {
    const quota = CLASS_QUOTAS[cls]
    const list = byClass.get(cls) ?? []
    for (const item of list) {
      if (used >= slots) break
      if (filled[cls] >= quota) break
      selectedIds.add(item.postId)
      filled[cls] += 1
      used += 1
    }
  }

  return { selectedIds, filled }
}
