/**
 * Seekigo Phase 4B-1: collect public Web / RSS / press sources into
 * event_reaction_sources (no SNS APIs, no AI, no auto-publish).
 *
 * Usage (PowerShell):
 *   $env:REACTION_EVENT_ID="2"
 *   $env:DRY_RUN="true"
 *   npm run collect:reaction-web
 *
 * Optional:
 *   $env:REACTION_URLS="https://example.com/a,https://example.com/feed.xml"
 *   $env:REACTION_MAX_WRITE="3"   # write mode only (default 3)
 *
 * Write mode (DO NOT run unless intentional):
 *   $env:DRY_RUN="false"
 *   $env:REACTION_EVENT_ID="2"
 *   npm run collect:reaction-web
 *
 * Defaults: DRY_RUN=true (no DB writes).
 * Secrets / full article body are never logged.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { safeFetchText } from './lib/reaction-web/fetch'
import {
  isDuplicate,
  loadExistingNormalizedUrls,
  rememberUrl,
} from './lib/reaction-web/dedupe'
import {
  classifySourceType,
  normalizeReactionSourceUrl,
  sameRegistrableHint,
  truncateExcerpt,
} from './lib/reaction-web/normalize'
import { looksLikeFeed, parseHtmlPage } from './lib/reaction-web/parse-html'
import { parseFeedXml } from './lib/reaction-web/parse-rss'
import { isSaveableRelevance, scoreRelevance } from './lib/reaction-web/relevance'
import {
  ensureDraftSummary,
  insertReactionSource,
  planRowToInsert,
  recountSummarySources,
} from './lib/reaction-web/store'
import { validatePublicHttpUrl } from './lib/reaction-web/url-safety'
import type {
  CollectPlanRow,
  EventContext,
  UrlCandidate,
} from './lib/reaction-web/types'

config()

const LOG = '[collect-reaction-web]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const EVENT_ID = Number(process.env.REACTION_EVENT_ID ?? '')
const MAX_WRITE = Math.min(
  Math.max(Number(process.env.REACTION_MAX_WRITE ?? '3') || 3, 1),
  3,
)

function createServiceClient(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  }
  if (key === process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use publishable key as service role')
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function parseExtraUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return []
  return raw
    .split(/[,|\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function hintKindFromUrl(url: string): UrlCandidate['kind'] {
  const lower = url.toLowerCase()
  if (/(\.xml|\/feed\/?|\/rss\/?|atom)/i.test(lower)) return 'rss'
  if (/press|prtimes|newsrelease/i.test(lower)) return 'press'
  if (/blog|note\.com|medium\.com/i.test(lower)) return 'blog_news'
  return 'extra_url'
}

async function loadEvent(client: SupabaseClient, eventId: number): Promise<{
  event: EventContext
  candidates: UrlCandidate[]
}> {
  const { data: event, error } = await client
    .from('events')
    .select('id, title, venue, official_url, source_url, start_date, end_date, area')
    .eq('id', eventId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!event) throw new Error(`event ${eventId} not found`)

  const { data: sources } = await client
    .from('event_sources')
    .select('source_url, source_name')
    .eq('event_id', eventId)

  const ctx: EventContext = {
    id: Number(event.id),
    title: String(event.title ?? ''),
    venue: (event.venue as string | null) ?? null,
    official_url: (event.official_url as string | null) ?? null,
    source_url: (event.source_url as string | null) ?? null,
    start_date: (event.start_date as string | null) ?? null,
    end_date: (event.end_date as string | null) ?? null,
    area: (event.area as string | null) ?? null,
  }

  const candidates: UrlCandidate[] = []
  const push = (url: string | null | undefined, kind: UrlCandidate['kind']) => {
    if (!url?.trim()) return
    const v = validatePublicHttpUrl(url)
    if (!v.ok) {
      console.log(`${LOG} skip candidate (${v.reason}): ${url.slice(0, 80)}`)
      return
    }
    candidates.push({ url: v.url.href, kind })
  }

  push(ctx.official_url, 'official_url')
  push(ctx.source_url, 'event_source')
  for (const s of sources ?? []) {
    push(s.source_url as string | null, 'event_source')
  }
  for (const u of parseExtraUrls(process.env.REACTION_URLS)) {
    push(u, hintKindFromUrl(u))
  }

  // de-dupe candidates by normalized url
  const seen = new Set<string>()
  const unique: UrlCandidate[] = []
  for (const c of candidates) {
    const n = normalizeReactionSourceUrl(c.url)
    if (!n || seen.has(n)) continue
    seen.add(n)
    unique.push(c)
  }

  return { event: ctx, candidates: unique }
}

function logPlan(row: CollectPlanRow): void {
  console.log(
    JSON.stringify({
      candidate: row.candidateUrl,
      finalUrl: row.finalUrl,
      source_type: row.sourceType,
      source_name: row.sourceName,
      relevance: row.relevance,
      excerpt_chars: row.excerptChars,
      decision: row.decision,
      reason: row.reason,
      // never log excerpt body
    }),
  )
}

async function processCandidate(
  event: EventContext,
  candidate: UrlCandidate,
  seen: Set<string>,
): Promise<CollectPlanRow[]> {
  const rows: CollectPlanRow[] = []

  const fetched = await safeFetchText(candidate.url)
  if (!fetched.ok) {
    const decision =
      fetched.reason.startsWith('unsafe_url')
        ? 'skip_unsafe_url'
        : fetched.reason.startsWith('robots:')
          ? 'skip_robots'
          : 'skip_fetch'
    rows.push({
      candidateUrl: candidate.url,
      finalUrl: null,
      normalizedUrl: null,
      sourceType: null,
      sourceName: null,
      relevance: null,
      excerptChars: 0,
      decision,
      reason: fetched.reason,
      observedAt: null,
      excerptForReview: null,
    })
    return rows
  }

  const feedKind = looksLikeFeed(fetched.contentType, fetched.bodyText)
  if (feedKind) {
    let parsed
    try {
      parsed = parseFeedXml(fetched.bodyText, fetched.finalUrl, feedKind)
    } catch {
      rows.push({
        candidateUrl: candidate.url,
        finalUrl: fetched.finalUrl,
        normalizedUrl: normalizeReactionSourceUrl(fetched.finalUrl),
        sourceType: 'rss',
        sourceName: null,
        relevance: null,
        excerptChars: 0,
        decision: 'skip_parse',
        reason: 'rss_parse_failed',
        observedAt: null,
        excerptForReview: null,
      })
      return rows
    }

    const items = parsed.items?.length ? parsed.items : []
    if (!items.length) {
      rows.push({
        candidateUrl: candidate.url,
        finalUrl: fetched.finalUrl,
        normalizedUrl: normalizeReactionSourceUrl(fetched.finalUrl),
        sourceType: 'rss',
        sourceName: parsed.siteName,
        relevance: 'irrelevant',
        excerptChars: 0,
        decision: 'skip_irrelevant',
        reason: 'rss_no_items',
        observedAt: null,
        excerptForReview: null,
      })
      return rows
    }

    for (const item of items) {
      const itemUrl = item.link || fetched.finalUrl
      const rel = scoreRelevance(
        event,
        {
          title: parsed.title,
          description: null,
          excerpt: item.excerpt,
          publishedAt: item.publishedAt,
          finalUrl: itemUrl,
          canonicalUrl: itemUrl,
        },
        item.title,
      )
      const normalizedUrl = normalizeReactionSourceUrl(itemUrl)
      if (!isSaveableRelevance(rel.level)) {
        rows.push({
          candidateUrl: candidate.url,
          finalUrl: itemUrl,
          normalizedUrl,
          sourceType: 'rss',
          sourceName: parsed.siteName || item.title,
          relevance: rel.level,
          excerptChars: item.excerpt.length,
          decision: 'skip_irrelevant',
          reason: `relevance=${rel.level};${rel.reasons.join(',')}`,
          observedAt: item.publishedAt,
          excerptForReview: null,
        })
        continue
      }
      if (isDuplicate(seen, event.id, itemUrl)) {
        rows.push({
          candidateUrl: candidate.url,
          finalUrl: itemUrl,
          normalizedUrl,
          sourceType: 'rss',
          sourceName: parsed.siteName || item.title,
          relevance: rel.level,
          excerptChars: item.excerpt.length,
          decision: 'skip_duplicate',
          reason: 'duplicate_normalized_url',
          observedAt: item.publishedAt,
          excerptForReview: null,
        })
        continue
      }
      rememberUrl(seen, event.id, itemUrl)
      rows.push({
        candidateUrl: candidate.url,
        finalUrl: itemUrl,
        normalizedUrl,
        sourceType: 'rss',
        sourceName: truncateExcerpt(parsed.siteName || item.title || 'RSS', 80),
        relevance: rel.level,
        excerptChars: item.excerpt.length,
        decision: 'save',
        reason: `relevance=${rel.level};${rel.reasons.join(',')}`,
        observedAt: item.publishedAt || new Date().toISOString(),
        excerptForReview: item.excerpt,
      })
    }
    return rows
  }

  let page
  try {
    page = parseHtmlPage(fetched.bodyText, fetched.finalUrl)
  } catch {
    rows.push({
      candidateUrl: candidate.url,
      finalUrl: fetched.finalUrl,
      normalizedUrl: normalizeReactionSourceUrl(fetched.finalUrl),
      sourceType: null,
      sourceName: null,
      relevance: null,
      excerptChars: 0,
      decision: 'skip_parse',
      reason: 'html_parse_failed',
      observedAt: null,
      excerptForReview: null,
    })
    return rows
  }

  const targetUrl = page.canonicalUrl || page.finalUrl
  const isOfficial = sameRegistrableHint(event.official_url, targetUrl)
  const sourceType = classifySourceType({
    url: targetUrl,
    kind: candidate.kind,
    contentKind: 'html',
    hintedType: candidate.hintedType,
    isOfficialDomain: isOfficial,
  })
  const rel = scoreRelevance(event, page)
  const normalizedUrl = normalizeReactionSourceUrl(targetUrl)

  if (!isSaveableRelevance(rel.level)) {
    rows.push({
      candidateUrl: candidate.url,
      finalUrl: targetUrl,
      normalizedUrl,
      sourceType,
      sourceName: page.siteName || page.title,
      relevance: rel.level,
      excerptChars: page.excerpt.length,
      decision: 'skip_irrelevant',
      reason: `relevance=${rel.level};${rel.reasons.join(',')}`,
      observedAt: page.publishedAt,
      excerptForReview: null,
    })
    return rows
  }

  if (isDuplicate(seen, event.id, targetUrl)) {
    rows.push({
      candidateUrl: candidate.url,
      finalUrl: targetUrl,
      normalizedUrl,
      sourceType,
      sourceName: page.siteName || page.title,
      relevance: rel.level,
      excerptChars: page.excerpt.length,
      decision: 'skip_duplicate',
      reason: 'duplicate_normalized_url',
      observedAt: page.publishedAt,
      excerptForReview: null,
    })
    return rows
  }

  rememberUrl(seen, event.id, targetUrl)
  rows.push({
    candidateUrl: candidate.url,
    finalUrl: targetUrl,
    normalizedUrl,
    sourceType,
    sourceName: truncateExcerpt(page.siteName || page.title || sourceType, 80),
    relevance: rel.level,
    excerptChars: page.excerpt.length,
    decision: 'save',
    reason: `relevance=${rel.level};${rel.reasons.join(',')};robots=${fetched.robotsReason}`,
    observedAt: page.publishedAt || new Date().toISOString(),
    excerptForReview: page.excerpt,
  })
  return rows
}

async function main() {
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  if (!Number.isFinite(EVENT_ID) || EVENT_ID <= 0) {
    console.error(
      `${LOG} set REACTION_EVENT_ID to a positive event id (PowerShell: $env:REACTION_EVENT_ID="2")`,
    )
    process.exit(1)
  }

  const client = createServiceClient()
  const { event, candidates } = await loadEvent(client, EVENT_ID)
  console.log(
    `${LOG} event_id=${event.id} title=${JSON.stringify(event.title)} candidates=${candidates.length}`,
  )

  const seen = await loadExistingNormalizedUrls(client, event.id)
  const allRows: CollectPlanRow[] = []

  for (const c of candidates) {
    const rows = await processCandidate(event, c, seen)
    allRows.push(...rows)
  }

  let saveCount = 0
  for (const row of allRows) {
    if (row.decision === 'save') {
      if (saveCount >= MAX_WRITE) {
        row.decision = 'skip_max_write'
        row.reason = `max_write=${MAX_WRITE}`
        row.excerptForReview = null
      } else {
        saveCount += 1
      }
    }
    logPlan(row)
  }

  const toWrite = allRows.filter((r) => r.decision === 'save')
  console.log(
    `${LOG} summary: total=${allRows.length} save_planned=${toWrite.length} max_write=${MAX_WRITE}`,
  )

  if (DRY_RUN) {
    console.log(`${LOG} dry-run mode — no DB writes (set DRY_RUN=false to write up to ${MAX_WRITE})`)
    return
  }

  if (!toWrite.length) {
    console.log(`${LOG} nothing to write`)
    return
  }

  const { summaryId, created } = await ensureDraftSummary(client, event.id)
  console.log(
    `${LOG} summary_id=${summaryId} created=${created} (status unchanged if existing)`,
  )

  let written = 0
  for (const row of toWrite) {
    const payload = planRowToInsert(row)
    if (!payload) continue
    const { id } = await insertReactionSource(client, {
      eventId: event.id,
      summaryId,
      ...payload,
    })
    written += 1
    console.log(
      JSON.stringify({
        written: true,
        source_id: id,
        summary_id: summaryId,
        event_id: event.id,
        source_type: payload.sourceType,
        // no excerpt
      }),
    )
  }

  await recountSummarySources(client, event.id, summaryId)
  console.log(`${LOG} done write_mode written=${written}`)
}

main().catch((e) => {
  console.error(`${LOG} fatal:`, e instanceof Error ? e.message : e)
  process.exit(1)
})
