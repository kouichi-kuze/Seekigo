/**
 * AI整形済み GO TOKYO イベントを public.events へ安全に UPSERT する。
 * - デフォルト DRY_RUN=true（書き込みなし）
 * - 書き込み時のみ SUPABASE_SERVICE_ROLE_KEY を使用
 * - ブラウザ公開キーは使わない
 * - published: 本体フィールドは上書きしない（last_checked_at のみ可）
 * - draft: 自動取得・AI整形による更新を許可
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGotokyoLimit } from './lib/gotokyo-limit'

config()

const MAX_EVENTS = getGotokyoLimit()
const DRY_RUN = process.env.DRY_RUN !== 'false'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const inputPath = path.join(rootDir, 'tmp', 'gotokyo-events-enriched.json')

type EnrichedEvent = {
  title: string | null
  description?: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  price_text: string | null
  official_url: string | null
  image_url: string | null
  source_url: string | null
  area: string | null
  is_free: boolean | null
  is_indoor: boolean | null
  is_kids: boolean | null
  is_night: boolean | null
  category: unknown
  summary: string | null
  slug?: string | null
  ai_error?: string | null
}

type EnrichedFile = {
  events?: EnrichedEvent[]
}

type EventRow = {
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
  status: 'draft' | 'published'
  last_checked_at: string
  updated_at?: string
}

type PlannedEvent = {
  row: EventRow
  action: 'insert' | 'update_draft' | 'touch_published'
  existingStatus: string | null
  existingId: number | null
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/** AIが文字列 "null" を返した場合も null に正規化 */
function normalizeArea(area: unknown): string | null {
  if (typeof area !== 'string') return null
  const trimmed = area.trim().toLowerCase()
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null
  if (!/^[a-z0-9-]+$/.test(trimmed)) return null
  return trimmed
}

function normalizeNullableBoolean(value: unknown): boolean | null {
  if (value === true) return true
  if (value === false) return false
  return null
}

function normalizeCategory(category: unknown): string[] | null {
  if (!Array.isArray(category)) return null
  const values = category
    .filter((c): c is string => typeof c === 'string')
    .map((c) => c.trim())
    .filter(Boolean)
  return values
}

function isValidYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/**
 * 安定 slug を生成。
 * 1) 既存 slug
 * 2) GO TOKYO の spot id（source_url）+ 年
 * 3) title 正規化ハッシュ + 年（日本語・短い英単語のみの衝突を防ぐ）
 */
function generateSlug(
  title: string,
  startDate: string,
  sourceUrl?: string | null,
): string {
  const year = startDate.slice(0, 4)

  const spot = sourceUrl?.match(/\/spot\/((?:ex|ev)\d+)\//i)
  if (spot) {
    return `gotokyo-${spot[1].toLowerCase()}-${year}`
  }

  const normalized = title.normalize('NFKC').trim().toLowerCase()
  const hash = createHash('sha1')
    .update(`seekigo:${normalized}:${year}`)
    .digest('hex')
    .slice(0, 12)

  const ascii = normalized
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  if (ascii.length >= 8) {
    return `${ascii}-${hash.slice(0, 6)}-${year}`.slice(0, 100)
  }

  return `gotokyo-${hash}-${year}`
}

function resolveSlug(
  event: EnrichedEvent,
  title: string,
  startDate: string,
): string {
  if (typeof event.slug === 'string' && event.slug.trim()) {
    return event.slug.trim().toLowerCase()
  }
  return generateSlug(title, startDate, event.source_url)
}

function validateEvent(
  event: EnrichedEvent,
):
  | {
      ok: true
      rowBase: Omit<EventRow, 'status' | 'last_checked_at' | 'updated_at'>
    }
  | { ok: false; reason: string } {
  if (event.ai_error) {
    return { ok: false, reason: `ai_error: ${event.ai_error}` }
  }

  if (isBlank(event.title) || typeof event.title !== 'string') {
    return { ok: false, reason: 'title is required' }
  }
  if (isBlank(event.source_url) || typeof event.source_url !== 'string') {
    return { ok: false, reason: 'source_url is required' }
  }
  if (isBlank(event.start_date) || typeof event.start_date !== 'string') {
    return { ok: false, reason: 'start_date is required' }
  }
  if (!isValidYmd(event.start_date)) {
    return { ok: false, reason: `invalid start_date: ${event.start_date}` }
  }
  if (event.end_date !== null && event.end_date !== undefined) {
    if (typeof event.end_date !== 'string' || !isValidYmd(event.end_date)) {
      return { ok: false, reason: `invalid end_date: ${String(event.end_date)}` }
    }
  }

  const category = normalizeCategory(event.category)
  if (!category) {
    return { ok: false, reason: 'category must be an array' }
  }

  const title = event.title.trim()
  const start_date = event.start_date
  const slug = resolveSlug(event, title, start_date)

  return {
    ok: true,
    rowBase: {
      title,
      slug,
      official_url: event.official_url ?? null,
      source_url: event.source_url.trim(),
      venue: event.venue ?? null,
      area: normalizeArea(event.area),
      address: event.address ?? null,
      start_date,
      end_date: event.end_date ?? null,
      start_time: event.start_time ?? null,
      end_time: event.end_time ?? null,
      price_text: event.price_text ?? null,
      is_free: normalizeNullableBoolean(event.is_free),
      is_indoor: normalizeNullableBoolean(event.is_indoor),
      is_kids: normalizeNullableBoolean(event.is_kids),
      is_night: normalizeNullableBoolean(event.is_night),
      category,
      summary: event.summary ?? null,
      image_url: event.image_url ?? null,
    },
  }
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
      'SUPABASE_SERVICE_ROLE_KEY is missing in .env (do NOT use PUBLIC_ prefix or publishable key)',
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

function logPlanned(index: number, planned: PlannedEvent) {
  const { row, action, existingStatus } = planned
  console.log(`[import-gotokyo] ---- ${index + 1} (${action}) ----`)
  console.log(`[import-gotokyo] title: ${row.title}`)
  console.log(`[import-gotokyo] slug: ${row.slug}`)
  console.log(`[import-gotokyo] area: ${row.area}`)
  console.log(
    `[import-gotokyo] dates: ${row.start_date} ~ ${row.end_date ?? 'null'}`,
  )
  console.log(`[import-gotokyo] category: ${JSON.stringify(row.category)}`)
  console.log(`[import-gotokyo] status: ${row.status}`)
  if (existingStatus) {
    console.log(`[import-gotokyo] existing_status: ${existingStatus}`)
  }
  if (action === 'touch_published') {
    console.log(
      '[import-gotokyo] published protected — body not overwritten (last_checked_at only)',
    )
  }
}

async function main() {
  console.log('[import-gotokyo] start')
  console.log(`[import-gotokyo] DRY_RUN: ${DRY_RUN}`)
  console.log(`[import-gotokyo] max: ${MAX_EVENTS}`)
  console.log(
    '[import-gotokyo] published bodies are never overwritten; drafts may be updated',
  )

  let file: EnrichedFile
  try {
    const raw = await readFile(inputPath, 'utf8')
    file = JSON.parse(raw) as EnrichedFile
  } catch (error) {
    console.error(
      '[import-gotokyo] failed to read tmp/gotokyo-events-enriched.json — run `npm run enrich:gotokyo:ai` first',
      error,
    )
    process.exit(1)
  }

  const candidates = (file.events ?? []).slice(0, MAX_EVENTS)
  if (candidates.length === 0) {
    console.error('[import-gotokyo] no events in enriched JSON')
    process.exit(1)
  }

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

  if (!DRY_RUN) {
    console.log('[import-gotokyo] using SUPABASE_SERVICE_ROLE_KEY for writes')
  } else {
    console.log(
      '[import-gotokyo] dry-run mode — no DB writes (set DRY_RUN=false to insert drafts)',
    )
  }

  let planned = 0
  let inserted = 0
  let updatedDrafts = 0
  let publishedProtected = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < candidates.length; i++) {
    const event = candidates[i]
    const validated = validateEvent(event)

    if (!validated.ok) {
      skipped += 1
      console.log(`[import-gotokyo] ---- ${i + 1} (skipped) ----`)
      console.log(`[import-gotokyo] reason: ${validated.reason}`)
      console.log(`[import-gotokyo] title: ${event.title}`)
      continue
    }

    const now = new Date().toISOString()
    let existingStatus: string | null = null
    let existingId: number | null = null
    let action: PlannedEvent['action'] = 'insert'

    if (readClient) {
      const { data: existing, error: selectError } = await readClient
        .from('events')
        .select('id, status, slug')
        .eq('slug', validated.rowBase.slug)
        .maybeSingle()

      if (selectError) {
        failed += 1
        console.error(
          `[import-gotokyo] select failed for slug=${validated.rowBase.slug}: ${selectError.message}`,
        )
        continue
      }

      if (existing) {
        existingId = Number(existing.id)
        existingStatus = existing.status ?? null
        if (existingStatus === 'published') {
          action = 'touch_published'
        } else {
          action = 'update_draft'
        }
      }
    }

    // 新規・draft 更新は draft。published は published のまま（絶対に draft へ戻さない）
    const status: 'draft' | 'published' =
      action === 'touch_published' ? 'published' : 'draft'

    const row: EventRow = {
      ...validated.rowBase,
      status,
      last_checked_at: now,
      ...(action !== 'insert' ? { updated_at: now } : {}),
    }

    planned += 1
    logPlanned(i, { row, action, existingStatus, existingId })

    if (DRY_RUN || !writeClient) {
      if (action === 'touch_published') publishedProtected += 1
      else if (action === 'update_draft') updatedDrafts += 1
      else inserted += 1
      continue
    }

    try {
      if (action === 'insert') {
        const { error } = await writeClient.from('events').insert({
          ...row,
        })
        if (error) throw error
        inserted += 1
        console.log(`[import-gotokyo] insert ok: ${row.slug}`)
      } else if (action === 'update_draft') {
        const { data, error } = await writeClient
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
            is_free: row.is_free,
            is_indoor: row.is_indoor,
            is_kids: row.is_kids,
            is_night: row.is_night,
            category: row.category,
            summary: row.summary,
            image_url: row.image_url,
            last_checked_at: row.last_checked_at,
            updated_at: row.updated_at,
          })
          .eq('slug', row.slug)
          .eq('status', 'draft')
          .select('id')

        if (error) throw error
        if (!data || data.length === 0) {
          publishedProtected += 1
          console.log(
            `[import-gotokyo] skip body update (not draft anymore): ${row.slug}`,
          )
        } else {
          updatedDrafts += 1
          console.log(`[import-gotokyo] draft updated: ${row.slug}`)
        }
      } else {
        // published: 本体は触らず last_checked_at のみ
        const { error } = await writeClient
          .from('events')
          .update({
            last_checked_at: now,
          })
          .eq('slug', row.slug)
          .eq('status', 'published')

        if (error) throw error
        publishedProtected += 1
        console.log(
          `[import-gotokyo] published protected (last_checked_at only): ${row.slug}`,
        )
      }
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[import-gotokyo] write failed (${row.slug}): ${message}`)
    }
  }

  console.log('[import-gotokyo] ---- summary ----')
  console.log(`[import-gotokyo] planned: ${planned}`)
  console.log(`[import-gotokyo] inserted: ${inserted}`)
  console.log(`[import-gotokyo] updated_drafts: ${updatedDrafts}`)
  console.log(`[import-gotokyo] published_protected: ${publishedProtected}`)
  console.log(`[import-gotokyo] skipped: ${skipped}`)
  console.log(`[import-gotokyo] failed: ${failed}`)
  console.log('[import-gotokyo] done')
}

main().catch((error) => {
  console.error('[import-gotokyo] unexpected error:', error)
  process.exit(1)
})
