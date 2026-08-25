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
import type { DuplicateStatus } from '../src/lib/event-dedupe'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'enjoytokyo' as const

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
  duplicate_reason: string
  confidence: number
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

type SourceRow = {
  event_id: number
  source_name: typeof SOURCE_NAME
  source_url: string
  source_event_id: string | null
  official_url: string | null
  last_checked_at: string
}

type AttachResult = 'new_source' | 'already_attached'

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

function extractEnjoytokyoEventId(
  sourceUrl: string | null | undefined,
): string | null {
  if (!sourceUrl) return null
  const m = sourceUrl.match(/\/event\/(\d+)\/?/i)
  return m?.[1] ?? null
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

  return {
    ok: true,
    sourceEventId: extractEnjoytokyoEventId(detail.source_url),
    row: {
      title: detail.title.trim(),
      slug,
      official_url: detail.official_url ?? null,
      source_url: detail.source_url.trim(),
      venue: detail.venue ?? null,
      area: normalizeArea(detail.area),
      address: detail.address ?? null,
      start_date: detail.start_date,
      end_date: detail.end_date ?? null,
      start_time: detail.start_time ?? null,
      end_time: detail.end_time ?? null,
      price_text: detail.price_text ?? null,
      is_free: null,
      is_indoor: null,
      is_kids: null,
      is_night: null,
      category: [],
      summary: summaryFromDescription(detail.description),
      image_url: detail.image_url ?? null,
      status: 'draft',
      last_checked_at: now,
    },
  }
}

function tallyAttach(summary: Summary, result: AttachResult) {
  if (result === 'new_source') summary.new_sources += 1
  else summary.already_attached += 1
}

/**
 * event_sources を冪等に確保する。
 * 既存: INSERT せず last_checked_at 等のみ更新 → already_attached
 * 新規: INSERT → new_source
 */
async function ensureEventSource(
  client: SupabaseClient,
  row: SourceRow,
  write: boolean,
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
      `[import-enjoytokyo] source already attached: event_id=${row.event_id}`,
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
      `[import-enjoytokyo] new source attached: event_id=${row.event_id}`,
    )
  } else {
    console.log(
      `[import-enjoytokyo] would attach new source: event_id=${row.event_id}`,
    )
  }
  return 'new_source'
}

/** draft のみ本体更新。published は呼ばないこと。 */
async function updateDraftBody(
  supabase: SupabaseClient,
  eventId: number,
  row: NewEventRow,
): Promise<void> {
  const { error } = await supabase
    .from('events')
    .update({
      title: row.title,
      official_url: row.official_url,
      source_url: row.source_url,
      venue: row.venue,
      area: row.area,
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
    })
    .eq('id', eventId)
    .eq('status', 'draft')

  if (error) throw error
}

async function main() {
  console.log('[import-enjoytokyo] start')
  console.log(`[import-enjoytokyo] DRY_RUN: ${DRY_RUN}`)
  console.log('[import-enjoytokyo] AI: unused')
  console.log(
    '[import-enjoytokyo] published bodies are never overwritten; event_sources is idempotent',
  )

  let dedupeFile: DedupeFile
  let detailsFile: DetailsFile
  try {
    dedupeFile = JSON.parse(await readFile(dedupePath, 'utf8')) as DedupeFile
  } catch (error) {
    console.error(
      '[import-enjoytokyo] failed to read tmp/enjoytokyo-dedupe-results.json — run `npm run dedupe:enjoytokyo` first',
      error,
    )
    process.exit(1)
  }

  try {
    detailsFile = JSON.parse(await readFile(detailsPath, 'utf8')) as DetailsFile
  } catch (error) {
    console.error(
      '[import-enjoytokyo] failed to read tmp/enjoytokyo-event-details.json — run `npm run fetch:enjoytokyo:details` first',
      error,
    )
    process.exit(1)
  }

  const results = dedupeFile.results ?? []
  if (results.length === 0) {
    console.error('[import-enjoytokyo] no results in dedupe JSON')
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
      '[import-enjoytokyo] dry-run mode — no DB writes (set DRY_RUN=false to write)',
    )
  } else {
    console.log('[import-enjoytokyo] using SUPABASE_SERVICE_ROLE_KEY for writes')
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
      console.log(`[import-enjoytokyo] ---- ${label} (skipped) ----`)
      console.log('[import-enjoytokyo] reason: missing source_url')
      continue
    }

    if (!detail || detail.error) {
      summary.skipped += 1
      console.log(`[import-enjoytokyo] ---- ${label} (skipped) ----`)
      console.log(
        `[import-enjoytokyo] reason: detail missing or error for ${item.source_url}`,
      )
      continue
    }

    const status = item.duplicate_status

    if (status === 'likely' || status === 'ambiguous') {
      summary.review_required += 1
      console.log(`[import-enjoytokyo] ${status} -> review required`)
      console.log(`[import-enjoytokyo] ---- ${label} ----`)
      console.log(`[import-enjoytokyo] title: ${item.title}`)
      console.log(
        `[import-enjoytokyo] matched_event_slug: ${item.matched_event_slug}`,
      )
      console.log(`[import-enjoytokyo] reason: ${item.duplicate_reason}`)
      console.log(`[import-enjoytokyo] confidence: ${item.confidence}`)
      continue
    }

    const sourcePayload = (eventId: number): SourceRow => ({
      event_id: eventId,
      source_name: SOURCE_NAME,
      source_url: detail.source_url!,
      source_event_id: extractEnjoytokyoEventId(detail.source_url),
      official_url: detail.official_url ?? null,
      last_checked_at: new Date().toISOString(),
    })

    if (status === 'exact') {
      console.log('[import-enjoytokyo] exact -> attach source (body untouched)')
      console.log(`[import-enjoytokyo] ---- ${label} ----`)
      console.log(`[import-enjoytokyo] title: ${item.title}`)
      console.log(
        `[import-enjoytokyo] matched_event_slug: ${item.matched_event_slug}`,
      )

      if (!item.matched_event_slug) {
        summary.failed += 1
        console.error('[import-enjoytokyo] exact but matched_event_slug is null')
        continue
      }

      if (!readClient) {
        summary.skipped += 1
        console.log(
          `[import-enjoytokyo] would attach to slug=${item.matched_event_slug} (no DB client)`,
        )
        continue
      }

      try {
        const { data: existing, error } = await readClient
          .from('events')
          .select('id, slug, status')
          .eq('slug', item.matched_event_slug)
          .maybeSingle()

        if (error) throw error
        if (!existing) {
          summary.failed += 1
          console.error(
            `[import-enjoytokyo] matched slug not found: ${item.matched_event_slug}`,
          )
          continue
        }

        const eventId = Number(existing.id)
        console.log(
          `[import-enjoytokyo] existing event_id=${eventId} status=${existing.status} (published/draft body not overwritten)`,
        )

        const result = await ensureEventSource(
          writeClient ?? readClient,
          sourcePayload(eventId),
          Boolean(writeClient),
        )
        tallyAttach(summary, result)
      } catch (error) {
        summary.failed += 1
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[import-enjoytokyo] exact attach failed: ${message}`)
      }
      continue
    }

    if (status === 'none') {
      console.log('[import-enjoytokyo] none -> new draft or existing slug')
      console.log(`[import-enjoytokyo] ---- ${label} ----`)

      const validated = validateNewDraft(detail)
      if (!validated.ok) {
        summary.skipped += 1
        console.log(`[import-enjoytokyo] skipped: ${validated.reason}`)
        console.log(`[import-enjoytokyo] title: ${detail.title}`)
        continue
      }

      console.log(`[import-enjoytokyo] title: ${validated.row.title}`)
      console.log(`[import-enjoytokyo] slug: ${validated.row.slug}`)
      console.log(
        `[import-enjoytokyo] dates: ${validated.row.start_date} ~ ${validated.row.end_date ?? 'null'}`,
      )

      if (!readClient && DRY_RUN) {
        summary.new_events += 1
        summary.new_sources += 1
        console.log('[import-enjoytokyo] status: draft (planned insert)')
        continue
      }

      if (!readClient) {
        summary.failed += 1
        console.error('[import-enjoytokyo] no DB client')
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
              `[import-enjoytokyo] published protected id=${eventId} — body not overwritten`,
            )
          } else if (existingStatus === 'draft') {
            if (writeClient) {
              await updateDraftBody(writeClient, eventId, validated.row)
              console.log(
                `[import-enjoytokyo] draft updated id=${eventId} (status stays draft)`,
              )
            } else {
              console.log(
                `[import-enjoytokyo] would update draft id=${eventId}`,
              )
            }
          } else {
            console.log(
              `[import-enjoytokyo] existing id=${eventId} status=${existingStatus} — body not overwritten`,
            )
          }

          const result = await ensureEventSource(
            writeClient ?? readClient,
            sourcePayload(eventId),
            Boolean(writeClient),
          )
          tallyAttach(summary, result)
          continue
        }

        // 新規 draft
        if (!writeClient) {
          summary.new_events += 1
          summary.new_sources += 1
          console.log('[import-enjoytokyo] would insert new draft + source')
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
        )
        summary.new_events += 1
        tallyAttach(summary, result)
        console.log(
          `[import-enjoytokyo] insert ok: id=${inserted.id} slug=${validated.row.slug}`,
        )
      } catch (error) {
        summary.failed += 1
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[import-enjoytokyo] none-path failed: ${message}`)
      }
      continue
    }

    summary.skipped += 1
    console.log(`[import-enjoytokyo] ---- ${label} (skipped) ----`)
    console.log(
      `[import-enjoytokyo] unknown duplicate_status: ${String(status)}`,
    )
  }

  console.log('[import-enjoytokyo] ---- summary ----')
  console.log(`[import-enjoytokyo] new_events: ${summary.new_events}`)
  console.log(`[import-enjoytokyo] new_sources: ${summary.new_sources}`)
  console.log(
    `[import-enjoytokyo] already_attached: ${summary.already_attached}`,
  )
  console.log(`[import-enjoytokyo] review_required: ${summary.review_required}`)
  console.log(`[import-enjoytokyo] skipped: ${summary.skipped}`)
  console.log(`[import-enjoytokyo] failed: ${summary.failed}`)
  console.log(
    `[import-enjoytokyo] done (${DRY_RUN ? 'dry-run, no DB write' : 'write mode'})`,
  )
}

main().catch((error) => {
  console.error('[import-enjoytokyo] unexpected error:', error)
  process.exit(1)
})
