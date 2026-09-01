/**
 * Walkerplus 詳細 JSON を Supabase へ手動 import（Phase 1A / 1B）。
 *
 * - デフォルト DRY_RUN=true（書き込みなし）
 * - DRY_RUN=false のときのみ SUPABASE_SERVICE_ROLE_KEY で書き込み
 * - published の events 本体は絶対に上書きしない
 * - draft のみ新規作成・更新
 * - 自動 publish 禁止
 *
 * 入力: tmp/walkerplus-event-details.json（最大100件）
 *
 * 前提:
 *   scripts/migrate-add-walkerplus-source.sql を Supabase で実行済み
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  matchAgainstExisting,
  formatDedupeLog,
  type DedupeExisting,
  type DuplicateMatchResult,
  type DuplicateStatus,
} from '../src/lib/event-dedupe'
import {
  cleanAddressAccess,
  inferIsFreeFromPriceText,
  resolveAreaSlug,
} from '../src/lib/event-field-rules'
import { normalizeHmToDb } from '../src/lib/event-time-rules'
import { defaultImageMetaForSource } from '../src/lib/event-image-usage'
import {
  ensureEventSource,
  extractWalkerplusEventId,
  type AttachResult,
} from './lib/event-sources'
import {
  buildIncomingPayload,
  upsertDedupeReview,
} from './lib/dedupe-reviews'
import {
  syncFieldReviewsForPublishedEvent,
  type SyncFieldReviewsResult,
} from './lib/field-reviews'
import type { WalkerplusEventDetail } from './lib/walkerplus-detail-extract'
import {
  inferKidsFromWalkerplusCategories,
  mapWalkerplusCategories,
} from './lib/walkerplus-category-map'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'walkerplus' as const
const LOG = '[import-walkerplus]'
const MAX_IMPORT = Math.min(
  Number.parseInt(process.env.WALKERPLUS_IMPORT_MAX ?? '100', 10) || 100,
  100,
)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const detailsPath = path.join(rootDir, 'tmp', 'walkerplus-event-details.json')

type CreatedDraft = {
  event_id: number
  slug: string
  source_event_id: string | null
  title: string
}

type SourceAttach = {
  event_id: number
  slug: string
  source_event_id: string | null
  title: string
  attach_result: AttachResult
}

type Summary = {
  new_drafts: number
  exact_attaches: number
  likely_reviews: number
  ambiguous_reviews: number
  field_reviews: number
  skipped: number
  errors: number
  new_sources: number
  already_attached: number
  created_drafts: CreatedDraft[]
  source_attaches: SourceAttach[]
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function tallyFieldReviews(
  summary: Summary,
  result: SyncFieldReviewsResult,
): void {
  summary.field_reviews += result.created + result.updated
}

async function verifyWalkerplusMigration(
  client: SupabaseClient,
): Promise<void> {
  const { data: sample, error: sampleErr } = await client
    .from('events')
    .select('id')
    .limit(1)
    .maybeSingle()
  if (sampleErr) throw sampleErr
  if (!sample?.id) {
    console.warn(`${LOG} preflight: no events row to probe migration`)
    return
  }

  const probeUrl = `https://seekigo.local/preflight/walkerplus/${Date.now()}`
  const { data: inserted, error: insErr } = await client
    .from('event_sources')
    .insert({
      event_id: Number(sample.id),
      source_name: 'walkerplus',
      source_url: probeUrl,
      source_event_id: '0',
      official_url: null,
      last_checked_at: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle()

  if (insErr) {
    console.error(`${LOG} preflight probe failed:`, {
      code: insErr.code,
      message: insErr.message,
      details: insErr.details,
      hint: insErr.hint,
    })
    if (insErr.code === '23514') {
      throw new Error(
        'walkerplus is not allowed in event_sources CHECK constraint. Run scripts/migrate-add-walkerplus-source.sql in Supabase SQL Editor first.',
      )
    }
    throw insErr
  }

  if (inserted?.id) {
    const { error: delErr } = await client
      .from('event_sources')
      .delete()
      .eq('id', inserted.id)
    if (delErr) throw delErr
  }

  console.log(`${LOG} preflight: walkerplus migration OK`)
}

function createServiceClient(): SupabaseClient {
  const url =
    process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  if (!url) {
    throw new Error('PUBLIC_SUPABASE_URL (or SUPABASE_URL) is missing in .env')
  }
  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is missing in .env (do NOT use PUBLIC_ prefix)',
    )
  }
  if (serviceKey === process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use PUBLIC_SUPABASE_PUBLISHABLE_KEY for writes')
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function generateWalkerplusSlug(
  title: string,
  startDate: string,
  sourceUrl: string,
): string {
  const year = startDate.slice(0, 4)
  const eventId = extractWalkerplusEventId(sourceUrl)
  if (eventId) return `walkerplus-${eventId}-${year}`

  const normalized = title.normalize('NFKC').trim().toLowerCase()
  const hash = createHash('sha1')
    .update(`seekigo:walkerplus:${normalized}:${year}`)
    .digest('hex')
    .slice(0, 12)
  return `walkerplus-${hash}-${year}`
}

async function resolveUniqueSlug(
  client: SupabaseClient,
  baseSlug: string,
  sourceUrl: string,
): Promise<string> {
  const { data, error } = await client
    .from('events')
    .select('id, slug, source_url')
    .eq('slug', baseSlug)
    .maybeSingle()
  if (error) throw error
  if (!data) return baseSlug
  if (data.source_url === sourceUrl) return baseSlug

  const hash = createHash('sha1')
    .update(`seekigo:walkerplus-slug:${sourceUrl}`)
    .digest('hex')
    .slice(0, 8)
  return `${baseSlug}-${hash}`
}

function normalizeArea(area: unknown): string | null {
  if (typeof area !== 'string') return null
  const trimmed = area.trim().toLowerCase()
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null
  if (!/^[a-z0-9-]+$/.test(trimmed)) return null
  return trimmed
}

function resolveImportArea(detail: WalkerplusEventDetail): string | null {
  return (
    resolveAreaSlug({
      areaHint: detail.area_locality,
      address: detail.address,
      venue: detail.venue,
    }) ?? normalizeArea(detail.area_locality)
  )
}

type NewEventRow = {
  title: string
  slug: string
  official_url: string | null
  source_url: string
  venue: string | null
  area: string | null
  address: string | null
  start_date: string
  end_date: string | null
  start_time: string | null
  end_time: string | null
  price_text: string | null
  is_free: boolean | null
  is_indoor: boolean | null
  is_kids: boolean | null
  is_night: boolean | null
  category: string[]
  summary: string | null
  image_url: string | null
  image_usage_status: 'unknown'
  image_source: 'walkerplus' | null
  image_credit: null
  status: 'draft'
  last_checked_at: string
}

function validateNewDraft(
  detail: WalkerplusEventDetail,
  slug: string,
):
  | { ok: true; row: NewEventRow; sourceEventId: string | null }
  | { ok: false; reason: string } {
  if (isBlank(detail.title) || typeof detail.title !== 'string') {
    return { ok: false, reason: 'title is required' }
  }
  if (isBlank(detail.source_url) || typeof detail.source_url !== 'string') {
    return { ok: false, reason: 'source_url is required' }
  }
  if (isBlank(detail.start_date) || typeof detail.start_date !== 'string') {
    return { ok: false, reason: 'start_date is required' }
  }
  if (!isValidYmd(detail.start_date)) {
    return { ok: false, reason: `invalid start_date: ${detail.start_date}` }
  }
  if (detail.end_date != null && detail.end_date !== '') {
    if (typeof detail.end_date !== 'string' || !isValidYmd(detail.end_date)) {
      return { ok: false, reason: `invalid end_date: ${String(detail.end_date)}` }
    }
  }

  const rawCategories =
    detail.categories?.length > 0
      ? detail.categories
      : (detail.list_snapshot?.categories ?? [])
  const { mapped: category } = mapWalkerplusCategories(rawCategories)

  const address =
    cleanAddressAccess(detail.address) ??
    (typeof detail.address === 'string' ? detail.address.trim() || null : null)
  const area = resolveImportArea(detail)
  const is_free = inferIsFreeFromPriceText(detail.price_text)
  const is_kids = inferKidsFromWalkerplusCategories(rawCategories)
  const now = new Date().toISOString()

  const imageMeta = detail.image_url
    ? defaultImageMetaForSource('walkerplus')
    : {
        image_usage_status: 'unknown' as const,
        image_source: null,
        image_credit: null,
      }

  return {
    ok: true,
    sourceEventId: extractWalkerplusEventId(detail.source_url),
    row: {
      title: detail.title.trim(),
      slug,
      official_url: detail.official_url ?? null,
      source_url: detail.source_url.trim(),
      venue: detail.venue ?? null,
      area,
      address,
      start_date: detail.start_date,
      end_date: detail.end_date ?? null,
      start_time: normalizeHmToDb(detail.start_time) ?? null,
      end_time: normalizeHmToDb(detail.end_time) ?? null,
      price_text: detail.price_text ?? null,
      is_free,
      is_indoor: null,
      is_kids,
      is_night: null,
      category,
      summary: null,
      image_url: detail.image_url ?? null,
      image_usage_status: 'unknown',
      image_source: detail.image_url ? 'walkerplus' : null,
      image_credit: null,
      status: 'draft',
      last_checked_at: now,
    },
  }
}

function tallyAttach(summary: Summary, result: AttachResult) {
  if (result === 'new_source') summary.new_sources += 1
  else summary.already_attached += 1
}

function toDedupeItem(
  detail: WalkerplusEventDetail,
  match: DuplicateMatchResult,
) {
  return {
    title: detail.title,
    start_date: detail.start_date,
    end_date: detail.end_date,
    venue: detail.venue,
    official_url: detail.official_url,
    source_url: detail.source_url,
    duplicate_status: match.duplicate_status,
    matched_event_slug: match.matched_event_slug,
    matched_event_id: match.matched_event_id,
    matched_title: match.matched_title,
    matched_status: match.matched_status,
    duplicate_reason: match.duplicate_reason,
    confidence: match.confidence,
    recommended_action: match.recommended_action,
    scores: match.scores,
    review_payload: match.review_payload,
  }
}

function logDedupeItem(
  item: ReturnType<typeof toDedupeItem>,
  action?: string,
) {
  for (const line of formatDedupeLog({
    status: item.duplicate_status,
    incomingTitle: item.title,
    match: {
      duplicate_status: item.duplicate_status,
      matched_event_slug: item.matched_event_slug,
      matched_event_id: item.matched_event_id,
      matched_title: item.matched_title,
      matched_status: item.matched_status,
      duplicate_reason: item.duplicate_reason,
      confidence: item.confidence,
      recommended_action:
        item.recommended_action ??
        (item.duplicate_status === 'exact'
          ? 'attach_source_only'
          : item.duplicate_status === 'none'
            ? 'create_draft'
            : 'review_required'),
      scores: item.scores,
      review_payload: item.review_payload,
    },
    action,
  })) {
    console.log(`${LOG} ${line}`)
  }
}

async function loadExistingPool(
  client: SupabaseClient,
): Promise<DedupeExisting[]> {
  const { data, error } = await client
    .from('events')
    .select(
      'id, slug, title, start_date, end_date, venue, area, official_url, source_url, status',
    )
  if (error) throw error

  const { data: sources, error: srcErr } = await client
    .from('event_sources')
    .select('event_id, source_url')
  if (srcErr) throw srcErr

  const alts = new Map<number, string[]>()
  for (const s of sources ?? []) {
    const id = Number(s.event_id)
    if (!Number.isFinite(id) || !s.source_url) continue
    const list = alts.get(id) ?? []
    list.push(String(s.source_url))
    alts.set(id, list)
  }

  return (data ?? []).map((row) => ({
    id: row.id ?? null,
    slug: String(row.slug),
    title: row.title ?? null,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    venue: row.venue ?? null,
    area: row.area ?? null,
    official_url: row.official_url ?? null,
    source_url: row.source_url ?? null,
    status: row.status ?? null,
    alternate_source_urls: alts.get(Number(row.id)) ?? null,
  }))
}

async function updateDraftBody(
  supabase: SupabaseClient,
  eventId: number,
  row: NewEventRow,
): Promise<void> {
  const { data: existing, error: selErr } = await supabase
    .from('events')
    .select('id, image_url')
    .eq('id', eventId)
    .eq('status', 'draft')
    .maybeSingle()
  if (selErr) throw selErr
  if (!existing) return

  const imageChanged =
    (existing.image_url ?? null) !== (row.image_url ?? null)

  const patch: Record<string, unknown> = {
    title: row.title,
    official_url: row.official_url,
    source_url: row.source_url,
    venue: row.venue,
    address: row.address,
    start_date: row.start_date,
    end_date: row.end_date,
    start_time: row.start_time,
    end_time: row.end_time,
    price_text: row.price_text,
    category: row.category,
    image_url: row.image_url,
    last_checked_at: row.last_checked_at,
    updated_at: new Date().toISOString(),
  }

  if (row.area) patch.area = row.area
  if (row.is_free !== null) patch.is_free = row.is_free
  if (row.is_kids !== null) patch.is_kids = row.is_kids
  if (imageChanged) {
    patch.image_usage_status = 'unknown'
    patch.image_credit = null
    if (row.image_url) patch.image_source = 'walkerplus'
  }

  const { error } = await supabase
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .eq('status', 'draft')

  if (error) throw error
}

function rawCategories(detail: WalkerplusEventDetail): string[] {
  if (detail.categories?.length) return detail.categories
  return detail.list_snapshot?.categories ?? []
}

async function main() {
  console.log(`${LOG} start (Phase 1B)`)
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} max import: ${MAX_IMPORT}`)
  console.log(`${LOG} AI: unused`)
  console.log(`${LOG} summary: not copied from Walkerplus body (null)`)
  console.log(
    `${LOG} published bodies are never overwritten; event_sources is idempotent`,
  )

  let detailsFile: { events?: WalkerplusEventDetail[] }
  try {
    detailsFile = JSON.parse(
      await readFile(detailsPath, 'utf8'),
    ) as { events?: WalkerplusEventDetail[] }
  } catch (error) {
    console.error(
      `${LOG} failed to read tmp/walkerplus-event-details.json — run fetch-walkerplus-details.ts first`,
      error,
    )
    process.exit(1)
  }

  const details = (detailsFile.events ?? []).slice(0, MAX_IMPORT)
  if (details.length === 0) {
    console.error(`${LOG} no events in details JSON`)
    process.exit(1)
  }

  const writeClient = DRY_RUN ? null : createServiceClient()
  let readClient: SupabaseClient | null = null
  try {
    readClient = createServiceClient()
  } catch (error) {
    console.error(`${LOG} cannot connect to Supabase for dedupe:`, error)
    process.exit(1)
  }

  if (DRY_RUN) {
    console.log(`${LOG} dry-run mode — no DB writes (set DRY_RUN=false to write)`)
  } else {
    console.log(`${LOG} using SUPABASE_SERVICE_ROLE_KEY for writes`)
    await verifyWalkerplusMigration(writeClient!)
  }

  const pool = await loadExistingPool(readClient)
  console.log(`${LOG} existing pool: ${pool.length} event(s)`)

  const summary: Summary = {
    new_drafts: 0,
    exact_attaches: 0,
    likely_reviews: 0,
    ambiguous_reviews: 0,
    field_reviews: 0,
    skipped: 0,
    errors: 0,
    new_sources: 0,
    already_attached: 0,
    created_drafts: [],
    source_attaches: [],
  }

  for (let i = 0; i < details.length; i++) {
    const detail = details[i]
    const label = `${i + 1}/${details.length}`
    console.log(`${LOG} ---- ${label} ----`)

    if (!detail.source_url) {
      summary.skipped += 1
      console.log(`${LOG} skipped: missing source_url`)
      continue
    }

    const match = matchAgainstExisting(
      {
        title: detail.title,
        start_date: detail.start_date,
        end_date: detail.end_date,
        venue: detail.venue,
        official_url: detail.official_url,
        source_url: detail.source_url,
        area: detail.area_locality,
      },
      pool,
    )

    const item = toDedupeItem(detail, match)
    const status: DuplicateStatus = match.duplicate_status
    const catsRaw = rawCategories(detail)
    const { mapped: categoryMapped } = mapWalkerplusCategories(catsRaw)

    const sourcePayload = (eventId: number) => ({
      event_id: eventId,
      source_name: SOURCE_NAME,
      source_url: detail.source_url!,
      source_event_id: extractWalkerplusEventId(detail.source_url),
      official_url: detail.official_url ?? null,
      last_checked_at: new Date().toISOString(),
    })

    if (status === 'likely') {
      summary.likely_reviews += 1
      logDedupeItem(item, 'review_required')
      try {
        await upsertDedupeReview(
          readClient,
          {
            incoming_source_name: SOURCE_NAME,
            incoming_source_url: detail.source_url,
            incoming_payload: buildIncomingPayload({
              sourceName: SOURCE_NAME,
              title: detail.title,
              start_date: detail.start_date,
              end_date: detail.end_date,
              start_time: detail.start_time ?? null,
              end_time: detail.end_time ?? null,
              venue: detail.venue,
              area: resolveImportArea(detail),
              official_url: detail.official_url,
              source_url: detail.source_url,
              price_text: detail.price_text ?? null,
              is_free: inferIsFreeFromPriceText(detail.price_text),
              address: detail.address ?? null,
              category: categoryMapped,
              summary: null,
              image_url: detail.image_url ?? null,
              walkerplus_categories_raw: catsRaw,
            }),
            candidate_event_id:
              match.matched_event_id != null
                ? Number(match.matched_event_id)
                : null,
            duplicate_status: 'likely',
            reason: match.duplicate_reason,
            scores: (match.scores as Record<string, unknown>) ?? null,
          },
          Boolean(writeClient),
          LOG,
        )
      } catch (error) {
        summary.errors += 1
        console.error(
          `${LOG} likely review failed:`,
          error instanceof Error ? error.message : error,
        )
      }
      continue
    }

    if (status === 'ambiguous') {
      summary.ambiguous_reviews += 1
      logDedupeItem(item, 'review_required')
      try {
        await upsertDedupeReview(
          readClient,
          {
            incoming_source_name: SOURCE_NAME,
            incoming_source_url: detail.source_url,
            incoming_payload: buildIncomingPayload({
              sourceName: SOURCE_NAME,
              title: detail.title,
              start_date: detail.start_date,
              end_date: detail.end_date,
              start_time: detail.start_time ?? null,
              end_time: detail.end_time ?? null,
              venue: detail.venue,
              area: resolveImportArea(detail),
              official_url: detail.official_url,
              source_url: detail.source_url,
              price_text: detail.price_text ?? null,
              is_free: inferIsFreeFromPriceText(detail.price_text),
              address: detail.address ?? null,
              category: categoryMapped,
              summary: null,
              image_url: detail.image_url ?? null,
              walkerplus_categories_raw: catsRaw,
            }),
            candidate_event_id:
              match.matched_event_id != null
                ? Number(match.matched_event_id)
                : null,
            duplicate_status: 'ambiguous',
            reason: match.duplicate_reason,
            scores: (match.scores as Record<string, unknown>) ?? null,
          },
          Boolean(writeClient),
          LOG,
        )
      } catch (error) {
        summary.errors += 1
        console.error(
          `${LOG} ambiguous review failed:`,
          error instanceof Error ? error.message : error,
        )
      }
      continue
    }

    if (status === 'exact') {
      summary.exact_attaches += 1
      logDedupeItem(item, 'attach_source_only')

      if (!match.matched_event_slug && match.matched_event_id == null) {
        summary.errors += 1
        console.error(`${LOG} exact but matched_event_slug/id is null`)
        continue
      }

      try {
        let existing:
          | { id: number | string; slug: string; status: string | null }
          | null = null

        if (match.matched_event_id != null) {
          const { data, error } = await readClient
            .from('events')
            .select('id, slug, status')
            .eq('id', match.matched_event_id)
            .maybeSingle()
          if (error) throw error
          existing = data
        }

        if (!existing && match.matched_event_slug) {
          const { data, error } = await readClient
            .from('events')
            .select('id, slug, status')
            .eq('slug', match.matched_event_slug)
            .maybeSingle()
          if (error) throw error
          existing = data
        }

        if (!existing) {
          summary.errors += 1
          console.error(
            `${LOG} matched event not found: id=${match.matched_event_id} slug=${match.matched_event_slug}`,
          )
          continue
        }

        const eventId = Number(existing.id)
        console.log(
          `${LOG} existing event_id=${eventId} status=${existing.status} (body not overwritten)`,
        )

        if (existing.status === 'published') {
          try {
            const area = resolveImportArea(detail)
            const frResult = await syncFieldReviewsForPublishedEvent(
              writeClient ?? readClient,
              {
                eventId,
                eventStatus: 'published',
                sourceName: SOURCE_NAME,
                sourceUrl: detail.source_url,
                proposed: {
                  start_date: detail.start_date ?? null,
                  end_date: detail.end_date ?? null,
                  start_time: normalizeHmToDb(detail.start_time) ?? null,
                  end_time: normalizeHmToDb(detail.end_time) ?? null,
                  venue: detail.venue ?? null,
                  area,
                  address: detail.address ?? null,
                  price_text: detail.price_text ?? null,
                  is_free: inferIsFreeFromPriceText(detail.price_text),
                  category: categoryMapped,
                  official_url: detail.official_url ?? null,
                },
                write: Boolean(writeClient),
              },
            )
            tallyFieldReviews(summary, frResult)
          } catch (frErr) {
            const message =
              frErr instanceof Error ? frErr.message : String(frErr)
            console.error(`${LOG} field-review failed: ${message}`)
          }
        }

        const result = await ensureEventSource(
          writeClient ?? readClient,
          sourcePayload(eventId),
          Boolean(writeClient),
          LOG,
        )
        tallyAttach(summary, result)
        summary.source_attaches.push({
          event_id: eventId,
          slug: existing.slug,
          source_event_id: extractWalkerplusEventId(detail.source_url),
          title: detail.title ?? existing.slug,
          attach_result: result,
        })
      } catch (error) {
        summary.errors += 1
        console.error(
          `${LOG} exact attach failed:`,
          error instanceof Error ? error.message : error,
        )
      }
      continue
    }

    if (status === 'none') {
      logDedupeItem(item, 'create_draft')

      const baseSlug = generateWalkerplusSlug(
        detail.title ?? 'event',
        detail.start_date ?? '1970-01-01',
        detail.source_url,
      )

      let slug = baseSlug
      if (readClient) {
        slug = await resolveUniqueSlug(readClient, baseSlug, detail.source_url)
      }

      const validated = validateNewDraft(detail, slug)
      if (!validated.ok) {
        summary.skipped += 1
        console.log(`${LOG} skipped: ${validated.reason}`)
        continue
      }

      console.log(`${LOG} slug: ${validated.row.slug}`)
      console.log(
        `${LOG} dates: ${validated.row.start_date} ~ ${validated.row.end_date ?? 'null'}`,
      )
      console.log(`${LOG} categories: ${validated.row.category.join(', ')}`)
      console.log(
        `${LOG} walkerplus_categories_raw: ${catsRaw.join(', ') || '(none)'}`,
      )

      if (DRY_RUN) {
        summary.new_drafts += 1
        summary.new_sources += 1
        console.log(`${LOG} status: draft (planned insert)`)
        continue
      }

      if (!writeClient) {
        summary.errors += 1
        continue
      }

      try {
        const { data: existingSlug, error: selErr } = await writeClient
          .from('events')
          .select('id, status, source_url')
          .eq('slug', validated.row.slug)
          .maybeSingle()
        if (selErr) throw selErr

        if (existingSlug) {
          const eventId = Number(existingSlug.id)
          const existingStatus = existingSlug.status ?? null

          if (existingStatus === 'published') {
            console.log(
              `${LOG} published protected id=${eventId} — body not overwritten`,
            )
          } else if (existingStatus === 'draft') {
            await updateDraftBody(writeClient, eventId, validated.row)
            console.log(`${LOG} draft updated id=${eventId}`)
          }

          const result = await ensureEventSource(
            writeClient,
            sourcePayload(eventId),
            true,
            LOG,
          )
          tallyAttach(summary, result)
          summary.source_attaches.push({
            event_id: eventId,
            slug: validated.row.slug,
            source_event_id: validated.sourceEventId,
            title: validated.row.title,
            attach_result: result,
          })
          continue
        }

        const { data: inserted, error: insErr } = await writeClient
          .from('events')
          .insert(validated.row)
          .select('id')
          .single()
        if (insErr) throw insErr
        if (!inserted?.id) throw new Error('insert returned no id')

        const eventId = Number(inserted.id)
        try {
          const result = await ensureEventSource(
            writeClient,
            sourcePayload(eventId),
            true,
            LOG,
          )
          summary.new_drafts += 1
          tallyAttach(summary, result)
          summary.created_drafts.push({
            event_id: eventId,
            slug: validated.row.slug,
            source_event_id: validated.sourceEventId,
            title: validated.row.title,
          })
          summary.source_attaches.push({
            event_id: eventId,
            slug: validated.row.slug,
            source_event_id: validated.sourceEventId,
            title: validated.row.title,
            attach_result: result,
          })
          console.log(
            `${LOG} insert ok: id=${eventId} slug=${validated.row.slug}`,
          )
        } catch (attachErr) {
          summary.errors += 1
          console.error(
            `${LOG} source attach failed after draft insert id=${eventId} — re-run after migration to attach:`,
            attachErr instanceof Error ? attachErr.message : attachErr,
          )
        }
      } catch (error) {
        summary.errors += 1
        console.error(
          `${LOG} draft insert failed:`,
          error instanceof Error ? error.message : error,
        )
      }
      continue
    }

    summary.skipped += 1
    console.log(`${LOG} unknown duplicate_status: ${String(status)}`)
  }

  console.log(`${LOG} ---- summary ----`)
  console.log(`${LOG} created drafts: ${summary.new_drafts}`)
  console.log(`${LOG} exact attaches: ${summary.exact_attaches}`)
  console.log(`${LOG} likely reviews: ${summary.likely_reviews}`)
  console.log(`${LOG} ambiguous reviews: ${summary.ambiguous_reviews}`)
  console.log(`${LOG} field reviews: ${summary.field_reviews}`)
  console.log(`${LOG} skipped: ${summary.skipped}`)
  console.log(`${LOG} errors: ${summary.errors}`)
  console.log(`${LOG} new_sources: ${summary.new_sources}`)
  console.log(`${LOG} already_attached: ${summary.already_attached}`)

  if (summary.created_drafts.length > 0) {
    console.log(`${LOG} ---- created drafts ----`)
    for (const row of summary.created_drafts) {
      console.log(
        `${LOG} id=${row.event_id} slug=${row.slug} source_event_id=${row.source_event_id ?? 'null'} title=${row.title}`,
      )
    }
  }

  if (summary.source_attaches.length > 0) {
    console.log(`${LOG} ---- source attaches ----`)
    for (const row of summary.source_attaches) {
      console.log(
        `${LOG} event_id=${row.event_id} slug=${row.slug} source_event_id=${row.source_event_id ?? 'null'} result=${row.attach_result} title=${row.title}`,
      )
    }
  }
  console.log(
    `${LOG} done (${DRY_RUN ? 'dry-run, no DB write' : 'write mode'})`,
  )
}

main().catch((error) => {
  console.error(`${LOG} unexpected error:`, error)
  process.exit(1)
})
