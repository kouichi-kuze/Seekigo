/**
 * Walkerplus Batch 3専用インポーター。
 * scripts/data/walkerplus-batch3-ids.ts の固定71件以外は扱わない。
 * 既定はDRY_RUN。--write を付けたときだけ登録する。
 * .env の DRY_RUN=false では書き込まない。
 * 既存sourceはskipし、exact / likely / ambiguous は自動リンクしない。
 * published を含む既存イベント本文は更新しない。
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  matchAgainstExisting,
  type DedupeExisting,
  type DuplicateStatus,
} from '../src/lib/event-dedupe'
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
  WALKERPLUS_BATCH3_LIST_PERIODS,
  WALKERPLUS_BATCH3_SOURCE_IDS,
  WALKERPLUS_BATCH3_TODAY,
} from './data/walkerplus-batch3-ids'
import {
  inferKidsFromWalkerplusCategories,
  mapWalkerplusCategories,
} from './lib/walkerplus-category-map'
import {
  buildPricePageUrl,
  extractWalkerplusDetail,
  type WalkerplusEventDetail,
} from './lib/walkerplus-detail-extract'
import {
  planWalkerplusSchedule,
  type WalkerplusOccurrencePlan,
} from './lib/walkerplus-sessions'
import {
  parseWalkerplusDateText,
  randomGapMs,
  sleep,
  type WalkerplusListEvent,
} from './lib/walkerplus-parse'

config()

const DRY_RUN = !process.argv.includes('--write')
const LOG = '[walkerplus-batch3]'
const DETAILS_PATH = path.resolve('tmp/walkerplus-batch3-details.json')
const FOCUS_ID = 'ar0313e154513'
const GAP_MIN_MS = 2000
const GAP_MAX_MS = 3000
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

type StoredDetail = WalkerplusEventDetail & { list_period: string }

type Plan = {
  detail: StoredDetail
  status: DuplicateStatus
  action: 'insert' | 'skip' | 'reclassified'
  slug: string
  municipality: string | null
  category: string[]
  priceType: string | null
  isKids: boolean | null
  isIndoor: null
  isNight: boolean | null
  schedule: ReturnType<typeof planWalkerplusSchedule>
}

type CachedEvent = {
  list?: WalkerplusListEvent
  detail?: WalkerplusEventDetail
  list_period?: string
}

function walkerplusIdKeys(value: string | null | undefined): string[] {
  if (!value) return []
  const text = value.trim().toLowerCase()
  const keys = new Set<string>()
  if (text) keys.add(text)
  const embedded = text.match(/ar\d+e(\d+)/)?.[1]
  const tail = embedded ?? text.match(/e(\d+)$/)?.[1]
  if (tail) keys.add(tail)
  if (/^\d+$/.test(text)) keys.add(text)
  return [...keys]
}

function assertAllowlist(): readonly string[] {
  const ids = [...WALKERPLUS_BATCH3_SOURCE_IDS]
  if (ids.length !== 71 || new Set(ids).size !== 71) {
    throw new Error(`${LOG} allowlist must be exactly 71 unique ids`)
  }
  const missingPeriod = ids.filter((id) => !WALKERPLUS_BATCH3_LIST_PERIODS[id])
  if (missingPeriod.length > 0) {
    throw new Error(`${LOG} list period missing: ${missingPeriod.join(',')}`)
  }
  return ids
}

function createServiceClient(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('Supabase service credentials are missing')
  if (key === process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Refusing to use the publishable key')
  }
  return createClient(url, key, {
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

function listItem(id: string): WalkerplusListEvent {
  const period = WALKERPLUS_BATCH3_LIST_PERIODS[id] ?? ''
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

function detailFromCache(row: CachedEvent | StoredDetail): StoredDetail | null {
  if ('detail' in row && row.detail) {
    const id = row.detail.source_event_id ?? ''
    return {
      ...row.detail,
      list_period: WALKERPLUS_BATCH3_LIST_PERIODS[id] ?? row.list_period ?? row.list?.date_text ?? '',
    }
  }
  if ('source_event_id' in row && row.source_event_id) {
    const id = row.source_event_id
    return {
      ...(row as StoredDetail),
      list_period: WALKERPLUS_BATCH3_LIST_PERIODS[id] ?? (row as StoredDetail).list_period ?? '',
    }
  }
  return null
}

async function readCachedDetails(ids: readonly string[]): Promise<StoredDetail[]> {
  try {
    const parsed = JSON.parse(await readFile(DETAILS_PATH, 'utf8')) as {
      events?: Array<CachedEvent | StoredDetail>
    }
    const allowed = new Set(ids)
    const rows: StoredDetail[] = []
    for (const row of parsed.events ?? []) {
      const detail = detailFromCache(row)
      if (!detail || !allowed.has(detail.source_event_id ?? '')) continue
      rows.push(detail)
    }
    return rows
  } catch {
    return []
  }
}

async function loadOrFetchDetails(ids: readonly string[]): Promise<StoredDetail[]> {
  const stored = await readCachedDetails(ids)
  const byId = new Map(stored.map((row) => [row.source_event_id ?? '', row]))
  const missing = ids.filter((id) => !byId.get(id)?.start_date)
  if (missing.length === 0) return ids.map((id) => byId.get(id)!)

  await mkdir(path.dirname(DETAILS_PATH), { recursive: true })
  let cachedEvents: CachedEvent[] = []
  try {
    const parsed = JSON.parse(await readFile(DETAILS_PATH, 'utf8')) as {
      events?: CachedEvent[]
    }
    cachedEvents = parsed.events ?? []
  } catch {
    cachedEvents = []
  }

  for (let i = 0; i < missing.length; i++) {
    if (i > 0) {
      const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
      console.log(`${LOG} sleep ${gap}ms`)
      await sleep(gap)
    }
    const id = missing[i]
    const url = `https://www.walkerplus.com/event/${id}/`
    console.log(`${LOG} detail ${i + 1}/${missing.length} ${url}`)
    const response = await fetchHtml(url)
    if (response.status !== 200) throw new Error(`${id} HTTP ${response.status}`)
    const item = listItem(id)
    let priceHtml: string | null = null
    const preliminary = extractWalkerplusDetail(response.html, url, item)
    if (!preliminary.price_text) {
      const priceUrl = buildPricePageUrl(url, response.html)
      if (priceUrl) {
        const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
        console.log(`${LOG} price sleep ${gap}ms`)
        await sleep(gap)
        const price = await fetchHtml(priceUrl)
        if (price.status === 200) priceHtml = price.html
      }
    }
    const extracted = extractWalkerplusDetail(response.html, url, item, priceHtml)
    const detail: StoredDetail = {
      ...extracted,
      source_event_id: id,
      list_period: WALKERPLUS_BATCH3_LIST_PERIODS[id] ?? '',
    }
    byId.set(id, detail)
    const next: CachedEvent = {
      list: item,
      detail,
      list_period: detail.list_period,
    }
    const index = cachedEvents.findIndex(
      (row) => (row.detail?.source_event_id ?? '') === id,
    )
    if (index >= 0) cachedEvents[index] = next
    else cachedEvents.push(next)
    await writeFile(
      DETAILS_PATH,
      JSON.stringify({ events: cachedEvents }, null, 2),
      'utf8',
    )
  }

  const ready = ids
    .map((id) => byId.get(id))
    .filter((row): row is StoredDetail => Boolean(row?.start_date))
  if (ready.length !== ids.length) {
    throw new Error(`${LOG} details ${ready.length}/${ids.length}`)
  }
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
  const { data: sources, error: sourceError } = await client
    .from('event_sources')
    .select('event_id, source_name, source_url, source_event_id')
  if (sourceError) throw sourceError

  const alternateUrls = new Map<number, string[]>()
  const attached = new Set<string>()
  for (const source of sources ?? []) {
    if (source.source_name === 'walkerplus') {
      for (const key of walkerplusIdKeys(source.source_event_id)) attached.add(key)
      for (const key of walkerplusIdKeys(source.source_url)) attached.add(key)
    }
    const eventId = Number(source.event_id)
    if (!Number.isFinite(eventId) || !source.source_url) continue
    const urls = alternateUrls.get(eventId) ?? []
    urls.push(String(source.source_url))
    alternateUrls.set(eventId, urls)
  }

  return {
    pool: (data ?? []).map((row) => ({
      id: row.id,
      slug: String(row.slug),
      title: row.title,
      start_date: row.start_date,
      end_date: row.end_date,
      venue: row.venue,
      area: row.area,
      official_url: row.official_url,
      source_url: row.source_url,
      status: row.status,
      alternate_source_urls: alternateUrls.get(Number(row.id)) ?? null,
    })),
    attached,
  }
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

function alreadyAttached(detail: StoredDetail, attached: Set<string>): boolean {
  const keys = [
    ...walkerplusIdKeys(detail.source_event_id),
    ...walkerplusIdKeys(detail.source_url),
  ]
  return keys.some((key) => attached.has(key))
}

function planOne(
  detail: StoredDetail,
  pool: DedupeExisting[],
  attached: Set<string>,
): Plan {
  const schedule = planWalkerplusSchedule({
    listPeriod: detail.list_period,
    startDate: detail.start_date ?? '1970-01-01',
    endDate: detail.end_date,
    startTime: normalizeHmToDb(detail.start_time),
    endTime: normalizeHmToDb(detail.end_time),
    today: WALKERPLUS_BATCH3_TODAY,
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
  const address = cleanAddressAccess(detail.address) ?? detail.address?.trim() ?? null
  const place = resolveEventPlace({
    areaHint: detail.area_locality,
    address,
    venue: detail.venue,
  })
  const category = mapWalkerplusCategories(detail.categories).mapped
  const planned: Plan = {
    detail,
    status: match.duplicate_status,
    action: 'insert',
    slug: slugFor(detail, schedule.start_date),
    municipality: place.municipality,
    category,
    priceType: inferPriceTypeFromPriceText(detail.price_text),
    isKids: inferKidsFromWalkerplusCategories(detail.categories, detail.title),
    isIndoor: null,
    isNight: inferIsNight({
      title: detail.title,
      description: detail.description,
      venue: detail.venue,
      startTime: detail.start_time,
      endTime: detail.end_time,
    }),
    schedule,
  }
  if (alreadyAttached(detail, attached)) {
    planned.action = 'skip'
  } else if (match.duplicate_status !== 'none') {
    planned.action = 'reclassified'
  } else {
    const active = resolveScheduleStatus(
      schedule.occurrences.map((row) => ({
        start: row.start_date,
        end: row.end_date,
      })),
      {
        start_date: schedule.start_date,
        end_date: schedule.end_date,
      },
      WALKERPLUS_BATCH3_TODAY,
    )
    if (
      !detail.title ||
      !detail.start_date ||
      (active !== 'today' && active !== 'upcoming')
    ) {
      planned.action = 'skip'
    }
  }
  return planned
}

async function insertDraft(client: SupabaseClient, plan: Plan): Promise<void> {
  const detail = plan.detail
  const now = new Date().toISOString()
  const address = cleanAddressAccess(detail.address) ?? detail.address?.trim() ?? null
  const place = resolveEventPlace({
    areaHint: detail.area_locality,
    address,
    venue: detail.venue,
  })
  const imageMeta = detail.image_url
    ? defaultImageMetaForSource('walkerplus')
    : {
        image_usage_status: 'unknown' as const,
        image_source: null,
        image_credit: null,
      }
  const { data: existing, error: selectError } = await client
    .from('events')
    .select('id, status')
    .eq('slug', plan.slug)
    .maybeSingle()
  if (selectError) throw selectError
  if (existing && existing.status !== 'draft') {
    throw new Error(`slug ${plan.slug} is ${existing.status}; refused`)
  }

  let eventId = existing?.id ? Number(existing.id) : null
  if (!eventId) {
    const { data: inserted, error } = await client
      .from('events')
      .insert({
        title: detail.title!.trim(),
        slug: plan.slug,
        official_url: detail.official_url ?? null,
        source_url: detail.source_url,
        venue: detail.venue ?? null,
        area: place.area,
        municipality: place.municipality,
        address,
        start_date: plan.schedule.start_date,
        end_date: plan.schedule.end_date,
        start_time: normalizeHmToDb(detail.start_time),
        end_time: normalizeHmToDb(detail.end_time),
        price_text: detail.price_text ?? null,
        price_type: plan.priceType,
        is_indoor: null,
        is_kids: plan.isKids,
        is_night: plan.isNight,
        category: plan.category,
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
      source_name: 'walkerplus',
      source_url: detail.source_url,
      source_event_id: detail.source_event_id,
      official_url: detail.official_url ?? null,
      last_checked_at: now,
    },
    true,
    LOG,
  )
  if (plan.schedule.occurrences.length === 0) return

  const { data: existingRows, error: occurrenceReadError } = await client
    .from('event_occurrences')
    .select('start_date, end_date, start_time, end_time')
    .eq('event_id', eventId)
  if (occurrenceReadError) throw occurrenceReadError
  const seen = new Set(
    (existingRows ?? []).map(
      (row) =>
        `${row.start_date}|${row.end_date}|${row.start_time ?? ''}|${row.end_time ?? ''}`,
    ),
  )
  const rows = plan.schedule.occurrences
    .filter((occurrence: WalkerplusOccurrencePlan) => {
      const key = `${occurrence.start_date}|${occurrence.end_date}|${occurrence.start_time ?? ''}|${occurrence.end_time ?? ''}`
      return !seen.has(key)
    })
    .map((occurrence: WalkerplusOccurrencePlan) => ({
      event_id: eventId,
      start_date: occurrence.start_date,
      end_date: occurrence.end_date,
      start_time: occurrence.start_time,
      end_time: occurrence.end_time,
    }))
  if (rows.length === 0) return
  const { error } = await client.from('event_occurrences').insert(rows)
  if (error) throw error
}

function isOtherOnly(category: string[]): boolean {
  return category.length > 0 && category.every((item) => item === 'other')
}

async function main() {
  const ids = assertAllowlist()
  const allowed = new Set(ids)
  console.log(`${LOG} targets ${ids.length}`)
  console.log(`${LOG} DRY_RUN ${DRY_RUN}`)
  if (process.env.DRY_RUN === 'false' && DRY_RUN) {
    console.log(`${LOG} .env DRY_RUN=false is ignored without --write`)
  }
  console.log(`${LOG} Batch 1 and Batch 2 are not used`)
  const details = await loadOrFetchDetails(ids)
  if (
    details.length !== ids.length ||
    details.some((detail) => !allowed.has(detail.source_event_id ?? ''))
  ) {
    throw new Error(`${LOG} refusing details outside fixed allowlist`)
  }

  const client = createServiceClient()
  const { pool, attached } = await loadPool(client)
  const plans = details.map((detail) => planOne(detail, pool, attached))
  const inserts = plans.filter((plan) => plan.action === 'insert')
  if (inserts.some((plan) => plan.status !== 'none')) {
    throw new Error(`${LOG} refusing to insert a duplicate match`)
  }
  const skips = plans.filter((plan) => plan.action === 'skip')
  const reclassified = plans.filter((plan) => plan.action === 'reclassified')
  const countStatus = (status: DuplicateStatus) =>
    reclassified.filter((plan) => plan.status === status).length
  const report = {
    target: plans.length,
    insert: inserts.length,
    skip: skips.length,
    exact: countStatus('exact'),
    likely: countStatus('likely'),
    ambiguous: countStatus('ambiguous'),
    errors: 0,
    municipalityNull: inserts.filter((plan) => !plan.municipality).length,
    priceTypeNull: inserts.filter((plan) => plan.priceType == null).length,
    otherOnly: inserts.filter((plan) => isOtherOnly(plan.category)).length,
    isKidsTrue: inserts.filter((plan) => plan.isKids === true).length,
    isIndoorTrue: inserts.filter((plan) => plan.isIndoor === true).length,
    isNightTrue: inserts.filter((plan) => plan.isNight === true).length,
    occurrenceEvents: inserts.filter((plan) => plan.schedule.occurrences.length > 0)
      .length,
    occurrenceIds: inserts
      .filter((plan) => plan.schedule.occurrences.length > 0)
      .map((plan) => plan.detail.source_event_id),
  }
  console.log(`${LOG} report ${JSON.stringify(report)}`)
  const focus = plans.find((plan) => plan.detail.source_event_id === FOCUS_ID)
  if (!focus) throw new Error(`${LOG} ${FOCUS_ID} was not planned`)
  console.log(
    `${LOG} ${FOCUS_ID} ${JSON.stringify({
      action: focus.action,
      duplicate: focus.status,
      listPeriod: focus.detail.list_period,
      detailStart: focus.detail.start_date,
      detailEnd: focus.detail.end_date,
      start: focus.schedule.start_date,
      end: focus.schedule.end_date,
      occurrences: focus.schedule.occurrences.length,
      municipality: focus.municipality,
      priceType: focus.priceType,
      category: focus.category,
      isKids: focus.isKids,
      isIndoor: focus.isIndoor,
      isNight: focus.isNight,
      slug: focus.slug,
    })}`,
  )
  if (DRY_RUN) {
    console.log(`${LOG} dry-run only, no DB write`)
    return
  }

  for (const plan of inserts) {
    try {
      await insertDraft(client, plan)
      console.log(`${LOG} inserted ${plan.slug}`)
    } catch (error) {
      report.errors += 1
      console.error(
        `${LOG} error ${plan.slug}`,
        error instanceof Error ? error.message : error,
      )
    }
  }
  console.log(`${LOG} write errors ${report.errors}`)
}

main().catch((error) => {
  console.error(`${LOG} fatal`, error)
  process.exit(1)
})
