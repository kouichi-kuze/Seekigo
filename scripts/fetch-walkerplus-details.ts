/**
 * Walkerplus Phase 0.5 — 詳細プローブ + 重複率レポート（調査のみ・DB書込なし）
 *
 * 入力: tmp/walkerplus-events.json
 * 出力: tmp/walkerplus-event-details.json
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  matchAgainstExisting,
  type DedupeExisting,
  type DuplicateStatus,
} from '../src/lib/event-dedupe'
import type { WalkerplusListEvent } from './lib/walkerplus-parse'
import {
  buildPricePageUrl,
  classifyCategoryBuckets,
  extractWalkerplusDetail,
  fieldCompleteness,
  type CategoryBucket,
  type WalkerplusEventDetail,
} from './lib/walkerplus-detail-extract'
import { randomGapMs, sleep, WALKERPLUS_PHASE_MAX_ITEMS } from './lib/walkerplus-parse'

config()

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const MAX_ITEMS = Math.min(
  Number.parseInt(
    process.env.WALKERPLUS_MAX_ITEMS ?? String(WALKERPLUS_PHASE_MAX_ITEMS),
    10,
  ) || WALKERPLUS_PHASE_MAX_ITEMS,
  WALKERPLUS_PHASE_MAX_ITEMS,
)
const GAP_MIN_MS = 2000
const GAP_MAX_MS = 3000

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const listPath = path.join(tmpDir, 'walkerplus-events.json')
const outPath = path.join(tmpDir, 'walkerplus-event-details.json')

type DetailFailure = {
  detail_url: string
  error_type: string
}

type ExistingPoolSource = 'supabase' | 'tmp' | 'none'

const BUCKET_LABELS: Record<CategoryBucket, string> = {
  commercial: '商業施設',
  anime_game: 'アニメ・ゲーム',
  character: 'キャラクター',
  exhibition: '展覧会',
  experience: '体験',
  food: 'food',
  kids: 'kids',
  seasonal: 'seasonal',
  other: 'other',
}

function classifyFetchError(error: unknown, status?: number): string {
  if (status === 403) return 'http_403'
  if (status === 404) return 'http_404'
  if (status && status >= 500) return `http_${status}`
  if (error instanceof Error) {
    if (error.name === 'AbortError') return 'timeout'
    const msg = error.message.toLowerCase()
    if (msg.includes('abort')) return 'timeout'
    if (msg.includes('fetch')) return 'network'
  }
  return 'unknown'
}

async function fetchHtml(url: string): Promise<{ html: string; status: number }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    })
    return { html: await response.text(), status: response.status }
  } finally {
    clearTimeout(timeout)
  }
}

async function loadExistingPool(): Promise<{
  pool: DedupeExisting[]
  source: ExistingPoolSource
  note: string | null
}> {
  const url =
    process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const publishable = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (url && (serviceKey || publishable)) {
    try {
      const supabase: SupabaseClient = createClient(url, serviceKey || publishable!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
      const { data, error } = await supabase
        .from('events')
        .select(
          'id, slug, title, start_date, end_date, venue, area, official_url, source_url, status',
        )
      if (error) throw error

      const { data: sources, error: srcErr } = await supabase
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

      const pool: DedupeExisting[] = (data ?? []).map((row) => ({
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

      return {
        pool,
        source: 'supabase',
        note: `Supabase read-only (${pool.length} events)`,
      }
    } catch (error) {
      console.warn('[fetch-walkerplus-details] Supabase read failed:', error)
    }
  }

  const pool: DedupeExisting[] = []
  const tmpFiles = ['gotokyo-event-details.json', 'enjoytokyo-event-details.json'] as const

  for (const file of tmpFiles) {
    try {
      const raw = await readFile(path.join(tmpDir, file), 'utf8')
      const parsed = JSON.parse(raw) as { events?: Record<string, unknown>[] }
      for (const row of parsed.events ?? []) {
        pool.push({
          id: null,
          slug: String(row.slug ?? row.source_url ?? row.title ?? 'unknown'),
          title: (row.title as string) ?? null,
          start_date: (row.start_date as string) ?? null,
          end_date: (row.end_date as string) ?? null,
          venue: (row.venue as string) ?? null,
          area: (row.area as string) ?? null,
          official_url: (row.official_url as string) ?? null,
          source_url: (row.source_url as string) ?? null,
          status: (row.status as string) ?? 'published',
          alternate_source_urls: null,
        })
      }
    } catch {
      // optional tmp
    }
  }

  if (pool.length > 0) {
    return {
      pool,
      source: 'tmp',
      note: `tmp gotokyo/enjoytokyo details (${pool.length} rows)`,
    }
  }

  return {
    pool: [],
    source: 'none',
    note: 'No Supabase credentials and no tmp detail JSON — dedupe skipped',
  }
}

function printReport(opts: {
  listCount: number
  successes: WalkerplusEventDetail[]
  failures: DetailFailure[]
  dupCounts: Record<DuplicateStatus, number>
  dupRows: Array<{
    title: string | null
    detail_url: string
    status: DuplicateStatus
    matched_slug: string | null
  }>
  poolNote: string | null
  poolEmpty: boolean
}) {
  const { listCount, successes, failures, dupCounts, dupRows, poolNote, poolEmpty } =
    opts

  const completeness = fieldCompleteness(successes)
  const uniqueRows = dupRows.filter((r) => r.status === 'none')
  const uniqueRatio =
    successes.length > 0
      ? `${Math.round((uniqueRows.length / successes.length) * 100)}%`
      : 'n/a'

  const bucketCounts = new Map<CategoryBucket, number>()
  for (const row of uniqueRows) {
    const detail = successes.find((e) => e.source_url === row.detail_url)
    if (!detail) continue
    for (const bucket of classifyCategoryBuckets(detail.categories, detail.title)) {
      bucketCounts.set(bucket, (bucketCounts.get(bucket) ?? 0) + 1)
    }
  }

  console.log('')
  console.log('Walkerplus probe (Phase 0.5)')
  console.log(`Fetched: ${listCount}`)
  console.log(`Detail success: ${successes.length}`)
  console.log(`Detail failed: ${failures.length}`)
  console.log('')
  console.log('Field completeness:')
  for (const [field, value] of Object.entries(completeness)) {
    console.log(`${field}: ${value}`)
  }
  console.log('')
  console.log('Duplicates:')
  if (poolEmpty) {
    console.log(`(skipped — ${poolNote})`)
  } else {
    console.log(`pool: ${poolNote}`)
    console.log(`exact: ${dupCounts.exact}`)
    console.log(`likely: ${dupCounts.likely}`)
    console.log(`ambiguous: ${dupCounts.ambiguous}`)
    console.log(`none: ${dupCounts.none}`)
    console.log(`Unique ratio: ${uniqueRatio}`)
  }
  console.log('')
  console.log('Unique candidates by category:')
  if (bucketCounts.size === 0) {
    console.log('- (none)')
  } else {
    for (const [bucket, count] of [...bucketCounts.entries()].sort(
      (a, b) => b[1] - a[1],
    )) {
      console.log(`${BUCKET_LABELS[bucket]}: ${count}`)
    }
  }
  console.log('')
  console.log('Unique candidates (top 20):')
  const topUnique = uniqueRows.slice(0, 20)
  if (topUnique.length === 0) {
    console.log('- (none)')
  } else {
    for (const row of topUnique) console.log(`- ${row.title}`)
  }
}

async function main() {
  console.log('[fetch-walkerplus-details] Walkerplus probe — detail fetch (Phase 0.5)')

  const listRaw = await readFile(listPath, 'utf8')
  const listFile = JSON.parse(listRaw) as { events?: WalkerplusListEvent[] }
  const listEvents = (listFile.events ?? []).slice(0, MAX_ITEMS)

  if (listEvents.length === 0) {
    console.error(
      '[fetch-walkerplus-details] No list events. Run fetch-walkerplus.ts first.',
    )
    process.exit(1)
  }

  const successes: WalkerplusEventDetail[] = []
  const failures: DetailFailure[] = []

  for (let i = 0; i < listEvents.length; i++) {
    const item = listEvents[i]
    if (i > 0) {
      const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
      console.log(`[fetch-walkerplus-details] sleep ${gap}ms`)
      await sleep(gap)
    }

    console.log(
      `[fetch-walkerplus-details] (${i + 1}/${listEvents.length}) ${item.detail_url}`,
    )

    try {
      const { html, status } = await fetchHtml(item.detail_url)
      if (status !== 200) {
        failures.push({
          detail_url: item.detail_url,
          error_type: classifyFetchError(null, status),
        })
        continue
      }

      let priceHtml: string | null = null
      const preliminary = extractWalkerplusDetail(html, item.detail_url, item)
      if (!preliminary.price_text) {
        const priceUrl = buildPricePageUrl(item.detail_url, html)
        if (priceUrl) {
          const gap = randomGapMs(GAP_MIN_MS, GAP_MAX_MS)
          console.log(`[fetch-walkerplus-details] price page sleep ${gap}ms`)
          await sleep(gap)
          const priceRes = await fetchHtml(priceUrl)
          if (priceRes.status === 200) priceHtml = priceRes.html
        }
      }

      successes.push(extractWalkerplusDetail(html, item.detail_url, item, priceHtml))
    } catch (error) {
      failures.push({
        detail_url: item.detail_url,
        error_type: classifyFetchError(error),
      })
    }
  }

  const { pool, note } = await loadExistingPool()

  const dupCounts: Record<DuplicateStatus, number> = {
    exact: 0,
    likely: 0,
    ambiguous: 0,
    none: 0,
  }
  const dupRows: Array<{
    title: string | null
    detail_url: string
    status: DuplicateStatus
    matched_slug: string | null
  }> = []

  if (pool.length > 0) {
    for (const detail of successes) {
      const result = matchAgainstExisting(
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
      dupCounts[result.duplicate_status]++
      dupRows.push({
        title: detail.title,
        detail_url: detail.source_url,
        status: result.duplicate_status,
        matched_slug: result.matched_event_slug,
      })
    }
  }

  await mkdir(tmpDir, { recursive: true })
  const output = {
    fetchedAt: new Date().toISOString(),
    phase: '0.5',
    listSource: listPath,
    count: successes.length,
    failures,
    events: successes,
    field_completeness: fieldCompleteness(successes),
    dedupe: {
      pool_source: pool.length > 0 ? note : 'none',
      pool_note: note,
      counts: dupCounts,
      rows: dupRows,
    },
  }
  await writeFile(outPath, JSON.stringify(output, null, 2), 'utf8')

  printReport({
    listCount: listEvents.length,
    successes,
    failures,
    dupCounts,
    dupRows,
    poolNote: note,
    poolEmpty: pool.length === 0,
  })

  console.log('')
  console.log(`[fetch-walkerplus-details] saved → ${path.relative(rootDir, outPath)}`)
  console.log('[fetch-walkerplus-details] done (no DB write)')
}

main().catch((error) => {
  console.error('[fetch-walkerplus-details] fatal:', error)
  process.exit(1)
})
