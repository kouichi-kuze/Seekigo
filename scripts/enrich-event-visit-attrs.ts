/**
 * Seekigo Phase 4C-4: enrich visit attrs from official / source pages.
 *
 * Usage (PowerShell):
 *   $env:EVENT_ID="42"
 *   $env:DRY_RUN="true"
 *   npm run enrich:event-visit
 *
 * Optional:
 *   $env:AI_DRY_RUN_NO_API="true"   # skip OpenAI
 *   $env:DRY_RUN="false"            # write field reviews / draft high-confidence
 *
 * Never auto-fetches Walkerplus listing URLs.
 * Never overwrites published events directly.
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { assistVisitAttrsWithAi } from './lib/visit-enrich/ai-assist'
import { extractAllDeterministic } from './lib/visit-enrich/extract'
import { extractFromJsonLd } from './lib/visit-enrich/jsonld'
import {
  mergeProposals,
  proposalsToFieldSnapshot,
  selectWritableProposals,
} from './lib/visit-enrich/merge'
import { fetchEnrichPages, loadCandidateUrls } from './lib/visit-enrich/sources'
import type {
  VisitEnrichEventRow,
  VisitFieldProposal,
} from './lib/visit-enrich/types'
import { syncFieldReviewsForPublishedEvent } from './lib/field-reviews'

config()

const LOG = '[enrich-event-visit]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const EVENT_ID = Number(process.env.EVENT_ID ?? '')

const EVENT_SELECT = [
  'id',
  'title',
  'status',
  'official_url',
  'source_url',
  'price_text',
  'is_free',
  'price_min',
  'price_max',
  'address',
  'venue',
  'category',
  'reservation_status',
  'reservation_url',
  'nearest_station',
  'walk_minutes',
  'access_text',
  'venue_type',
  'family_friendly',
  'date_friendly',
  'solo_friendly',
  'rain_friendly',
  'age_note',
  'duration_minutes_min',
  'duration_minutes_max',
  'parking_status',
  'parking_text',
].join(', ')

function createServiceClient(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
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

function log(obj: Record<string, unknown>) {
  console.log(JSON.stringify(obj, null, 2))
}

async function loadEvent(
  client: SupabaseClient,
  eventId: number,
): Promise<VisitEnrichEventRow> {
  const { data, error } = await client
    .from('events')
    .select(EVENT_SELECT)
    .eq('id', eventId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) throw new Error(`event ${eventId} not found`)
  const row = data as Record<string, unknown>
  return {
    id: Number(row.id),
    title: (row.title as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    official_url: (row.official_url as string | null) ?? null,
    source_url: (row.source_url as string | null) ?? null,
    price_text: (row.price_text as string | null) ?? null,
    is_free:
      row.is_free === true || row.is_free === false ? row.is_free : null,
    price_min: (row.price_min as number | null) ?? null,
    price_max: (row.price_max as number | null) ?? null,
    address: (row.address as string | null) ?? null,
    venue: (row.venue as string | null) ?? null,
    category: Array.isArray(row.category) ? (row.category as string[]) : null,
    reservation_status: (row.reservation_status as string | null) ?? null,
    reservation_url: (row.reservation_url as string | null) ?? null,
    nearest_station: (row.nearest_station as string | null) ?? null,
    walk_minutes: (row.walk_minutes as number | null) ?? null,
    access_text: (row.access_text as string | null) ?? null,
    venue_type: (row.venue_type as string | null) ?? null,
    family_friendly: (row.family_friendly as string | null) ?? null,
    date_friendly: (row.date_friendly as string | null) ?? null,
    solo_friendly: (row.solo_friendly as string | null) ?? null,
    rain_friendly: (row.rain_friendly as string | null) ?? null,
    age_note: (row.age_note as string | null) ?? null,
    duration_minutes_min: (row.duration_minutes_min as number | null) ?? null,
    duration_minutes_max: (row.duration_minutes_max as number | null) ?? null,
    parking_status: (row.parking_status as string | null) ?? null,
    parking_text: (row.parking_text as string | null) ?? null,
  }
}

function summarizeProposals(list: VisitFieldProposal[]) {
  return list.map((p) => ({
    field: p.field,
    proposed_value: p.proposed_value,
    confidence: p.confidence,
    method: p.method,
    reason: p.reason,
    evidence_text: p.evidence_text,
    source_url: p.source_url,
  }))
}

async function applyDraftHighConfidence(
  client: SupabaseClient,
  event: VisitEnrichEventRow,
  proposals: VisitFieldProposal[],
  write: boolean,
): Promise<number> {
  if (event.status !== 'draft') return 0
  if (proposals.length === 0) return 0
  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  }
  for (const p of proposals) {
    if (p.confidence !== 'high') continue
    patch[p.field] = p.proposed_value
  }
  const keys = Object.keys(patch).filter((k) => k !== 'updated_at')
  if (keys.length === 0) return 0
  if (!write) {
    console.log(`${LOG} draft_apply_planned fields=${keys.join(',')}`)
    return keys.length
  }
  const { error } = await client.from('events').update(patch).eq('id', event.id)
  if (error) throw error
  console.log(`${LOG} draft_applied fields=${keys.join(',')}`)
  return keys.length
}

async function main() {
  if (!Number.isFinite(EVENT_ID) || EVENT_ID <= 0) {
    throw new Error('EVENT_ID must be a positive integer')
  }

  const client = createServiceClient()
  const event = await loadEvent(client, EVENT_ID)

  const candidates = await loadCandidateUrls(client, EVENT_ID, event)
  const pages = await fetchEnrichPages(candidates)

  const allProposals: VisitFieldProposal[] = []
  const excerpts: string[] = []

  for (const page of pages) {
    if (!page.meta.ok) continue
    allProposals.push(...extractFromJsonLd(page.jsonLd, page.meta.finalUrl))
    allProposals.push(
      ...extractAllDeterministic({
        text: page.plainText,
        sourceUrl: page.meta.finalUrl,
        category: event.category,
      }),
    )
    if (page.excerpt) excerpts.push(page.excerpt)
  }

  // Prefer official page excerpt for AI
  const officialPage = pages.find(
    (p) => p.meta.ok && (p.meta.role === 'official' || p.meta.role === 'reaction_official'),
  )
  const primaryExcerpt =
    officialPage?.excerpt ||
    pages.find((p) => p.meta.ok)?.excerpt ||
    ''

  const mergedBeforeAi = mergeProposals(allProposals)
  const detSummary = mergedBeforeAi
    .map((p) => `${p.field}=${JSON.stringify(p.proposed_value)}(${p.confidence})`)
    .join('; ')

  const ai = await assistVisitAttrsWithAi({
    title: event.title ?? '',
    sourceUrl: officialPage?.meta.finalUrl ?? event.official_url,
    excerpt: primaryExcerpt,
    deterministicSummary: detSummary || '(none)',
  })

  const merged = mergeProposals([...allProposals, ...ai.proposals])
  const { forReview, forDraftApply, skipped } = selectWritableProposals(
    event,
    merged,
  )

  const existingCompare = merged.map((p) => ({
    field: p.field,
    proposed: p.proposed_value,
    current: (event as Record<string, unknown>)[p.field] ?? null,
    confidence: p.confidence,
  }))

  const wouldWriteReviews =
    (event.status === 'published' || event.status === 'hidden') &&
    forReview.some((p) => p.confidence === 'high' || p.confidence === 'medium')
  const wouldWriteDraft =
    event.status === 'draft' && forDraftApply.length > 0
  const writePlanned = wouldWriteReviews || wouldWriteDraft

  log({
    event_id: event.id,
    title: event.title,
    status: event.status,
    source_url: event.source_url,
    official_url: event.official_url,
    dry_run: DRY_RUN,
    write_planned: writePlanned,
    write_blocked_by_dry_run: DRY_RUN && writePlanned,
    fetched_sources: pages.map((p) => ({
      role: p.meta.role,
      url: p.meta.url,
      finalUrl: p.meta.finalUrl,
      ok: p.meta.ok,
      skipped: p.meta.skipped ?? false,
      reason: p.meta.reason ?? null,
      htmlLength: p.meta.htmlLength ?? null,
      excerptChars: p.excerpt.length,
      jsonLdBlocks: p.jsonLd.length,
    })),
    extracted_fields: summarizeProposals(allProposals),
    proposed_fields: summarizeProposals(merged),
    existing_compare: existingCompare,
    skipped,
    openai: {
      model: ai.model,
      skippedReason: ai.skippedReason ?? null,
      inputChars: ai.inputChars,
      estimatedCostUsd: ai.estimatedCostUsd,
      aiProposalCount: ai.proposals.length,
    },
  })

  if (DRY_RUN) {
    console.log(`${LOG} DRY_RUN complete — no DB write`)
    return
  }

  // published / hidden → field reviews only（本体は直接 update しない）
  if (event.status === 'published' || event.status === 'hidden') {
    const proposed = proposalsToFieldSnapshot(
      forReview.filter(
        (p) => p.confidence === 'high' || p.confidence === 'medium',
      ),
    )
    const primaryUrl =
      officialPage?.meta.finalUrl ??
      event.official_url ??
      pages.find((p) => p.meta.ok)?.meta.finalUrl ??
      null

    const fr = await syncFieldReviewsForPublishedEvent(client, {
      eventId: event.id,
      eventStatus: event.status,
      sourceName: 'official_web',
      sourceUrl: primaryUrl,
      proposed,
      write: true,
    })
    console.log(`${LOG} field_reviews`, fr)
  } else if (event.status === 'draft') {
    await applyDraftHighConfidence(client, event, forDraftApply, true)
  } else {
    console.log(`${LOG} status=${event.status} — no write path`)
  }
}

main().catch((err) => {
  console.error(LOG, err instanceof Error ? err.message : err)
  process.exit(1)
})
