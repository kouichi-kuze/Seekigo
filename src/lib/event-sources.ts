/**
 * event_sources の冪等 attach（import / admin 共通）。
 * events 本体は触らない。
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type EventSourceName = 'gotokyo' | 'enjoytokyo'

export type EventSourceRow = {
  event_id: number
  source_name: EventSourceName
  source_url: string
  source_event_id: string | null
  official_url: string | null
  last_checked_at: string
}

export type AttachResult = 'new_source' | 'already_attached'

/**
 * event_sources を冪等に確保する。
 * 既存: INSERT せず last_checked_at / official_url / source_event_id のみ更新
 * 新規: INSERT
 */
export async function ensureEventSource(
  client: SupabaseClient,
  row: EventSourceRow,
  write: boolean,
  logPrefix = '[event-sources]',
): Promise<AttachResult> {
  const { data: existing, error: selErr } = await client
    .from('event_sources')
    .select('id')
    .eq('event_id', row.event_id)
    .eq('source_name', row.source_name)
    .eq('source_url', row.source_url)
    .maybeSingle()

  if (selErr) throw selErr

  if (existing) {
    console.log(
      `${logPrefix} source already attached: event_id=${row.event_id}`,
    )
    if (write) {
      const { error: updErr } = await client
        .from('event_sources')
        .update({
          source_event_id: row.source_event_id,
          official_url: row.official_url,
          last_checked_at: row.last_checked_at,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
      if (updErr) throw updErr
    }
    return 'already_attached'
  }

  if (write) {
    const { error: insErr } = await client.from('event_sources').insert(row)
    if (insErr) throw insErr
    console.log(
      `${logPrefix} new source attached: event_id=${row.event_id}`,
    )
  } else {
    console.log(
      `${logPrefix} would attach new source: event_id=${row.event_id}`,
    )
  }
  return 'new_source'
}

export function extractGotokyoSpotId(
  sourceUrl: string | null | undefined,
): string | null {
  if (!sourceUrl) return null
  const m = sourceUrl.match(/\/spot\/((?:ex|ev)\d+)\//i)
  return m?.[1]?.toLowerCase() ?? null
}

export function extractEnjoytokyoEventId(
  sourceUrl: string | null | undefined,
): string | null {
  if (!sourceUrl) return null
  const m = sourceUrl.match(/\/event\/(\d+)\/?/i)
  return m?.[1] ?? null
}
