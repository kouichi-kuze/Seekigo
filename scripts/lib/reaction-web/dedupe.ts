/**
 * In-memory + DB dedupe by event_id + normalized source_url.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeReactionSourceUrl } from './normalize'

export function buildDedupeKey(eventId: number, url: string | null | undefined): string | null {
  const n = normalizeReactionSourceUrl(url)
  if (!n) return null
  return `${eventId}::${n}`
}

export async function loadExistingNormalizedUrls(
  client: SupabaseClient,
  eventId: number,
): Promise<Set<string>> {
  const { data, error } = await client
    .from('event_reaction_sources')
    .select('source_url')
    .eq('event_id', eventId)

  const set = new Set<string>()
  if (error) {
    // table missing / RLS — caller handles; return empty for dry planning
    return set
  }
  for (const row of data ?? []) {
    const key = buildDedupeKey(eventId, row.source_url as string | null)
    if (key) set.add(key)
  }
  return set
}

export function isDuplicate(
  seen: Set<string>,
  eventId: number,
  url: string | null | undefined,
): boolean {
  const key = buildDedupeKey(eventId, url)
  if (!key) return false
  return seen.has(key)
}

export function rememberUrl(
  seen: Set<string>,
  eventId: number,
  url: string | null | undefined,
): void {
  const key = buildDedupeKey(eventId, url)
  if (key) seen.add(key)
}
