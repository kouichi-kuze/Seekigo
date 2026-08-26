/**
 * レッツエンジョイ東京詳細 JSON と public.events の重複判定（読取のみ・AI不使用）。
 *
 * 入力: tmp/enjoytokyo-event-details.json（最大10件）
 * 出力: tmp/enjoytokyo-dedupe-results.json + コンソール
 *
 * DB は更新しない。
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  formatDedupeLog,
  matchAgainstExisting,
  type DedupeExisting,
  type DuplicateMatchResult,
} from '../src/lib/event-dedupe'

config()

const MAX_COMPARE = 10

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const detailsPath = path.join(tmpDir, 'enjoytokyo-event-details.json')
const outPath = path.join(tmpDir, 'enjoytokyo-dedupe-results.json')

type EnjoyDetail = {
  title: string | null
  start_date: string | null
  end_date: string | null
  venue: string | null
  area?: string | null
  official_url: string | null
  source_url: string | null
  error?: string | null
}

type DetailsFile = {
  events?: EnjoyDetail[]
  fetchedAt?: string
}

type DedupeRow = EnjoyDetail &
  DuplicateMatchResult & {
    index: number
  }

function createReadClient(): SupabaseClient {
  const url =
    process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  const publishable = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()

  if (!url) {
    throw new Error('PUBLIC_SUPABASE_URL (or SUPABASE_URL) is missing in .env')
  }

  // 読取のみ。全 status を見るため Service Role を優先
  const key = serviceKey || publishable
  if (!key) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY or PUBLIC_SUPABASE_PUBLISHABLE_KEY is required',
    )
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

async function fetchExistingEvents(
  supabase: SupabaseClient,
): Promise<DedupeExisting[]> {
  const { data, error } = await supabase
    .from('events')
    .select(
      'id, slug, title, start_date, end_date, venue, area, official_url, source_url, status',
    )
    .order('start_date', { ascending: true })

  if (error) {
    throw new Error(`Failed to fetch public.events: ${error.message}`)
  }

  const { data: sources, error: srcErr } = await supabase
    .from('event_sources')
    .select('event_id, source_url')

  if (srcErr) {
    throw new Error(`Failed to fetch event_sources: ${srcErr.message}`)
  }

  const alts = new Map<number, string[]>()
  for (const s of sources ?? []) {
    const id = Number(s.event_id)
    if (!Number.isFinite(id) || !s.source_url) continue
    const list = alts.get(id) ?? []
    list.push(String(s.source_url))
    alts.set(id, list)
  }

  return (data ?? []).map((row) => {
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

function logRow(row: DedupeRow) {
  for (const line of formatDedupeLog({
    status: row.duplicate_status,
    incomingTitle: row.title,
    match: row,
  })) {
    console.log(`[dedupe:enjoytokyo] ${line}`)
  }
}

async function main() {
  console.log('[dedupe:enjoytokyo] start')
  console.log('[dedupe:enjoytokyo] AI: unused / DB write: none')
  console.log(`[dedupe:enjoytokyo] max compare: ${MAX_COMPARE}`)

  let file: DetailsFile
  try {
    const raw = await readFile(detailsPath, 'utf8')
    file = JSON.parse(raw) as DetailsFile
  } catch (error) {
    console.error(
      '[dedupe:enjoytokyo] failed to read tmp/enjoytokyo-event-details.json — run `npm run fetch:enjoytokyo:details` first',
      error,
    )
    process.exit(1)
  }

  const candidates = (file.events ?? [])
    .filter((e) => !e.error)
    .slice(0, MAX_COMPARE)

  if (candidates.length === 0) {
    console.error('[dedupe:enjoytokyo] no events in enjoytokyo-event-details.json')
    process.exit(1)
  }

  console.log(`[dedupe:enjoytokyo] candidates: ${candidates.length}`)

  const supabase = createReadClient()
  const existing = await fetchExistingEvents(supabase)
  console.log(`[dedupe:enjoytokyo] existing public.events: ${existing.length}`)

  const results: DedupeRow[] = []
  const summary = {
    exact: 0,
    likely: 0,
    ambiguous: 0,
    none: 0,
  }

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const match = matchAgainstExisting(
      {
        title: c.title,
        start_date: c.start_date,
        end_date: c.end_date,
        venue: c.venue,
        area: c.area ?? null,
        official_url: c.official_url,
        source_url: c.source_url,
      },
      existing,
    )

    summary[match.duplicate_status] += 1

    const row: DedupeRow = {
      index: i + 1,
      title: c.title,
      start_date: c.start_date,
      end_date: c.end_date,
      venue: c.venue,
      official_url: c.official_url,
      source_url: c.source_url,
      ...match,
    }
    results.push(row)
    logRow(row)
  }

  // 確認用ターゲット
  const watchTitles = [
    '原宿表参道元氣祭スーパーよさこい',
    '東京高円寺阿波おどり',
  ]
  console.log('[dedupe:enjoytokyo] ---- watch targets ----')
  for (const tip of watchTitles) {
    const hit = results.find((r) => (r.title ?? '').includes(tip.replace(/\s/g, '')) || (r.title ?? '').includes(tip))
    if (!hit) {
      console.log(
        `[dedupe:enjoytokyo] NOT IN CANDIDATES: ${tip} (details JSON に含まれていません)`,
      )
      continue
    }
    console.log(
      `[dedupe:enjoytokyo] WATCH: "${hit.title}" => ${hit.duplicate_status}` +
        ` id=${hit.matched_event_id ?? 'null'}` +
        ` slug=${hit.matched_event_slug ?? 'null'} confidence=${hit.confidence}` +
        ` action=${hit.recommended_action}`,
    )
  }

  await mkdir(tmpDir, { recursive: true })
  const payload = {
    comparedAt: new Date().toISOString(),
    sourceDetails: 'tmp/enjoytokyo-event-details.json',
    candidateCount: candidates.length,
    existingCount: existing.length,
    summary,
    note: 'Read-only comparison. No AI. No DB writes.',
    results,
  }
  await writeFile(outPath, JSON.stringify(payload, null, 2), 'utf8')

  console.log('[dedupe:enjoytokyo] ---- summary ----')
  console.log(
    `[dedupe:enjoytokyo] exact=${summary.exact} likely=${summary.likely} ambiguous=${summary.ambiguous} none=${summary.none}`,
  )
  console.log(`[dedupe:enjoytokyo] saved ${outPath} (gitignored)`)
  console.log('[dedupe:enjoytokyo] done')
}

main().catch((error) => {
  console.error('[dedupe:enjoytokyo] failed', error)
  process.exit(1)
})
