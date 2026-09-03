import type { SupabaseClient } from '@supabase/supabase-js'
import {
  parseFieldReviewStatusFilter,
  type AdminFieldReviewRow,
  type FieldReviewStatusFilter,
} from './field-review-display'

const FIELD_REVIEW_SELECT =
  'id, event_id, source_name, source_url, field_name, current_value, proposed_value, status, reason, created_at, decided_at'

export async function fetchAdminFieldReviews(
  admin: SupabaseClient,
  opts: {
    status?: FieldReviewStatusFilter | string | null
    eventId?: number
    limit?: number
  } = {},
): Promise<AdminFieldReviewRow[]> {
  const status = parseFieldReviewStatusFilter(opts.status ?? 'pending')
  const limit = opts.limit ?? 200

  let query = admin
    .from('event_field_reviews')
    .select(FIELD_REVIEW_SELECT)
    .eq('status', status)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (opts.eventId != null && Number.isFinite(opts.eventId) && opts.eventId > 0) {
    query = query.eq('event_id', opts.eventId)
  }

  const { data, error } = await query
  if (error) throw error

  const rows = (data ?? []) as AdminFieldReviewRow[]
  const eventIds = [
    ...new Set(
      rows
        .map((r) => Number(r.event_id))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ]

  const titlesById = new Map<number, { title: string | null; slug: string | null }>()
  if (eventIds.length > 0) {
    const { data: evs, error: evErr } = await admin
      .from('events')
      .select('id, title, slug')
      .in('id', eventIds)
    if (evErr) throw evErr
    for (const e of evs ?? []) {
      titlesById.set(Number(e.id), {
        title: e.title ?? null,
        slug: e.slug ?? null,
      })
    }
  }

  return rows.map((r) => {
    const meta = titlesById.get(Number(r.event_id))
    return {
      ...r,
      event_title: meta?.title ?? null,
      event_slug: meta?.slug ?? null,
    }
  })
}

export async function countPendingFieldReviewsForEvent(
  admin: SupabaseClient,
  eventId: number,
): Promise<number> {
  const { count, error } = await admin
    .from('event_field_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('status', 'pending')
  if (error) throw error
  return count ?? 0
}
