/**
 * Ensure draft summary + insert reaction sources (service role only).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectPlanRow, ReactionWebSourceType } from './types'

export async function ensureDraftSummary(
  client: SupabaseClient,
  eventId: number,
): Promise<{ summaryId: number; created: boolean }> {
  const { data: existing, error } = await client
    .from('event_reaction_summaries')
    .select('id')
    .eq('event_id', eventId)
    .maybeSingle()
  if (error) throw new Error(`summary select failed: ${error.message}`)
  if (existing?.id) {
    return { summaryId: Number(existing.id), created: false }
  }

  const now = new Date().toISOString()
  const { data: inserted, error: insErr } = await client
    .from('event_reaction_summaries')
    .insert({
      event_id: eventId,
      summary_bullets: [],
      signals: {},
      source_count: 0,
      confidence: 'low',
      status: 'draft',
      generated_at: now,
    })
    .select('id')
    .maybeSingle()
  if (insErr || !inserted) {
    throw new Error(`summary insert failed: ${insErr?.message ?? 'no row'}`)
  }
  return { summaryId: Number(inserted.id), created: true }
}

export async function insertReactionSource(
  client: SupabaseClient,
  opts: {
    eventId: number
    summaryId: number
    sourceType: ReactionWebSourceType
    sourceUrl: string
    sourceName: string | null
    observedAt: string | null
    excerpt: string | null
  },
): Promise<{ id: number }> {
  const { data, error } = await client
    .from('event_reaction_sources')
    .insert({
      event_id: opts.eventId,
      summary_id: opts.summaryId,
      source_type: opts.sourceType,
      source_url: opts.sourceUrl,
      source_name: opts.sourceName,
      observed_at: opts.observedAt,
      excerpt_for_internal_review: opts.excerpt,
    })
    .select('id')
    .maybeSingle()
  if (error || !data) {
    throw new Error(`source insert failed: ${error?.message ?? 'no row'}`)
  }
  return { id: Number(data.id) }
}

export async function recountSummarySources(
  client: SupabaseClient,
  eventId: number,
  summaryId: number,
): Promise<void> {
  const { count, error } = await client
    .from('event_reaction_sources')
    .select('*', { count: 'exact', head: true })
    .eq('summary_id', summaryId)
  if (error) throw new Error(`source count failed: ${error.message}`)
  const { error: upErr } = await client
    .from('event_reaction_summaries')
    .update({ source_count: count ?? 0 })
    .eq('id', summaryId)
    .eq('event_id', eventId)
  if (upErr) throw new Error(`source_count update failed: ${upErr.message}`)
}

export function planRowToInsert(row: CollectPlanRow): {
  sourceType: ReactionWebSourceType
  sourceUrl: string
  sourceName: string | null
  observedAt: string | null
  excerpt: string | null
} | null {
  if (row.decision !== 'save') return null
  if (!row.finalUrl || !row.sourceType) return null
  return {
    sourceType: row.sourceType,
    sourceUrl: row.finalUrl,
    sourceName: row.sourceName,
    observedAt: row.observedAt,
    excerpt: row.excerptForReview,
  }
}
