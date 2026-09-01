import type { SupabaseClient } from '@supabase/supabase-js'
import { ADMIN_EVENT_SELECT, type AdminEvent } from './types'

export type AdminDashboardStats = {
  draft: number
  published: number
  hidden: number
  ended: number
  pendingDedupe: number
  pendingField: number
  pendingImageUnknown: number
}

export async function fetchAdminDashboardStats(
  admin: SupabaseClient,
): Promise<AdminDashboardStats> {
  const today = new Date().toISOString().slice(0, 10)

  const [draftRes, pubRes, hiddenRes, endedRes, dedupeRes, fieldRes, imgRes] =
    await Promise.all([
      admin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'draft'),
      admin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'published'),
      admin.from('events').select('id', { count: 'exact', head: true }).eq('status', 'hidden'),
      admin
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'published')
        .lt('end_date', today),
      admin
        .from('event_dedupe_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      admin
        .from('event_field_reviews')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
      admin
        .from('events')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'published')
        .not('image_url', 'is', null)
        .or('image_usage_status.is.null,image_usage_status.eq.unknown'),
    ])

  return {
    draft: draftRes.count ?? 0,
    published: pubRes.count ?? 0,
    hidden: hiddenRes.count ?? 0,
    ended: endedRes.count ?? 0,
    pendingDedupe: dedupeRes.count ?? 0,
    pendingField: fieldRes.count ?? 0,
    pendingImageUnknown: imgRes.count ?? 0,
  }
}

export type AdminEventListFilter =
  | { kind: 'all' }
  | { kind: 'status'; status: string }
  | { kind: 'ended' }

export async function fetchAdminEventList(
  admin: SupabaseClient,
  filter: AdminEventListFilter,
  limit = 200,
): Promise<AdminEvent[]> {
  let query = admin
    .from('events')
    .select(ADMIN_EVENT_SELECT)
    .order('start_date', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (filter.kind === 'status') {
    query = query.eq('status', filter.status)
  } else if (filter.kind === 'ended') {
    const today = new Date().toISOString().slice(0, 10)
    query = query.eq('status', 'published').lt('end_date', today)
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as AdminEvent[]
}
