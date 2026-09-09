/**
 * Merge visit-field proposals: prefer higher confidence / better method.
 * Never invent; keep evidence. Low confidence excluded from auto-apply.
 */
import type { FieldSnapshot } from '../../../src/lib/event-field-review'
import type {
  VisitConfidence,
  VisitFieldName,
  VisitFieldProposal,
  VisitEnrichEventRow,
} from './types'

const METHOD_RANK: Record<VisitFieldProposal['method'], number> = {
  jsonld: 3,
  deterministic: 2,
  ai_assist: 1,
}

const CONF_RANK: Record<VisitConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
}

function score(p: VisitFieldProposal): number {
  return CONF_RANK[p.confidence] * 10 + METHOD_RANK[p.method]
}

export function mergeProposals(
  proposals: VisitFieldProposal[],
): VisitFieldProposal[] {
  const best = new Map<VisitFieldName, VisitFieldProposal>()
  for (const p of proposals) {
    if (p.proposed_value === null || p.proposed_value === undefined) continue
    if (typeof p.proposed_value === 'string' && !p.proposed_value.trim()) continue
    const prev = best.get(p.field)
    if (!prev || score(p) > score(prev)) best.set(p.field, p)
  }
  return [...best.values()]
}

/** Existing non-null values win unless empty; low never overwrites. */
export function selectWritableProposals(
  event: VisitEnrichEventRow,
  merged: VisitFieldProposal[],
): {
  forReview: VisitFieldProposal[]
  forDraftApply: VisitFieldProposal[]
  skipped: { field: VisitFieldName; reason: string }[]
} {
  const forReview: VisitFieldProposal[] = []
  const forDraftApply: VisitFieldProposal[] = []
  const skipped: { field: VisitFieldName; reason: string }[] = []

  const currentOf = (field: VisitFieldName): unknown => {
    return (event as Record<string, unknown>)[field]
  }

  for (const p of merged) {
    if (p.confidence === 'low') {
      skipped.push({ field: p.field, reason: 'low_confidence' })
      continue
    }

    const cur = currentOf(p.field)
    const hasCurrent =
      cur !== null &&
      cur !== undefined &&
      !(typeof cur === 'string' && !String(cur).trim())

    if (hasCurrent) {
      const same =
        typeof cur === 'number' || typeof cur === 'boolean'
          ? cur === p.proposed_value
          : String(cur).trim() === String(p.proposed_value).trim()
      if (same) {
        skipped.push({ field: p.field, reason: 'matches_existing' })
        continue
      }
      // existing differs → review only (never silent overwrite)
      forReview.push(p)
      continue
    }

    // empty current
    if (p.confidence === 'high') {
      forDraftApply.push(p)
      forReview.push(p) // published path uses review
    } else if (p.confidence === 'medium') {
      forReview.push(p)
    }
  }

  return { forReview, forDraftApply, skipped }
}

export function proposalsToFieldSnapshot(
  proposals: VisitFieldProposal[],
): FieldSnapshot {
  const snap: FieldSnapshot = {}
  for (const p of proposals) {
    ;(snap as Record<string, unknown>)[p.field] = p.proposed_value
  }
  return snap
}
