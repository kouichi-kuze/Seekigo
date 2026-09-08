/**
 * Dedupe X sources by Post ID (preferred over URL normalization).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export function extractXPostId(url: string | null | undefined): string | null {
  if (!url) return null
  const m =
    url.match(/\/status(?:es)?\/(\d+)/i) ||
    url.match(/\/i\/web\/status\/(\d+)/i)
  return m?.[1] ?? null
}

export async function loadExistingXSources(
  client: SupabaseClient,
  eventId: number,
): Promise<{ ids: Set<string>; count: number }> {
  const { data, error } = await client
    .from('event_reaction_sources')
    .select('source_url')
    .eq('event_id', eventId)
    .eq('source_type', 'x')

  const ids = new Set<string>()
  if (error) return { ids, count: 0 }
  for (const row of data ?? []) {
    const id = extractXPostId(row.source_url as string | null)
    if (id) ids.add(id)
  }
  return { ids, count: data?.length ?? ids.size }
}

/** @deprecated use loadExistingXSources */
export async function loadExistingXPostIds(
  client: SupabaseClient,
  eventId: number,
): Promise<Set<string>> {
  const { ids } = await loadExistingXSources(client, eventId)
  return ids
}
