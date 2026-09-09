/**
 * Resolve fetchable URLs for visit-attr enrichment.
 * Walkerplus listing URLs are never auto-fetched.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { safeFetchText } from '../reaction-web/fetch'
import {
  buildEvidenceExcerpts,
  extractJsonLdBlocks,
  htmlToPlainText,
} from './html-text'
import type { FetchedSource } from './types'

const WALKERPLUS_HOST = /(^|\.)walkerplus\.com$/i

export function isWalkerplusUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return WALKERPLUS_HOST.test(host)
  } catch {
    return false
  }
}

export function isFetchableEnrichUrl(url: string): boolean {
  if (!url.trim()) return false
  if (isWalkerplusUrl(url)) return false
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export type CandidateUrl = {
  role: FetchedSource['role']
  url: string
}

export async function loadCandidateUrls(
  client: SupabaseClient,
  eventId: number,
  event: {
    official_url: string | null
    source_url: string | null
  },
): Promise<CandidateUrl[]> {
  const out: CandidateUrl[] = []
  const seen = new Set<string>()

  const add = (role: CandidateUrl['role'], url: string | null | undefined) => {
    const u = url?.trim()
    if (!u) return
    if (seen.has(u)) return
    seen.add(u)
    out.push({ role, url: u })
  }

  add('official', event.official_url)

  const { data: sources } = await client
    .from('event_sources')
    .select('source_name, source_url, official_url')
    .eq('event_id', eventId)

  for (const row of sources ?? []) {
    add('official', row.official_url as string | null)
    const name = String(row.source_name ?? '')
    const su = row.source_url as string | null
    if (name === 'walkerplus') {
      // listing URL: do not fetch; keep only if already added as official
      continue
    }
    add('source', su)
  }

  // events.source_url: skip walkerplus auto-fetch
  if (event.source_url && !isWalkerplusUrl(event.source_url)) {
    add('source', event.source_url)
  }

  // reaction official_web / press_release URLs (optional boost)
  const { data: reactionSources } = await client
    .from('event_reaction_sources')
    .select('source_type, source_url')
    .eq('event_id', eventId)
    .in('source_type', ['official_web', 'press_release'])
    .limit(5)

  for (const row of reactionSources ?? []) {
    add('reaction_official', row.source_url as string | null)
  }

  return out
}

export type FetchedPage = {
  meta: FetchedSource
  plainText: string
  excerpt: string
  jsonLd: unknown[]
}

export async function fetchEnrichPages(
  candidates: CandidateUrl[],
): Promise<FetchedPage[]> {
  const pages: FetchedPage[] = []

  for (const c of candidates) {
    if (!isFetchableEnrichUrl(c.url)) {
      pages.push({
        meta: {
          role: c.role,
          url: c.url,
          finalUrl: c.url,
          ok: false,
          skipped: true,
          reason: isWalkerplusUrl(c.url)
            ? 'walkerplus_no_auto_fetch'
            : 'not_fetchable',
        },
        plainText: '',
        excerpt: '',
        jsonLd: [],
      })
      continue
    }

    const fetched = await safeFetchText(c.url)
    if (!fetched.ok) {
      pages.push({
        meta: {
          role: c.role,
          url: c.url,
          finalUrl: c.url,
          ok: false,
          reason: fetched.reason,
        },
        plainText: '',
        excerpt: '',
        jsonLd: [],
      })
      continue
    }

    const plain = htmlToPlainText(fetched.bodyText)
    pages.push({
      meta: {
        role: c.role,
        url: c.url,
        finalUrl: fetched.finalUrl,
        ok: true,
        htmlLength: fetched.bodyText.length,
        title: null,
      },
      plainText: plain,
      excerpt: buildEvidenceExcerpts(plain),
      jsonLd: extractJsonLdBlocks(fetched.bodyText),
    })
  }

  return pages
}
