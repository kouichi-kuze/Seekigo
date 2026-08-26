/**
 * AI整形済み GO TOKYO イベントを public.events / event_sources へ安全に反映する。
 *
 * - デフォルト DRY_RUN=true（書き込みなし）
 * - matchAgainstExisting で既存 events 全体と重複判定
 * - exact: 新規作成せず event_sources のみ（本体保護）
 * - likely / ambiguous: 自動マージせず review_required
 * - none: draft 新規（同一 slug の published は本体保護）
 * - published 本体は絶対に上書きしない
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getGotokyoLimit } from './lib/gotokyo-limit'
import {
  cleanAddressAccess,
  inferIsFreeFromPriceText,
  resolveAreaSlug,
} from '../src/lib/event-field-rules'
import {
  formatDedupeLog,
  matchAgainstExisting,
  type DedupeExisting,
  type DuplicateMatchResult,
} from '../src/lib/event-dedupe'
import {
  ensureEventSource,
  extractGotokyoSpotId,
  type AttachResult,
} from './lib/event-sources'
import {
  buildIncomingPayload,
  upsertDedupeReview,
} from './lib/dedupe-reviews'

config()

const MAX_EVENTS = getGotokyoLimit()
const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'gotokyo' as const
const LOG = '[import-gotokyo]'

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
  status: 'draft'
  last_checked_at: string
}

type Summary = {
  new_events: number
  new_sources: number
  already_attached: number
  review_required: number
  published_protected: number
  updated_drafts: number
  skipped: number
  failed: number
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

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
  | { ok: true; row: EventRow }
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

  const address =
    cleanAddressAccess(event.address) ??
    (typeof event.address === 'string' ? event.address.trim() || null : null)
  const area =
    resolveAreaSlug({
      areaHint: typeof event.area === 'string' ? event.area : null,
      address,
      venue: event.venue,
    }) ?? normalizeArea(event.area)
  const ruleIsFree = inferIsFreeFromPriceText(event.price_text)
  const is_free =
    ruleIsFree !== null
      ? ruleIsFree
      : normalizeNullableBoolean(event.is_free)

  return {
    ok: true,
    row: {
      title,
      slug,
      official_url: event.official_url ?? null,
      source_url: event.source_url.trim(),
      venue: event.venue ?? null,
      area,
      address,
      start_date,
      end_date: event.end_date ?? null,
      start_time: event.start_time ?? null,
      end_time: event.end_time ?? null,
      price_text: event.price_text ?? null,
      is_free,
      is_indoor: normalizeNullableBoolean(event.is_indoor),
      is_kids: normalizeNullableBoolean(event.is_kids),
      is_night: normalizeNullableBoolean(event.is_night),
      category,
      summary: event.summary ?? null,
      image_url: event.image_url ?? null,
      status: 'draft',
      last_checked_at: new Date().toISOString(),
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

async function fetchExistingForDedupe(
  supabase: SupabaseClient,
): Promise<DedupeExisting[]> {
  const { data: events, error } = await supabase
    .from('events')
    .select(
      'id, slug, title, start_date, end_date, venue, area, official_url, source_url, status',
    )
    .order('start_date', { ascending: true })

  if (error) {
    throw new Error(`Failed to fetch events for dedupe: ${error.message}`)
  }

  const { data: sources, error: srcErr } = await supabase
    .from('event_sources')
    .select('event_id, source_url')

  if (srcErr) {
    throw new Error(`Failed to fetch event_sources for dedupe: ${srcErr.message}`)
  }

  const alts = new Map<number, string[]>()
  for (const s of sources ?? []) {
    const id = Number(s.event_id)
    if (!Number.isFinite(id) || !s.source_url) continue
    const list = alts.get(id) ?? []
    list.push(String(s.source_url))
    alts.set(id, list)
  }

  return (events ?? []).map((row) => {
    const id = Number(row.id)
    return {
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
      alternate_source_urls: Number.isFinite(id) ? (alts.get(id) ?? []) : [],
    }
  })
}

function tallyAttach(summary: Summary, result: AttachResult) {
  if (result === 'new_source') summary.new_sources += 1
  else summary.already_attached += 1
}

function logDedupe(match: DuplicateMatchResult, title: string, action?: string) {
  for (const line of formatDedupeLog({
    status: match.duplicate_status,
    incomingTitle: title,
    match,
    action,
  })) {
    console.log(`${LOG} ${line}`)
  }
}

function sourcePayload(eventId: number, row: EventRow) {
  return {
    event_id: eventId,
    source_name: SOURCE_NAME,
    source_url: row.source_url,
    source_event_id: extractGotokyoSpotId(row.source_url),
    official_url: row.official_url,
    last_checked_at: new Date().toISOString(),
  }
}

async function touchLastChecked(
  client: SupabaseClient,
  eventId: number,
  status: string,
): Promise<void> {
  const { error } = await client
    .from('events')
    .update({ last_checked_at: new Date().toISOString() })
    .eq('id', eventId)
    .eq('status', status)
  if (error) throw error
}

async function updateDraftBody(
  client: SupabaseClient,
  eventId: number,
  row: EventRow,
): Promise<boolean> {
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
    is_indoor: row.is_indoor,
    is_kids: row.is_kids,
    is_night: row.is_night,
    category: row.category,
    summary: row.summary,
    image_url: row.image_url,
    last_checked_at: row.last_checked_at,
    updated_at: new Date().toISOString(),
  }
  if (row.area) patch.area = row.area
  if (row.is_free !== null) patch.is_free = row.is_free

  const { data, error } = await client
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .eq('status', 'draft')
    .select('id')

  if (error) throw error
  return Boolean(data && data.length > 0)
}

async function main() {
  console.log(`${LOG} start`)
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} max: ${MAX_EVENTS}`)
  console.log(
    `${LOG} dedupe: matchAgainstExisting (exact=attach only, likely/ambiguous=review, none=draft)`,
  )
  console.log(`${LOG} published bodies are never overwritten`)

  let file: EnrichedFile
  try {
    const raw = await readFile(inputPath, 'utf8')
    file = JSON.parse(raw) as EnrichedFile
  } catch (error) {
    console.error(
      `${LOG} failed to read tmp/gotokyo-events-enriched.json — run \`npm run enrich:gotokyo:ai\` first`,
      error,
    )
    process.exit(1)
  }

  const candidates = (file.events ?? []).slice(0, MAX_EVENTS)
  if (candidates.length === 0) {
    console.error(`${LOG} no events in enriched JSON`)
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

  if (DRY_RUN) {
    console.log(
      `${LOG} dry-run mode — no DB writes (set DRY_RUN=false to write)`,
    )
  } else {
    console.log(`${LOG} using SUPABASE_SERVICE_ROLE_KEY for writes`)
  }

  let existing: DedupeExisting[] = []
  if (readClient) {
    try {
      existing = await fetchExistingForDedupe(readClient)
      console.log(`${LOG} existing events for dedupe: ${existing.length}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${LOG} failed to load existing events: ${message}`)
      process.exit(1)
    }
  } else {
    console.log(`${LOG} no DB client — dedupe against empty set`)
  }

  const summary: Summary = {
    new_events: 0,
    new_sources: 0,
    already_attached: 0,
    review_required: 0,
    published_protected: 0,
    updated_drafts: 0,
    skipped: 0,
    failed: 0,
  }

  for (let i = 0; i < candidates.length; i++) {
    const event = candidates[i]
    const label = `${i + 1}/${candidates.length}`
    const validated = validateEvent(event)

    if (!validated.ok) {
      summary.skipped += 1
      console.log(`${LOG} ---- ${label} (skipped) ----`)
      console.log(`${LOG} reason: ${validated.reason}`)
      console.log(`${LOG} title: ${event.title}`)
      continue
    }

    const row = validated.row
    const match = matchAgainstExisting(
      {
        title: row.title,
        start_date: row.start_date,
        end_date: row.end_date,
        venue: row.venue,
        official_url: row.official_url,
        source_url: row.source_url,
        area: row.area,
      },
      existing,
    )

    console.log(`${LOG} ---- ${label} ----`)

    if (match.duplicate_status === 'likely' || match.duplicate_status === 'ambiguous') {
      summary.review_required += 1
      logDedupe(match, row.title, 'review_required')

      if (readClient) {
        const rawCandidate = Number(match.matched_event_id)
        const candidateId =
          Number.isFinite(rawCandidate) && rawCandidate > 0
            ? rawCandidate
            : null
        try {
          await upsertDedupeReview(
            readClient,
            {
              incoming_source_name: SOURCE_NAME,
              incoming_source_url: row.source_url,
              incoming_payload: buildIncomingPayload({
                sourceName: SOURCE_NAME,
                title: row.title,
                start_date: row.start_date,
                end_date: row.end_date,
                start_time: row.start_time,
                end_time: row.end_time,
                venue: row.venue,
                area: row.area,
                official_url: row.official_url,
                source_url: row.source_url,
                price_text: row.price_text,
                is_free: row.is_free,
                address: row.address,
                category: row.category,
                summary: row.summary,
                image_url: row.image_url,
              }),
              candidate_event_id: candidateId,
              duplicate_status: match.duplicate_status,
              reason: match.duplicate_reason,
              scores: match.scores ?? null,
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

    if (match.duplicate_status === 'exact') {
      logDedupe(match, row.title, 'attach_source_only')

      const eventId =
        match.matched_event_id != null
          ? Number(match.matched_event_id)
          : null

      if (!eventId || !Number.isFinite(eventId)) {
        summary.failed += 1
        console.error(`${LOG} exact but matched_event_id is missing`)
        continue
      }

      if (!readClient) {
        summary.already_attached += 1
        console.log(`${LOG} would attach source to event_id=${eventId}`)
        continue
      }

      try {
        // 本体は触らず、管理用 last_checked_at のみ（status 条件付き）
        if (writeClient && match.matched_status) {
          await touchLastChecked(writeClient, eventId, match.matched_status)
          if (match.matched_status === 'published') {
            summary.published_protected += 1
          }
        } else if (match.matched_status === 'published') {
          summary.published_protected += 1
        }

        const result = await ensureEventSource(
          writeClient ?? readClient,
          sourcePayload(eventId, row),
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

    // --- none: create draft（同一 slug があれば保護付きで source のみ / draft 更新） ---
    logDedupe(match, row.title, 'create_draft')

    if (!readClient) {
      summary.new_events += 1
      summary.new_sources += 1
      console.log(`${LOG} would insert new draft slug=${row.slug}`)
      continue
    }

    try {
      const { data: existingSlug, error: selErr } = await readClient
        .from('events')
        .select('id, status, slug')
        .eq('slug', row.slug)
        .maybeSingle()

      if (selErr) throw selErr

      if (existingSlug) {
        const eventId = Number(existingSlug.id)
        const existingStatus = existingSlug.status ?? null

        if (existingStatus === 'published') {
          summary.published_protected += 1
          console.log(
            `${LOG} published protected id=${eventId} — body not overwritten (slug match on none-path)`,
          )
          if (writeClient) {
            await touchLastChecked(writeClient, eventId, 'published')
          }
        } else if (existingStatus === 'draft') {
          if (writeClient) {
            const updated = await updateDraftBody(writeClient, eventId, row)
            if (updated) {
              summary.updated_drafts += 1
              console.log(`${LOG} draft updated id=${eventId}`)
            } else {
              summary.published_protected += 1
              console.log(
                `${LOG} skip body update (not draft anymore): ${row.slug}`,
              )
            }
          } else {
            summary.updated_drafts += 1
            console.log(`${LOG} would update draft id=${eventId}`)
          }
        } else {
          console.log(
            `${LOG} existing id=${eventId} status=${existingStatus} — body not overwritten`,
          )
        }

        const result = await ensureEventSource(
          writeClient ?? readClient,
          sourcePayload(eventId, row),
          Boolean(writeClient),
          LOG,
        )
        tallyAttach(summary, result)
        continue
      }

      if (!writeClient) {
        summary.new_events += 1
        summary.new_sources += 1
        console.log(`${LOG} would insert new draft + source slug=${row.slug}`)
        continue
      }

      const { data: inserted, error: insErr } = await writeClient
        .from('events')
        .insert(row)
        .select('id')
        .single()

      if (insErr) throw insErr
      if (!inserted?.id) throw new Error('insert returned no id')

      const eventId = Number(inserted.id)
      const result = await ensureEventSource(
        writeClient,
        sourcePayload(eventId, row),
        true,
        LOG,
      )
      summary.new_events += 1
      tallyAttach(summary, result)

      // 後続候補の dedupe 用にメモリ上の既存リストへ追加
      existing.push({
        id: eventId,
        slug: row.slug,
        title: row.title,
        start_date: row.start_date,
        end_date: row.end_date,
        venue: row.venue,
        area: row.area,
        official_url: row.official_url,
        source_url: row.source_url,
        status: 'draft',
        alternate_source_urls: [row.source_url],
      })

      console.log(`${LOG} insert ok: id=${eventId} slug=${row.slug}`)
    } catch (error) {
      summary.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${LOG} none-path failed: ${message}`)
    }
  }

  console.log(`${LOG} ---- summary ----`)
  console.log(`${LOG} new_events: ${summary.new_events}`)
  console.log(`${LOG} new_sources: ${summary.new_sources}`)
  console.log(`${LOG} already_attached: ${summary.already_attached}`)
  console.log(`${LOG} review_required: ${summary.review_required}`)
  console.log(`${LOG} updated_drafts: ${summary.updated_drafts}`)
  console.log(`${LOG} published_protected: ${summary.published_protected}`)
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
