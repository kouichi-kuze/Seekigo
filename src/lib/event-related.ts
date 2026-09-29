/**
 * 詳細ページの関連イベント。
 * 候補は街 → 区 → カテゴリ → その他。並びは同カテゴリ、近い開催日、id。
 */
import {
  nearestScheduleDays,
  resolveScheduleStatus,
  type DateSpan,
} from './event-schedule'

export const RELATED_EVENT_LIMIT = 4

export type RelatedEventInput = {
  id?: number | string | null
  area?: string | null
  municipality?: string | null
  category?: string[] | string | null
  schedule_spans?: DateSpan[]
}

function placeKey(value: string | null | undefined): string | null {
  const text = value?.trim().toLowerCase()
  return text ? text : null
}

function categoriesOf(value: RelatedEventInput['category']): string[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return [
    ...new Set(
      list
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item && item !== 'other'),
    ),
  ]
}

function sharesCategory(source: string[], target: RelatedEventInput): boolean {
  if (source.length === 0) return false
  const other = categoriesOf(target.category)
  return source.some((item) => other.includes(item))
}

function eventId(event: RelatedEventInput): number {
  const id = Number(event.id)
  return Number.isFinite(id) ? id : 0
}

function isOpen(event: RelatedEventInput): boolean {
  return (
    resolveScheduleStatus(event.schedule_spans ?? [], {
      start_date: null,
      end_date: null,
    }) !== 'ended'
  )
}

function compareWithinGroup(
  sourceCategories: string[],
  sourceSpans: DateSpan[],
  left: RelatedEventInput,
  right: RelatedEventInput,
): number {
  const leftCategory = sharesCategory(sourceCategories, left) ? 0 : 1
  const rightCategory = sharesCategory(sourceCategories, right) ? 0 : 1
  if (leftCategory !== rightCategory) return leftCategory - rightCategory

  const leftDays = nearestScheduleDays(sourceSpans, left.schedule_spans ?? [])
  const rightDays = nearestScheduleDays(sourceSpans, right.schedule_spans ?? [])
  const leftRank = leftDays ?? Number.POSITIVE_INFINITY
  const rightRank = rightDays ?? Number.POSITIVE_INFINITY
  if (leftRank !== rightRank) return leftRank - rightRank

  return eventId(left) - eventId(right)
}

export function selectRelatedEvents<T extends RelatedEventInput>(
  source: RelatedEventInput,
  pool: T[],
  limit = RELATED_EVENT_LIMIT,
): T[] {
  const sourceId = eventId(source)
  const sourceArea = placeKey(source.area)
  const sourceMunicipality = placeKey(source.municipality)
  const sourceCategories = categoriesOf(source.category)
  const sourceSpans = source.schedule_spans ?? []
  const open = pool.filter((event) => eventId(event) !== sourceId && isOpen(event))
  const picked: T[] = []
  const seen = new Set<number>()

  const take = (group: T[]) => {
    if (picked.length >= limit) return
    const sorted = group
      .filter((event) => !seen.has(eventId(event)))
      .sort((left, right) =>
        compareWithinGroup(sourceCategories, sourceSpans, left, right),
      )
    for (const event of sorted) {
      if (picked.length >= limit) return
      seen.add(eventId(event))
      picked.push(event)
    }
  }

  if (sourceArea) {
    take(open.filter((event) => placeKey(event.area) === sourceArea))
  }
  if (sourceMunicipality && picked.length < limit) {
    take(open.filter((event) => placeKey(event.municipality) === sourceMunicipality))
  }
  if (sourceCategories.length > 0 && picked.length < limit) {
    take(open.filter((event) => sharesCategory(sourceCategories, event)))
  }
  if (picked.length < limit) take(open)
  return picked
}
