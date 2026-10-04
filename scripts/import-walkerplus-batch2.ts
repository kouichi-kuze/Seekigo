/**
 * Walkerplus Batch 2専用インポーター。
 * 東京都一覧31〜40ページの監査で確定したnew 70件以外は扱わない。
 * 既定はDRY_RUN=true。published本体は更新しない。
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
  WALKERPLUS_BATCH2_LIST_PERIODS,
  WALKERPLUS_BATCH2_SOURCE_IDS,
  WALKERPLUS_BATCH2_TODAY,
} from './data/walkerplus-batch2-ids'
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

const DRY_RUN = process.env.DRY_RUN !== 'false'
const LOG = '[walkerplus-batch2]'
const DETAILS_PATH = path.resolve('tmp/walkerplus-batch2-31-40-details.json')
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

function assertAllowlist(): readonly string[] {
  const ids = [...WALKERPLUS_BATCH2_SOURCE_IDS]
  if (ids.length !== 70 || new Set(ids).size !== 70) {
    throw new Error(`${LOG} allowlist must be exactly 70 unique ids`)
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
  const period = WALKERPLUS_BATCH2_LIST_PERIODS[id] ?? ''
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

async function readCachedDetails(): Promise<StoredDetail[]> {
  try {
    const parsed = JSON.parse(await readFile(DETAILS_PATH, 'utf8')) as {
      events?: Array<
        | StoredDetail
        | {
            list?: WalkerplusListEvent
            detail?: WalkerplusEventDetail
          }
      >
    }
    const rows: StoredDetail[] = []
    for (const row of parsed.events ?? []) {
      if ('detail' in row && row.detail) {
        const id = row.detail.source_event_id ?? ''
        rows.push({
          ...row.detail,
          list_period:
            WALKERPLUS_BATCH2_LIST_PERIODS[id] ?? row.list?.date_text ?? '',
        })
      } else if ('source_event_id' in row) {
        rows.push(row as StoredDetail)
      }
    }
    return rows
  } catch {
    return []
  }
}

async function loadOrFetchDetails(ids: readonly string[]): Promise<StoredDetail[]> {
  let stored = await readCachedDetails()
  const byId = new Map(stored.map((row) => [row.source_event_id ?? '', row]))
  const missing = ids.filter((id) => !byId.get(id)?.start_date)
  await mkdir(path.dirname(DETAILS_PATH), { recursive: true })

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
    const detail: StoredDetail = {
      ...extractWalkerplusDetail(response.html, url, item, priceHtml),
      list_period: WALKERPLUS_BATCH2_LIST_PERIODS[id] ?? '',
    }
    byId.set(id, detail)
    stored = ids
      .map((sourceId) => byId.get(sourceId))
      .filter((row): row is StoredDetail => Boolean(row))
    await writeFile(DETAILS_PATH, JSON.stringify({ events: stored }, null, 2), 'utf8')
  }

  const ready = ids
    .map((id) => byId.get(id))
    .filter((row): row is StoredDetail => Boolean(row))
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
    const eventId = Number(source.event_id)
    if (source.source_name === 'walkerplus' && source.source_event_id) {
      attached.add(String(source.source_event_id).toLowerCase())
    }
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
    today: WALKERPLUS_BATCH2_TODAY,
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
    isKids: inferKidsFromWalkerplusCategories(detail.categories),
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
  if (attached.has((detail.source_event_id ?? '').toLowerCase())) {
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
      WALKERPLUS_BATCH2_TODAY,
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
  if (plan.schedule.occurrences.length > 0) {
    const rows = plan.schedule.occurrences.map(
      (occurrence: WalkerplusOccurrencePlan) => ({
        event_id: eventId,
        start_date: occurrence.start_date,
        end_date: occurrence.end_date,
        start_time: occurrence.start_time,
        end_time: occurrence.end_time,
      }),
    )
    const { error } = await client.from('event_occurrences').insert(rows)
    if (error) throw error
  }
}

function triStateCounts(values: Array<boolean | null>): {
  true: number
  false: number
  null: number
} {
  return {
    true: values.filter((value) => value === true).length,
    false: values.filter((value) => value === false).length,
    null: values.filter((value) => value == null).length,
  }
}

async function main() {
  const ids = assertAllowlist()
  console.log(`${LOG} targets ${ids.length}`)
  console.log(`${LOG} DRY_RUN ${DRY_RUN}`)
  console.log(`${LOG} Batch 1 is not used`)
  const details = await loadOrFetchDetails(ids)
  if (
    details.length !== ids.length ||
    details.some((detail) => !ids.includes(detail.source_event_id ?? ''))
  ) {
    throw new Error(`${LOG} refusing details outside fixed allowlist`)
  }

  const client = createServiceClient()
  const { pool, attached } = await loadPool(client)
  const plans = details.map((detail) => planOne(detail, pool, attached))
  const inserts = plans.filter((plan) => plan.action === 'insert')
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
    municipalityNull: inserts.filter((plan) => !plan.municipality).length,
    otherOnly: inserts.filter(
      (plan) => plan.category.length === 1 && plan.category[0] === 'other',
    ).length,
    priceTypeNull: inserts.filter((plan) => plan.priceType == null).length,
    isKids: triStateCounts(inserts.map((plan) => plan.isKids)),
    isIndoor: triStateCounts(inserts.map((plan) => plan.isIndoor)),
    isNight: triStateCounts(inserts.map((plan) => plan.isNight)),
    occurrenceEvents: inserts.filter(
      (plan) => plan.schedule.occurrences.length > 0,
    ).length,
    occurrenceRows: inserts.reduce(
      (sum, plan) => sum + plan.schedule.occurrences.length,
      0,
    ),
    occurrenceIds: inserts
      .filter((plan) => plan.schedule.occurrences.length > 0)
      .map((plan) => plan.detail.source_event_id),
    errors: 0,
  }
  console.log(`${LOG} report ${JSON.stringify(report)}`)
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
