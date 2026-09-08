/**
 * Seekigo Phase 4B-2.1: X Recent Search → event_reaction_sources
 *
 * Fetch: first 20, then +10 if valid(exact/likely) < 10 (max 30 reads).
 * Save: max 20 X sources / event (incl. existing). Quotas:
 *   experience≤12, official≤2, media≤2, other≤4
 *
 * Usage (PowerShell):
 *   $env:REACTION_EVENT_ID="42"
 *   $env:DRY_RUN="true"
 *   npm run collect:reaction-x
 *
 * Write (after DRY_RUN review):
 *   $env:DRY_RUN="false"
 *   $env:REACTION_EVENT_ID="42"
 *   npm run collect:reaction-x
 *
 * Optional: X_QUERY_OVERRIDE
 * Save cap: min(remaining slots under 20/event, class quotas).
 *
 * Requires X_BEARER_TOKEN (never PUBLIC_). Secrets / full bodies never logged.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { classifyXPost, isAnnouncementHeavy } from './lib/reaction-x/classify'
import { searchRecentTweets, xPostUrl } from './lib/reaction-x/client'
import { estimatePostReadCostUsd, X_POST_READ_COST_USD } from './lib/reaction-x/cost'
import { loadExistingXSources } from './lib/reaction-x/dedupe'
import { buildInternalExcerpt, previewExcerpt } from './lib/reaction-x/excerpt'
import { buildSearchStartTime, buildXSearchQuery } from './lib/reaction-x/query'
import { isSaveableRelevance, scoreXPostRelevance } from './lib/reaction-x/relevance'
import {
  CLASS_QUOTAS,
  computeSelectionScore,
  MAX_X_SOURCES_PER_EVENT,
  selectWithQuotas,
  type SelectableXCandidate,
} from './lib/reaction-x/select'
import type { XCollectPlanRow, XEventContext, XPost } from './lib/reaction-x/types'
import {
  ensureDraftSummary,
  insertReactionSource,
  recountSummarySources,
} from './lib/reaction-web/store'

config()

const LOG = '[collect-reaction-x]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const EVENT_ID = Number(process.env.REACTION_EVENT_ID ?? '')
const FIRST_FETCH = 20
const SECOND_FETCH = 10
const MAX_TOTAL_FETCH = 30
const VALID_MIN_FOR_SECOND = 10
const QUERY_OVERRIDE = process.env.X_QUERY_OVERRIDE?.trim() || null

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

function requireBearer(): string {
  const token = process.env.X_BEARER_TOKEN?.trim()
  if (!token) {
    throw new Error(
      'X_BEARER_TOKEN is not set (add to .env — never use PUBLIC_ prefix)',
    )
  }
  if (process.env.PUBLIC_X_BEARER_TOKEN) {
    throw new Error('PUBLIC_X_BEARER_TOKEN must not be set')
  }
  return token
}

async function loadEvent(
  client: SupabaseClient,
  eventId: number,
): Promise<XEventContext> {
  const { data, error } = await client
    .from('events')
    .select('id, title, venue, official_url, source_url, start_date, end_date, area')
    .eq('id', eventId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error(`event ${eventId} not found`)
  return {
    id: Number(data.id),
    title: String(data.title ?? ''),
    venue: (data.venue as string | null) ?? null,
    official_url: (data.official_url as string | null) ?? null,
    source_url: (data.source_url as string | null) ?? null,
    start_date: (data.start_date as string | null) ?? null,
    end_date: (data.end_date as string | null) ?? null,
    area: (data.area as string | null) ?? null,
  }
}

function logPlan(row: XCollectPlanRow): void {
  console.log(
    JSON.stringify({
      post_id: row.postId,
      classification: row.classification,
      relevance: row.relevance,
      selection_score: Number(row.selectionScore.toFixed(3)),
      announcement_heavy: row.announcementHeavy,
      decision: row.decision,
      reason: row.reason,
      excerpt_preview: row.excerptPreview,
    }),
  )
}

function analyzePost(
  event: XEventContext,
  post: XPost,
  existingIds: Set<string>,
): XCollectPlanRow {
  const rel = scoreXPostRelevance(event, post)
  const classification = classifyXPost(post)
  const announcementHeavy = isAnnouncementHeavy(post)
  const titleExact = rel.reasons.includes('title_exact')
  const venueMention = rel.reasons.includes('venue')
  const urlMention = rel.reasons.includes('url_mention')
  const selectionScore = computeSelectionScore({
    relevanceScore: rel.score,
    relevance: rel.level,
    classification,
    announcementHeavy,
    titleExact,
    venueMention,
    urlMention,
    createdAt: post.created_at,
  })

  const sourceUrl = xPostUrl(post.id)
  const sourceName = post.username ? `X @${post.username}` : 'X'
  const excerpt = buildInternalExcerpt(post.text)
  const base = {
    postId: post.id,
    sourceUrl,
    sourceName,
    relevance: rel.level,
    classification,
    selectionScore,
    announcementHeavy,
    observedAt: post.created_at,
    excerptChars: excerpt.length,
    excerptPreview: previewExcerpt(post.text),
  }

  if (!isSaveableRelevance(rel.level)) {
    return {
      ...base,
      decision: 'skip_irrelevant',
      reason: `relevance=${rel.level};${rel.reasons.join(',')}`,
      excerptForReview: null,
    }
  }

  if (existingIds.has(post.id)) {
    return {
      ...base,
      decision: 'skip_duplicate',
      reason: 'duplicate_post_id',
      excerptForReview: null,
    }
  }

  return {
    ...base,
    decision: 'save', // provisional — quotas applied later
    reason: `relevance=${rel.level};class=${classification};${rel.reasons.join(',')}`,
    excerptForReview: excerpt,
  }
}

async function main() {
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} endpoint: https://api.x.com/2/tweets/search/recent`)
  console.log(`${LOG} cost_unit_usd_per_post_read: ${X_POST_READ_COST_USD}`)
  console.log(
    `${LOG} note: X pricing may change — verify on the developer portal`,
  )
  console.log(
    JSON.stringify({
      first_fetch: FIRST_FETCH,
      second_fetch: SECOND_FETCH,
      max_total_fetch: MAX_TOTAL_FETCH,
      valid_min_for_second: VALID_MIN_FOR_SECOND,
      max_x_sources_per_event: MAX_X_SOURCES_PER_EVENT,
      class_quotas: CLASS_QUOTAS,
    }),
  )

  if (!Number.isFinite(EVENT_ID) || EVENT_ID <= 0) {
    console.error(
      `${LOG} set REACTION_EVENT_ID (PowerShell: $env:REACTION_EVENT_ID="42")`,
    )
    process.exit(1)
  }

  const client = createServiceClient()
  const event = await loadEvent(client, EVENT_ID)
  const { query, parts } = buildXSearchQuery(event, QUERY_OVERRIDE)
  const startTime = buildSearchStartTime(event)
  const { ids: existingIds, count: existingCount } = await loadExistingXSources(
    client,
    event.id,
  )
  const remainingSlots = Math.max(0, MAX_X_SOURCES_PER_EVENT - existingCount)

  console.log(
    JSON.stringify({
      event_id: event.id,
      title: event.title,
      query,
      query_parts: parts,
      start_time: startTime,
      existing_x_sources: existingCount,
      remaining_save_slots: remainingSlots,
    }),
  )

  const bearer = requireBearer()

  // ── first fetch (20) ───────────────────────────────────────
  const first = await searchRecentTweets({
    bearerToken: bearer,
    query,
    maxResults: FIRST_FETCH,
    startTime,
  })
  if (!first.ok) {
    console.error(
      JSON.stringify({
        api_ok: false,
        phase: 'first_fetch',
        http_status: first.status,
        reason: first.reason,
      }),
    )
    process.exit(1)
  }

  const seenPostIds = new Set<string>()
  const allPosts: XPost[] = []
  for (const p of first.posts) {
    if (seenPostIds.has(p.id)) continue
    seenPostIds.add(p.id)
    allPosts.push(p)
  }

  // Valid = exact|likely after duplicate exclusion (announcement-heavy still counts here)
  let firstValid = 0
  for (const p of first.posts) {
    if (existingIds.has(p.id)) continue
    const rel = scoreXPostRelevance(event, p)
    if (isSaveableRelevance(rel.level)) firstValid += 1
  }

  let secondFetchExecuted = false
  let secondFetchCount = 0

  if (
    firstValid < VALID_MIN_FOR_SECOND &&
    first.nextToken &&
    allPosts.length < MAX_TOTAL_FETCH
  ) {
    const secondMax = Math.min(SECOND_FETCH, MAX_TOTAL_FETCH - allPosts.length)
    if (secondMax >= 10) {
      const second = await searchRecentTweets({
        bearerToken: bearer,
        query,
        maxResults: secondMax,
        startTime,
        nextToken: first.nextToken,
      })
      if (!second.ok) {
        console.error(
          JSON.stringify({
            api_ok: false,
            phase: 'second_fetch',
            http_status: second.status,
            reason: second.reason,
          }),
        )
        process.exit(1)
      }
      secondFetchExecuted = true
      secondFetchCount = second.resultCount
      for (const p of second.posts) {
        if (seenPostIds.has(p.id)) continue
        if (allPosts.length >= MAX_TOTAL_FETCH) break
        seenPostIds.add(p.id)
        allPosts.push(p)
      }
    }
  }

  const totalPostReads = first.resultCount + secondFetchCount
  const cost = estimatePostReadCostUsd(totalPostReads)

  // Analyze all posts
  const plans: XCollectPlanRow[] = allPosts.map((p) =>
    analyzePost(event, p, existingIds),
  )

  const validReactionCount = plans.filter((p) =>
    isSaveableRelevance(p.relevance),
  ).length

  const classificationCounts = {
    experience: 0,
    official: 0,
    media: 0,
    other: 0,
  }
  const relevanceCounts = {
    exact: 0,
    likely: 0,
    weak: 0,
    irrelevant: 0,
  }
  for (const p of plans) {
    classificationCounts[p.classification] += 1
    relevanceCounts[p.relevance] += 1
  }

  // Candidates for quota selection
  const candidates: SelectableXCandidate[] = plans
    .filter((p) => p.decision === 'save')
    .map((p) => ({
      postId: p.postId,
      classification: p.classification,
      relevance: p.relevance,
      selectionScore: p.selectionScore,
      announcementHeavy: p.announcementHeavy,
    }))

  const { selectedIds, filled } = selectWithQuotas(candidates, remainingSlots)

  let duplicateCount = 0
  let savePlanned = 0
  for (const row of plans) {
    if (row.decision === 'skip_duplicate') {
      duplicateCount += 1
      logPlan(row)
      continue
    }
    if (row.decision === 'skip_irrelevant') {
      logPlan(row)
      continue
    }
    // provisional save
    if (remainingSlots <= 0) {
      row.decision = 'skip_cap'
      row.reason = `event_x_cap=${MAX_X_SOURCES_PER_EVENT};existing=${existingCount}`
      row.excerptForReview = null
      logPlan(row)
      continue
    }
    if (!selectedIds.has(row.postId)) {
      row.decision = 'skip_quota'
      row.reason = `not_selected;class=${row.classification};score=${row.selectionScore.toFixed(2)}`
      row.excerptForReview = null
      logPlan(row)
      continue
    }
    row.decision = 'save'
    savePlanned += 1
    logPlan(row)
  }

  console.log(
    JSON.stringify({
      first_fetch_count: first.resultCount,
      first_valid_reaction_count: firstValid,
      second_fetch_executed: secondFetchExecuted,
      second_fetch_count: secondFetchCount,
      total_post_reads: totalPostReads,
      unique_posts_analyzed: allPosts.length,
      valid_reaction_count: validReactionCount,
      estimated_post_read_cost: cost.estimated_display,
      existing_x_sources: existingCount,
      remaining_save_slots: remainingSlots,
      relevance_counts: relevanceCounts,
      classification_counts_all: classificationCounts,
      save_planned: savePlanned,
      save_by_class: filled,
      duplicate_count: duplicateCount,
    }),
  )

  if (DRY_RUN) {
    console.log(`${LOG} dry-run mode — no DB writes`)
    return
  }

  const toWrite = plans.filter((p) => p.decision === 'save')
  if (!toWrite.length) {
    console.log(`${LOG} nothing to write — summary not created`)
    return
  }

  const { summaryId, created } = await ensureDraftSummary(client, event.id)
  console.log(
    JSON.stringify({
      summary_id: summaryId,
      summary_created: created,
      status: 'draft',
    }),
  )

  let written = 0
  for (const row of toWrite) {
    if (!row.excerptForReview) continue
    const { id } = await insertReactionSource(client, {
      eventId: event.id,
      summaryId,
      sourceType: 'x',
      sourceUrl: row.sourceUrl,
      sourceName: row.sourceName,
      observedAt: row.observedAt,
      excerpt: row.excerptForReview,
    })
    written += 1
    console.log(
      JSON.stringify({
        written: true,
        source_id: id,
        summary_id: summaryId,
        event_id: event.id,
        source_type: 'x',
        post_id: row.postId,
        classification: row.classification,
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
