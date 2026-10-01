/**
 * Walkerplus 第1バッチ。監査で none かつ 2026-09-30 現在・未来だった87件だけを draft 候補にする。
 *
 * - 既定 DRY_RUN=true。書き込みは DRY_RUN=false のときだけ
 * - published は更新しない
 * - 1161件・924件は ID 一覧に無いので取り込めない
 * - sync-all からは呼ばない
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { matchAgainstExisting, type DedupeExisting, type DuplicateStatus } from '../src/lib/event-dedupe'
import {
  cleanAddressAccess,
  inferIsNight,
  inferPriceTypeFromPriceText,
  resolveEventPlace,
} from '../src/lib/event-field-rules'
import { normalizeHmToDb } from '../src/lib/event-time-rules'
import { defaultImageMetaForSource } from '../src/lib/event-image-usage'
import { ensureEventSource, extractWalkerplusEventId } from '../src/lib/event-sources'
import { resolveScheduleStatus } from '../src/lib/event-schedule'
import {
  WALKERPLUS_BATCH1_LIST_PERIODS,
  WALKERPLUS_BATCH1_SOURCE_IDS,
  WALKERPLUS_BATCH1_TODAY,
} from './data/walkerplus-batch1-ids'
import {
  inferKidsFromWalkerplusCategories,
  mapWalkerplusCategories,
} from './lib/walkerplus-category-map'
import {
  buildPricePageUrl,
  extractWalkerplusDetail,
  type WalkerplusEventDetail,
} from './lib/walkerplus-detail-extract'
import { planWalkerplusSchedule, type WalkerplusOccurrencePlan } from './lib/walkerplus-sessions'
import { parseWalkerplusDateText, randomGapMs, sleep, type WalkerplusListEvent } from './lib/walkerplus-parse'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'walkerplus' as const
const LOG = '[walkerplus-batch1]'
const GAP_MIN_MS = 2000
const GAP_MAX_MS = 3000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const detailsPath = path.join(rootDir, 'tmp', 'walkerplus-batch1-details.json')

type StoredDetail = WalkerplusEventDetail & { list_period: string }

function assertAllowlist(): readonly string[] {
  const ids = [...WALKERPLUS_BATCH1_SOURCE_IDS]
  if (ids.length !== 87 || new Set(ids).size !== 87) {
    throw new Error(`${LOG} allowlist must be exactly 87 unique ids`)
  }
  return ids
}

function createServiceClient(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url) throw new Error('PUBLIC_SUPABASE_URL is missing')
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing')
  if (serviceKey === process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use the publishable key')
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function fetchHtml(url: string): Promise<{ status: number; html: string }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    return { status: response.status, html: await response.text() }
  } finally {
    clearTimeout(timeout)
  }
}

function listItem(id: string, period: string): WalkerplusListEvent {
  const parsed = parseWalkerplusDateText(period)
  return {
    source_name: 'walkerplus',
    source_event_id: id,
    title: id,
    detail_url: `https://www.walkerplus.com/event/${id}/`,
    date_text: period,
    start_date: parsed.start_date,
    end_date: parsed.end_date,
    venue: null,
    area_text: null,
    summary: null,
    categories: [],
    image_url: null,
    fetched_at: new Date().toISOString(),
  }
}

async function loadOrFetchDetails(ids: readonly string[]): Promise<StoredDetail[]> {
  let stored: StoredDetail[] = []
  try {
    const parsed = JSON.parse(await readFile(detailsPath, 'utf8')) as { events?: StoredDetail[] }
    stored = parsed.events ?? []
  } catch {
    stored = []
  }
  const byId = new Map(stored.map((row) => [row.source_event_id, row]))
  const missing = ids.filter((id) => !byId.get(id)?.start_date)
  if (missing.length === 0 && stored.length === ids.length) return ids.map((id) => byId.get(id)!)

  await mkdir(path.dirname(detailsPath), { recursive: true })
  for (let i = 0; i < missing.length; i++) {
    const id = missing[i]
    if (i > 0 || stored.length > 0) {
      const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
      console.log(`${LOG} sleep ${gap}ms`)
      await sleep(gap)
    }
    const url = `https://www.walkerplus.com/event/${id}/`
    const period = WALKERPLUS_BATCH1_LIST_PERIODS[id] ?? ''
    console.log(`${LOG} detail ${stored.length + 1}/${ids.length} ${url}`)
    const { status, html } = await fetchHtml(url)
    if (status !== 200) throw new Error(`${id} HTTP ${status}`)
    const item = listItem(id, period)
    let priceHtml: string | null = null
    const preliminary = extractWalkerplusDetail(html, url, item)
    if (!preliminary.price_text) {
      const priceUrl = buildPricePageUrl(url, html)
      if (priceUrl) {
        const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
        console.log(`${LOG} price page sleep ${gap}ms`)
        await sleep(gap)
        const priceRes = await fetchHtml(priceUrl)
        if (priceRes.status === 200) priceHtml = priceRes.html
      }
    }
    const detail = extractWalkerplusDetail(html, url, item, priceHtml)
    const row: StoredDetail = { ...detail, source_event_id: id, list_period: period }
    byId.set(id, row)
    stored = ids.map((sourceId) => byId.get(sourceId)).filter((row): row is StoredDetail => Boolean(row))
    await writeFile(detailsPath, JSON.stringify({ events: stored }, null, 2), 'utf8')
  }
  const ready = ids.map((id) => byId.get(id)).filter((row): row is StoredDetail => Boolean(row))
  if (ready.length !== ids.length) throw new Error(`${LOG} details ${ready.length}/${ids.length}`)
  return ready
}

async function loadPool(client: SupabaseClient): Promise<{
  pool: DedupeExisting[]
  attached: Set<string>
}> {
  const { data, error } = await client
    .from('events')
    .select('id, slug, title, start_date, end_date, venue, area, official_url, source_url, status')
  if (error) throw error
  const { data: sources, error: srcErr } = await client
    .from('event_sources')
    .select('event_id, source_name, source_url, source_event_id')
  if (srcErr) throw srcErr
  const alts = new Map<number, string[]>()
  const attached = new Set<string>()
  for (const source of sources ?? []) {
    const id = Number(source.event_id)
    if (source.source_name === 'walkerplus' && source.source_event_id) {
      attached.add(String(source.source_event_id).toLowerCase())
    }
    if (!Number.isFinite(id) || !source.source_url) continue
    const list = alts.get(id) ?? []
    list.push(String(source.source_url))
    alts.set(id, list)
  }
  const pool = (data ?? []).map((row) => ({
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
  return { pool, attached }
}

function slugFor(detail: StoredDetail, startDate: string): string {
  const eventId = extractWalkerplusEventId(detail.source_url) ?? detail.source_event_id
  if (eventId) return `walkerplus-${eventId}-${startDate.slice(0, 4)}`
  const hash = createHash('sha1')
    .update(`seekigo:walkerplus:${detail.title ?? ''}:${startDate.slice(0, 4)}`)
    .digest('hex')
    .slice(0, 12)
  return `walkerplus-${hash}-${startDate.slice(0, 4)}`
}

type Planned = {
  detail: StoredDetail
  status: DuplicateStatus
  slug: string
  municipality: string | null
  category: string[]
  priceType: string | null
  isKids: boolean | null
  isIndoor: null
  isNight: boolean | null
  schedule: ReturnType<typeof planWalkerplusSchedule>
  action: 'insert' | 'skip' | 'reclassified'
}

function planOne(detail: StoredDetail, pool: DedupeExisting[], attached: Set<string>): Planned {
  const sourceId = (detail.source_event_id ?? '').toLowerCase()
  const schedule = planWalkerplusSchedule({
    listPeriod: detail.list_period,
    startDate: detail.start_date ?? '1970-01-01',
    endDate: detail.end_date,
    startTime: normalizeHmToDb(detail.start_time),
    endTime: normalizeHmToDb(detail.end_time),
    today: WALKERPLUS_BATCH1_TODAY,
  })
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
  const rawCategories = detail.categories ?? []
  const category = mapWalkerplusCategories(rawCategories).mapped
  const address = cleanAddressAccess(detail.address) ?? detail.address?.trim() ?? null
  const place = resolveEventPlace({
    areaHint: detail.area_locality,
    address,
    venue: detail.venue,
  })
  const planned: Planned = {
    detail,
    status: match.duplicate_status,
    slug: slugFor(detail, schedule.start_date),
    municipality: place.municipality,
    category,
    priceType: inferPriceTypeFromPriceText(detail.price_text),
    isKids: inferKidsFromWalkerplusCategories(rawCategories),
    isIndoor: null,
    isNight: inferIsNight({
      title: detail.title,
      description: detail.description,
      venue: detail.venue,
      startTime: detail.start_time,
      endTime: detail.end_time,
    }),
    schedule,
    action: 'insert',
  }
  if (attached.has(sourceId)) {
    planned.action = 'skip'
    return planned
  }
  if (match.duplicate_status !== 'none') {
    planned.action = 'reclassified'
    return planned
  }
  const active = resolveScheduleStatus(
    [],
    { start_date: detail.start_date, end_date: detail.end_date },
    WALKERPLUS_BATCH1_TODAY,
  )
  if (!detail.title || !detail.start_date || (active !== 'today' && active !== 'upcoming')) {
    planned.action = 'skip'
  }
  return planned
}

async function insertDraft(
  client: SupabaseClient,
  planned: Planned,
): Promise<void> {
  const detail = planned.detail
  const now = new Date().toISOString()
  const address = cleanAddressAccess(detail.address) ?? detail.address?.trim() ?? null
  const place = resolveEventPlace({
    areaHint: detail.area_locality,
    address,
    venue: detail.venue,
  })
  const imageMeta = detail.image_url
    ? defaultImageMetaForSource('walkerplus')
    : { image_usage_status: 'unknown' as const, image_source: null, image_credit: null }
  const { data: existing, error: selErr } = await client
    .from('events')
    .select('id, status')
    .eq('slug', planned.slug)
    .maybeSingle()
  if (selErr) throw selErr
  if (existing && existing.status !== 'draft') {
    throw new Error(`slug ${planned.slug} is ${existing.status}; refused`)
  }
  let eventId = existing?.id ? Number(existing.id) : null
  if (!eventId) {
    const { data: inserted, error } = await client
      .from('events')
      .insert({
        title: detail.title!.trim(),
        slug: planned.slug,
        official_url: detail.official_url ?? null,
        source_url: detail.source_url,
        venue: detail.venue ?? null,
        area: place.area,
        municipality: place.municipality,
        address,
        start_date: planned.schedule.start_date,
        end_date: planned.schedule.end_date,
        start_time: normalizeHmToDb(detail.start_time),
        end_time: normalizeHmToDb(detail.end_time),
        price_text: detail.price_text ?? null,
        price_type: planned.priceType,
        is_indoor: null,
        is_kids: planned.isKids,
        is_night: planned.isNight,
        category: planned.category,
        summary: null,
        image_url: detail.image_url ?? null,
        image_usage_status: imageMeta.image_usage_status,
        image_source: detail.image_url ? 'walkerplus' : null,
        image_credit: null,
        status: 'draft',
        last_checked_at: now,
      })
      .select('id')
      .single()
    if (error) throw error
    eventId = Number(inserted.id)
  }
  await ensureEventSource(
    client,
    {
      event_id: eventId,
      source_name: SOURCE_NAME,
      source_url: detail.source_url,
      source_event_id: detail.source_event_id,
      official_url: detail.official_url ?? null,
      last_checked_at: now,
    },
    true,
    LOG,
  )
  if (planned.schedule.occurrences.length > 0) {
    const rows = planned.schedule.occurrences.map((item: WalkerplusOccurrencePlan) => ({
      event_id: eventId,
      start_date: item.start_date,
      end_date: item.end_date,
      start_time: item.start_time,
      end_time: item.end_time,
    }))
    const { error } = await client.from('event_occurrences').insert(rows)
    if (error) throw error
  }
}

async function main() {
  const ids = assertAllowlist()
  console.log(`${LOG} targets ${ids.length}`)
  console.log(`${LOG} DRY_RUN ${DRY_RUN}`)
  console.log(`${LOG} sync-all is not used`)
  const details = await loadOrFetchDetails(ids)
  const extra = details.filter((row) => !ids.includes(row.source_event_id ?? ''))
  if (extra.length > 0 || details.length !== 87) {
    throw new Error(`${LOG} refusing to plan ${details.length} events`)
  }
  const client = createServiceClient()
  const { pool, attached } = await loadPool(client)
  const plans = details.map((detail) => planOne(detail, pool, attached))
  const inserts = plans.filter((row) => row.action === 'insert')
  const skips = plans.filter((row) => row.action === 'skip')
  const reclassified = plans.filter((row) => row.action === 'reclassified')
  const countStatus = (status: DuplicateStatus) =>
    reclassified.filter((row) => row.status === status).length
  const report = {
    targets: plans.length,
    insert: inserts.length,
    skip: skips.length,
    exact: countStatus('exact'),
    likely: countStatus('likely'),
    ambiguous: countStatus('ambiguous'),
    municipalityMissing: inserts.filter((row) => !row.municipality).length,
    categoryOtherOnly: inserts.filter((row) => row.category.length === 1 && row.category[0] === 'other').length,
    priceTypeNull: inserts.filter((row) => row.priceType == null).length,
    isKidsTrue: inserts.filter((row) => row.isKids === true).length,
    isIndoorTrue: inserts.filter((row) => row.isIndoor === true).length,
    isNightTrue: inserts.filter((row) => row.isNight === true).length,
    occurrences: inserts.reduce((sum, row) => sum + row.schedule.occurrences.length, 0),
    errors: 0,
  }
  console.log(`${LOG} report ${JSON.stringify(report)}`)
  if (DRY_RUN) {
    console.log(`${LOG} dry-run only, no DB write`)
    return
  }
  for (const planned of inserts) {
    try {
      await insertDraft(client, planned)
      console.log(`${LOG} inserted ${planned.slug}`)
    } catch (error) {
      report.errors += 1
      console.error(`${LOG} error ${planned.slug}`, error instanceof Error ? error.message : error)
    }
  }
  console.log(`${LOG} write errors ${report.errors}`)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((error) => {
    console.error(`${LOG} fatal`, error)
    process.exit(1)
  })
}
