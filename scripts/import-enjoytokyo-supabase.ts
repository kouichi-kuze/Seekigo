/**
 * EnjoyTokyo 詳細 + 重複判定結果を Supabase へ反映する（AI不使用）。
 *
 * - デフォルト DRY_RUN=true（書き込みなし）
 * - DRY_RUN=false のときのみ SUPABASE_SERVICE_ROLE_KEY で書き込み
 * - published の events 本体は絶対に上書きしない
 * - draft は新規作成・更新を許可
 * - event_sources は冪等（既存なら already_attached、last_checked_at のみ更新可）
 *
 * 入力:
 *   tmp/enjoytokyo-dedupe-results.json
 *   tmp/enjoytokyo-event-details.json
 *
 * 前提: public.event_sources が作成済み（scripts/create-event-sources.sql）
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { DuplicateMatchResult, DuplicateStatus } from '../src/lib/event-dedupe'
import { formatDedupeLog } from '../src/lib/event-dedupe'
import {
  cleanAddressAccess,
  inferIsFreeFromPriceText,
  resolveAreaSlug,
} from '../src/lib/event-field-rules'
import { normalizeHmToDb } from '../src/lib/event-time-rules'
import { defaultImageMetaForSource } from '../src/lib/event-image-usage'
import { isBodyProtectedFromSync } from '../src/lib/event-status'
import {
  ensureEventSource,
  extractEnjoytokyoEventId,
  type AttachResult,
} from './lib/event-sources'
import {
  buildIncomingPayload,
  upsertDedupeReview,
} from './lib/dedupe-reviews'
import { syncFieldReviewsForPublishedEvent } from './lib/field-reviews'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'enjoytokyo' as const
const LOG = '[import-enjoytokyo]'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const dedupePath = path.join(tmpDir, 'enjoytokyo-dedupe-results.json')
const detailsPath = path.join(tmpDir, 'enjoytokyo-event-details.json')

type EnjoyDetail = {
  title: string | null
  description?: string | null
  start_date: string | null
  end_date: string | null
  start_time?: string | null
  end_time?: string | null
  venue: string | null
  area?: string | null
  address?: string | null
  price_text?: string | null
  official_url: string | null
  image_url?: string | null
  source_url: string | null
  error?: string | null
}

type DedupeResult = {
  title: string | null
  start_date: string | null
  end_date: string | null
  venue: string | null
  official_url: string | null
  source_url: string | null
  duplicate_status: DuplicateStatus
  matched_event_slug: string | null
  matched_event_id?: string | number | null
  matched_title?: string | null
  matched_status?: string | null
  duplicate_reason: string
  confidence: number
  recommended_action?: DuplicateMatchResult['recommended_action']
  scores?: DuplicateMatchResult['scores']
  review_payload?: DuplicateMatchResult['review_payload']
}

type DedupeFile = {
  results?: DedupeResult[]
}

type DetailsFile = {
  events?: EnjoyDetail[]
}

type Summary = {
  new_events: number
  new_sources: number
  already_attached: number
  review_required: number
  skipped: number
  failed: number
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
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
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

function generateEnjoytokyoSlug(
  title: string,
  startDate: string,
  sourceUrl: string,
): string {
  const year = startDate.slice(0, 4)
  const eventId = extractEnjoytokyoEventId(sourceUrl)
  if (eventId) {
    return `enjoytokyo-${eventId}-${year}`
  }

  const normalized = title.normalize('NFKC').trim().toLowerCase()
  const hash = createHash('sha1')
    .update(`seekigo:enjoytokyo:${normalized}:${year}`)
    .digest('hex')
    .slice(0, 12)
  return `enjoytokyo-${hash}-${year}`
}

function normalizeArea(area: unknown): string | null {
  if (typeof area !== 'string') return null
  const trimmed = area.trim().toLowerCase()
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null
  if (!/^[a-z0-9-]+$/.test(trimmed)) return null
  return trimmed
}

/** 日本語 area / address / venue から slug を決定（AI より優先） */
function resolveImportArea(detail: {
  area?: string | null
  address?: string | null
  venue?: string | null
}): string | null {
  return (
    resolveAreaSlug({
      areaHint: detail.area,
      address: detail.address,
      venue: detail.venue,
    }) ?? normalizeArea(detail.area)
  )
}

function summaryFromDescription(
  description: string | null | undefined,
): string | null {
  if (!description) return null
  const text = description.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 200 ? `${text.slice(0, 197)}…` : text
}

function buildDetailMap(details: EnjoyDetail[]): Map<string, EnjoyDetail> {
  const map = new Map<string, EnjoyDetail>()
  for (const d of details) {
    if (d.source_url) map.set(d.source_url, d)
  }
  return map
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
  image_usage_status?: string | null
  image_source?: string | null
  image_credit?: string | null
  status: 'draft'
  last_checked_at: string
}

function validateNewDraft(
  detail: EnjoyDetail,
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

  const now = new Date().toISOString()
  const slug = generateEnjoytokyoSlug(
    detail.title,
    detail.start_date,
    detail.source_url,
  )

  const address =
    cleanAddressAccess(detail.address) ??
    (typeof detail.address === 'string' ? detail.address.trim() || null : null)
  const area = resolveImportArea({
    area: detail.area,
    address,
    venue: detail.venue,
  })
  const is_free = inferIsFreeFromPriceText(detail.price_text)

  return {
    ok: true,
    sourceEventId: extractEnjoytokyoEventId(detail.source_url),
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
      is_kids: null,
      is_night: null,
      category: [],
      summary: summaryFromDescription(detail.description),
      image_url: detail.image_url ?? null,
      ...(detail.image_url
        ? defaultImageMetaForSource('enjoytokyo')
        : {
            image_usage_status: 'unknown' as const,
            image_source: null,
            image_credit: null,
          }),
      status: 'draft',
      last_checked_at: now,
    },
  }
}

function tallyAttach(summary: Summary, result: AttachResult) {
  if (result === 'new_source') summary.new_sources += 1
  else summary.already_attached += 1
}

function toMatchResult(item: DedupeResult): DuplicateMatchResult {
  return {
    duplicate_status: item.duplicate_status,
    matched_event_slug: item.matched_event_slug,
    matched_event_id: item.matched_event_id ?? null,
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
  }
}

function logDedupeItem(item: DedupeResult, action?: string) {
  for (const line of formatDedupeLog({
    status: item.duplicate_status,
    incomingTitle: item.title,
    match: toMatchResult(item),
    action,
  })) {
    console.log(`${LOG} ${line}`)
  }
}

/** draft のみ本体更新。published は呼ばないこと。 */
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
    image_url: row.image_url,
    // AI 未実行の summary は description 由来。既存 AI summary を潰さないよう summary は触らない
    last_checked_at: row.last_checked_at,
    updated_at: new Date().toISOString(),
  }

  // deterministic で取れた場合のみ area / is_free を更新（null で AI 結果を消さない）
  if (row.area) patch.area = row.area
  if (row.is_free !== null) patch.is_free = row.is_free
  if (imageChanged) {
    patch.image_usage_status = 'unknown'
    patch.image_credit = null
    if (row.image_url) patch.image_source = row.image_source ?? 'enjoytokyo'
  }

  const { error } = await supabase
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .eq('status', 'draft')

  if (error) throw error
}

async function main() {
  console.log(`${LOG} start`)
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} AI: unused`)
  console.log(
    `${LOG} published bodies are never overwritten; event_sources is idempotent`,
  )

  let dedupeFile: DedupeFile
  let detailsFile: DetailsFile
  try {
    dedupeFile = JSON.parse(await readFile(dedupePath, 'utf8')) as DedupeFile
  } catch (error) {
    console.error(
      `${LOG} failed to read tmp/enjoytokyo-dedupe-results.json — run \`npm run dedupe:enjoytokyo\` first`,
      error,
    )
    process.exit(1)
  }

  try {
    detailsFile = JSON.parse(await readFile(detailsPath, 'utf8')) as DetailsFile
  } catch (error) {
    console.error(
      `${LOG} failed to read tmp/enjoytokyo-event-details.json — run \`npm run fetch:enjoytokyo:details\` first`,
      error,
    )
    process.exit(1)
  }

  const results = dedupeFile.results ?? []
  if (results.length === 0) {
    console.error(`${LOG} no results in dedupe JSON`)
    process.exit(1)
  }

  const detailMap = buildDetailMap(detailsFile.events ?? [])
  const writeClient = DRY_RUN ? null : createServiceClient()
  const readClient =
    writeClient ??
    (() => {
      try {
        return createServiceClient()
      } catch {
        return null
      }
    })()

  if (DRY_RUN) {
    console.log(
      `${LOG} dry-run mode — no DB writes (set DRY_RUN=false to write)`,
    )
  } else {
    console.log(`${LOG} using SUPABASE_SERVICE_ROLE_KEY for writes`)
  }

  const summary: Summary = {
    new_events: 0,
    new_sources: 0,
    already_attached: 0,
    review_required: 0,
    skipped: 0,
    failed: 0,
  }

  for (let i = 0; i < results.length; i++) {
    const item = results[i]
    const detail = item.source_url ? detailMap.get(item.source_url) : undefined
    const label = `${i + 1}/${results.length}`

    if (!item.source_url) {
      summary.skipped += 1
      console.log(`${LOG} ---- ${label} (skipped) ----`)
      console.log(`${LOG} reason: missing source_url`)
      continue
    }

    if (!detail || detail.error) {
      summary.skipped += 1
      console.log(`${LOG} ---- ${label} (skipped) ----`)
      console.log(
        `${LOG} reason: detail missing or error for ${item.source_url}`,
      )
      continue
    }

    const status = item.duplicate_status
    console.log(`${LOG} ---- ${label} ----`)

    if (status === 'likely' || status === 'ambiguous') {
      summary.review_required += 1
      logDedupeItem(item, 'review_required')

      if (readClient) {
        const rawCandidate = Number(item.matched_event_id)
        const candidateId =
          Number.isFinite(rawCandidate) && rawCandidate > 0
            ? rawCandidate
            : null
        try {
          await upsertDedupeReview(
            readClient,
            {
              incoming_source_name: SOURCE_NAME,
              incoming_source_url: detail.source_url!,
              incoming_payload: buildIncomingPayload({
                sourceName: SOURCE_NAME,
                title: detail.title,
                start_date: detail.start_date,
                end_date: detail.end_date,
                start_time: detail.start_time ?? null,
                end_time: detail.end_time ?? null,
                venue: detail.venue,
                area: detail.area ?? null,
                official_url: detail.official_url,
                source_url: detail.source_url,
                price_text: detail.price_text ?? null,
                is_free: inferIsFreeFromPriceText(detail.price_text),
                address: detail.address ?? null,
                category: null,
                summary: summaryFromDescription(detail.description),
                image_url: detail.image_url ?? null,
              }),
              candidate_event_id: candidateId,
              duplicate_status: status,
              reason: item.duplicate_reason,
              scores: item.scores ?? null,
            },
            Boolean(writeClient),
            LOG,
          )
        } catch (error) {
          summary.failed += 1
          const message = error instanceof Error ? error.message : String(error)
          console.error(`${LOG} review upsert failed: ${message}`)
        }
      } else {
        console.log(`${LOG} review not saved (missing DB client)`)
      }
      continue
    }

    const sourcePayload = (eventId: number) => ({
      event_id: eventId,
      source_name: SOURCE_NAME,
      source_url: detail.source_url!,
      source_event_id: extractEnjoytokyoEventId(detail.source_url),
      official_url: detail.official_url ?? null,
      last_checked_at: new Date().toISOString(),
    })

    if (status === 'exact') {
      logDedupeItem(item, 'attach_source_only')

      if (!item.matched_event_slug && item.matched_event_id == null) {
        summary.failed += 1
        console.error(`${LOG} exact but matched_event_slug/id is null`)
        continue
      }

      if (!readClient) {
        summary.skipped += 1
        console.log(
          `${LOG} would attach to slug=${item.matched_event_slug} (no DB client)`,
        )
        continue
      }

      try {
        let existing:
          | { id: number | string; slug: string; status: string | null }
          | null = null

        if (item.matched_event_id != null) {
          const { data, error } = await readClient
            .from('events')
            .select('id, slug, status')
            .eq('id', item.matched_event_id)
            .maybeSingle()
          if (error) throw error
          existing = data
        }

        if (!existing && item.matched_event_slug) {
          const { data, error } = await readClient
            .from('events')
            .select('id, slug, status')
            .eq('slug', item.matched_event_slug)
            .maybeSingle()
          if (error) throw error
          existing = data
        }

        if (!existing) {
          summary.failed += 1
          console.error(
            `${LOG} matched event not found: id=${item.matched_event_id} slug=${item.matched_event_slug}`,
          )
          continue
        }

        const eventId = Number(existing.id)
        console.log(
          `${LOG} existing event_id=${eventId} status=${existing.status} (published/draft body not overwritten)`,
        )

        // published/hidden exact: フィールド差分レビュー（本体は変更しない）
        if (isBodyProtectedFromSync(existing.status)) {
          try {
            const address =
              cleanAddressAccess(detail.address) ??
              (typeof detail.address === 'string'
                ? detail.address.trim() || null
                : null)
            const area = resolveImportArea({
              area: detail.area,
              address,
              venue: detail.venue,
            })
            const is_free = inferIsFreeFromPriceText(detail.price_text)

            await syncFieldReviewsForPublishedEvent(
              writeClient ?? readClient,
              {
                eventId,
                eventStatus: 'published',
                sourceName: SOURCE_NAME,
                sourceUrl: detail.source_url ?? null,
                proposed: {
                  start_date: detail.start_date ?? null,
                  end_date: detail.end_date ?? null,
                  start_time: normalizeHmToDb(detail.start_time) ?? null,
                  end_time: normalizeHmToDb(detail.end_time) ?? null,
                  venue: detail.venue ?? null,
                  area,
                  address,
                  price_text: detail.price_text ?? null,
                  is_free,
                  category: [],
                  official_url: detail.official_url ?? null,
                },
                write: Boolean(writeClient),
              },
            )
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
      } catch (error) {
        summary.failed += 1
        const message = error instanceof Error ? error.message : String(error)
        console.error(`${LOG} exact attach failed: ${message}`)
      }
      continue
    }

    if (status === 'none') {
      logDedupeItem(item, 'create_draft')

      const validated = validateNewDraft(detail)
      if (!validated.ok) {
        summary.skipped += 1
        console.log(`${LOG} skipped: ${validated.reason}`)
        console.log(`${LOG} title: ${detail.title}`)
        continue
      }

      console.log(`${LOG} slug: ${validated.row.slug}`)
      console.log(
        `${LOG} dates: ${validated.row.start_date} ~ ${validated.row.end_date ?? 'null'}`,
      )

      if (!readClient && DRY_RUN) {
        summary.new_events += 1
        summary.new_sources += 1
        console.log(`${LOG} status: draft (planned insert)`)
        continue
      }

      if (!readClient) {
        summary.failed += 1
        console.error(`${LOG} no DB client`)
        continue
      }

      try {
        const { data: existingSlug, error: selErr } = await readClient
          .from('events')
          .select('id, status')
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
            if (writeClient) {
              await updateDraftBody(writeClient, eventId, validated.row)
              console.log(
                `${LOG} draft updated id=${eventId} (status stays draft)`,
              )
            } else {
              console.log(`${LOG} would update draft id=${eventId}`)
            }
          } else {
            console.log(
              `${LOG} existing id=${eventId} status=${existingStatus} — body not overwritten`,
            )
          }

          const result = await ensureEventSource(
            writeClient ?? readClient,
            sourcePayload(eventId),
            Boolean(writeClient),
            LOG,
          )
          tallyAttach(summary, result)
          continue
        }

        // 新規 draft
        if (!writeClient) {
          summary.new_events += 1
          summary.new_sources += 1
          console.log(`${LOG} would insert new draft + source`)
          continue
        }

        const { data: inserted, error: insErr } = await writeClient
          .from('events')
          .insert(validated.row)
          .select('id')
          .single()

        if (insErr) throw insErr
        if (!inserted?.id) throw new Error('insert returned no id')

        const result = await ensureEventSource(
          writeClient,
          sourcePayload(Number(inserted.id)),
          true,
          LOG,
        )
        summary.new_events += 1
        tallyAttach(summary, result)
        console.log(
          `${LOG} insert ok: id=${inserted.id} slug=${validated.row.slug}`,
        )
      } catch (error) {
        summary.failed += 1
        const message = error instanceof Error ? error.message : String(error)
        console.error(`${LOG} none-path failed: ${message}`)
      }
      continue
    }

    summary.skipped += 1
    console.log(`${LOG} ---- ${label} (skipped) ----`)
    console.log(`${LOG} unknown duplicate_status: ${String(status)}`)
  }

  console.log(`${LOG} ---- summary ----`)
  console.log(`${LOG} new_events: ${summary.new_events}`)
  console.log(`${LOG} new_sources: ${summary.new_sources}`)
  console.log(`${LOG} already_attached: ${summary.already_attached}`)
  console.log(`${LOG} review_required: ${summary.review_required}`)
  console.log(`${LOG} skipped: ${summary.skipped}`)
  console.log(`${LOG} failed: ${summary.failed}`)
  console.log(
    `${LOG} done (${DRY_RUN ? 'dry-run, no DB write' : 'write mode'})`,
  )
}

main().catch((error) => {
  console.error(`${LOG} unexpected error:`, error)
  process.exit(1)
})
