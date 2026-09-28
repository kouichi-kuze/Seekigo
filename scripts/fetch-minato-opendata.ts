/**
 * 港区オープンデータ Phase 1 — CSV 取得・正規化・フィルタ（DB 非接触）
 *
 * 出力: tmp/minato-events.json
 *
 *   npx tsx scripts/fetch-minato-opendata.ts
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MINATO_EVENT_CSV_URL,
  MINATO_LICENSE,
  MINATO_OPENDATA_SOURCE,
  isActive,
  nextOccurrenceDate,
  normalizeMinatoCsv,
  type MinatoAreaStatus,
  type MinatoNormalizedEvent,
} from './lib/minato-opendata'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const outPath = path.join(rootDir, 'tmp', 'minato-events.json')

async function fetchCsv(url: string): Promise<string> {
  console.log(`[fetch-minato] GET ${url}`)
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/csv,text/plain,*/*;q=0.8',
      'Accept-Language': 'ja,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  })
  console.log(`[fetch-minato] status: ${response.status}`)
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  const utf8 = new TextDecoder('utf-8').decode(buffer)
  if (utf8.includes('ページタイトル')) return utf8
  return new TextDecoder('shift_jis').decode(buffer)
}

function printActive(label: string, events: MinatoNormalizedEvent[], asOf: string): void {
  console.log(`[fetch-minato] --- ${label} ${events.length} ---`)
  events.forEach((event, index) => {
    const when = nextOccurrenceDate(event.occurrences, asOf) ?? '日付不明'
    console.log(`[fetch-minato] ${index + 1}. ${event.title ?? '(no title)'}`)
    console.log(
      `[fetch-minato]    ${when} | ${event.area_status} | ${event.filter_reason}`,
    )
  })
}

async function main() {
  const asOf = process.env.MINATO_AS_OF?.trim() || '2026-09-27'
  console.log(`[fetch-minato] source=${MINATO_OPENDATA_SOURCE} as_of=${asOf}`)
  const csv = await fetchCsv(MINATO_EVENT_CSV_URL)
  const events = normalizeMinatoCsv(csv, asOf)

  const lifecycle = { future: 0, ongoing: 0, ended: 0, unknown: 0 }
  const filter = { include: 0, exclude: 0, review: 0 }
  const activeIncludeArea: Record<MinatoAreaStatus, number> = {
    minato: 0,
    outside_minato: 0,
    unknown: 0,
  }
  let activeInclude = 0
  let activeReview = 0
  let multipleParsed = 0
  for (const event of events) {
    lifecycle[event.lifecycle] += 1
    filter[event.filter_status] += 1
    if (event.date_status === 'multiple' || event.date_status === 'partial') {
      if (event.occurrences.length > 0) multipleParsed += 1
    }
    if (!isActive(event)) continue
    if (event.filter_status === 'include') {
      activeInclude += 1
      activeIncludeArea[event.area_status] += 1
    }
    if (event.filter_status === 'review') activeReview += 1
  }

  console.log(`[fetch-minato] total ${events.length}`)
  console.log(`[fetch-minato] lifecycle.future ${lifecycle.future}`)
  console.log(`[fetch-minato] lifecycle.ongoing ${lifecycle.ongoing}`)
  console.log(`[fetch-minato] lifecycle.ended ${lifecycle.ended}`)
  console.log(`[fetch-minato] lifecycle.unknown ${lifecycle.unknown}`)
  console.log(`[fetch-minato] filter.include ${filter.include}`)
  console.log(`[fetch-minato] filter.exclude ${filter.exclude}`)
  console.log(`[fetch-minato] filter.review ${filter.review}`)
  console.log(`[fetch-minato] active_include ${activeInclude}`)
  console.log(`[fetch-minato] active_review ${activeReview}`)
  console.log(`[fetch-minato] active_include.minato ${activeIncludeArea.minato}`)
  console.log(`[fetch-minato] active_include.outside_minato ${activeIncludeArea.outside_minato}`)
  console.log(`[fetch-minato] active_include.unknown ${activeIncludeArea.unknown}`)
  console.log(`[fetch-minato] multiple_parsed ${multipleParsed}`)

  printActive(
    'active_include',
    events.filter((event) => isActive(event) && event.filter_status === 'include'),
    asOf,
  )
  printActive(
    'active_review',
    events.filter((event) => isActive(event) && event.filter_status === 'review'),
    asOf,
  )

  await mkdir(path.dirname(outPath), { recursive: true })
  const payload = {
    fetchedAt: new Date().toISOString(),
    asOf,
    phase: '1.1',
    source: MINATO_OPENDATA_SOURCE,
    sourceUrl: MINATO_EVENT_CSV_URL,
    license: MINATO_LICENSE,
    counts: {
      total: events.length,
      lifecycle,
      filter,
      active_include: activeInclude,
      active_review: activeReview,
      active_include_area: activeIncludeArea,
      multiple_parsed: multipleParsed,
    },
    events,
  }
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(`[fetch-minato] saved → ${path.relative(rootDir, outPath)}`)
  console.log('[fetch-minato] done (no DB write)')
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((error) => {
    console.error('[fetch-minato] fatal:', error)
    process.exit(1)
  })
}
