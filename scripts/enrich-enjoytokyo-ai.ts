/**
 * EnjoyTokyo 由来の draft イベントのみ AI 整形して更新する。
 *
 * 対象:
 * - event_sources.source_name = enjoytokyo
 * - events.status = draft
 * - slug が enjoytokyo-*（新規作成分。exact attach の published は対象外）
 *
 * AI 更新フィールドのみ: area / is_free / is_indoor / is_kids / is_night / category / summary
 * area / is_free は deterministic 判定を優先し、AI は判定不能時のみ fallback。
 * 事実フィールド（日時・会場・住所・料金原文・URL・画像）は絶対に変更しない。
 *
 * DRY_RUN=true（デフォルト）: AI 結果を表示するだけ
 * DRY_RUN=false: draft のみ UPDATE
 */
import { config } from 'dotenv'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_OPENAI_MODEL,
  enrichEventWithAi,
  type AiEnrichment,
} from './lib/ai-enrichment'
import {
  inferIsFreeFromPriceText,
  resolveAreaSlug,
} from '../src/lib/event-field-rules'

config()

const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'enjoytokyo'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const detailsPath = path.join(rootDir, 'tmp', 'enjoytokyo-event-details.json')

type DbEvent = {
  id: number
  slug: string
  title: string
  status: string
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  price_text: string | null
  official_url: string | null
  source_url: string | null
  image_url: string | null
  area: string | null
  is_free: boolean | null
  is_indoor: boolean | null
  is_kids: boolean | null
  is_night: boolean | null
  category: string[] | null
  summary: string | null
}

type DetailExtra = {
  description: string | null
  area: string | null
}

type DetailsFile = {
  events?: Array<{
    source_url?: string | null
    description?: string | null
    area?: string | null
    error?: string | null
  }>
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
    throw new Error('Refusing to use PUBLIC_SUPABASE_PUBLISHABLE_KEY')
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

async function loadDetailExtras(): Promise<Map<string, DetailExtra>> {
  const map = new Map<string, DetailExtra>()
  try {
    const raw = await readFile(detailsPath, 'utf8')
    const file = JSON.parse(raw) as DetailsFile
    for (const e of file.events ?? []) {
      if (!e.source_url || e.error) continue
      map.set(e.source_url, {
        description: e.description ?? null,
        area: e.area ?? null,
      })
    }
  } catch {
    console.warn(
      '[enrich-enjoytokyo-ai] warning: could not read tmp/enjoytokyo-event-details.json — summary will use DB summary only',
    )
  }
  return map
}

/**
 * EnjoyTokyo 新規 draft のみ取得。
 * published への exact attach は slug が enjoytokyo-* ではないため除外される。
 */
async function fetchTargetDrafts(supabase: SupabaseClient): Promise<DbEvent[]> {
  const { data: sources, error: srcErr } = await supabase
    .from('event_sources')
    .select('event_id')
    .eq('source_name', SOURCE_NAME)

  if (srcErr) {
    throw new Error(`event_sources fetch failed: ${srcErr.message}`)
  }

  const eventIds = [...new Set((sources ?? []).map((s) => Number(s.event_id)))]
  if (eventIds.length === 0) return []

  const { data: events, error: evErr } = await supabase
    .from('events')
    .select(
      'id, slug, title, status, start_date, end_date, start_time, end_time, venue, address, price_text, official_url, source_url, image_url, area, is_free, is_indoor, is_kids, is_night, category, summary',
    )
    .in('id', eventIds)
    .eq('status', 'draft')
    .like('slug', 'enjoytokyo-%')
    .order('id', { ascending: true })

  if (evErr) {
    throw new Error(`events fetch failed: ${evErr.message}`)
  }

  return (events ?? []) as DbEvent[]
}

function logResult(
  index: number,
  total: number,
  event: DbEvent,
  ai: AiEnrichment | null,
  aiError: string | null,
  resolved?: { area: string | null; is_free: boolean | null; ruleArea: string | null; ruleIsFree: boolean | null },
) {
  console.log(`[enrich-enjoytokyo-ai] ---- ${index}/${total} ----`)
  console.log(`[enrich-enjoytokyo-ai] title: ${event.title}`)
  console.log(`[enrich-enjoytokyo-ai] slug: ${event.slug}`)
  if (aiError) {
    console.log(`[enrich-enjoytokyo-ai] ai_error: ${aiError}`)
  }
  if (resolved) {
    console.log(
      `[enrich-enjoytokyo-ai] area: ${resolved.area} (rule=${resolved.ruleArea} ai=${ai?.area.value ?? null})`,
    )
    console.log(
      `[enrich-enjoytokyo-ai] is_free: ${resolved.is_free} (rule=${resolved.ruleIsFree} ai=${ai?.is_free.value ?? null})`,
    )
  } else {
    console.log(`[enrich-enjoytokyo-ai] area: ${ai?.area.value ?? null}`)
    console.log(`[enrich-enjoytokyo-ai] is_free: ${ai?.is_free.value ?? null}`)
  }
  console.log(`[enrich-enjoytokyo-ai] is_indoor: ${ai?.is_indoor.value ?? null}`)
  console.log(`[enrich-enjoytokyo-ai] is_kids: ${ai?.is_kids.value ?? null}`)
  console.log(`[enrich-enjoytokyo-ai] is_night: ${ai?.is_night.value ?? null}`)
  console.log(
    `[enrich-enjoytokyo-ai] category: ${JSON.stringify(ai?.category ?? [])}`,
  )
  console.log(`[enrich-enjoytokyo-ai] summary: ${ai?.summary ?? null}`)
}

async function main() {
  console.log('[enrich-enjoytokyo-ai] start')
  console.log(`[enrich-enjoytokyo-ai] DRY_RUN: ${DRY_RUN}`)
  console.log(
    '[enrich-enjoytokyo-ai] target: enjoytokyo draft only (published never updated)',
  )

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error(
      '[enrich-enjoytokyo-ai] OPENAI_API_KEY is missing. Add it to .env and retry.',
    )
    process.exit(1)
  }

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL
  console.log(`[enrich-enjoytokyo-ai] model: ${model}`)

  const supabase = createServiceClient()
  const detailExtras = await loadDetailExtras()
  const targets = await fetchTargetDrafts(supabase)

  console.log(`[enrich-enjoytokyo-ai] candidates: ${targets.length}`)

  if (targets.length === 0) {
    console.log('[enrich-enjoytokyo-ai] nothing to process')
    console.log('[enrich-enjoytokyo-ai] ---- summary ----')
    console.log('[enrich-enjoytokyo-ai] processed: 0')
    console.log('[enrich-enjoytokyo-ai] updated: 0')
    console.log('[enrich-enjoytokyo-ai] skipped: 0')
    console.log('[enrich-enjoytokyo-ai] failed: 0')
    return
  }

  if (DRY_RUN) {
    console.log(
      '[enrich-enjoytokyo-ai] dry-run mode — AI results only (set DRY_RUN=false to update drafts)',
    )
  }

  const client = new OpenAI({ apiKey })
  let processed = 0
  let updated = 0
  let skipped = 0
  let failed = 0

  for (let i = 0; i < targets.length; i++) {
    const event = targets[i]
    processed += 1

    // 二重ガード
    if (event.status !== 'draft') {
      skipped += 1
      console.log(
        `[enrich-enjoytokyo-ai] skipped (not draft): ${event.slug} status=${event.status}`,
      )
      continue
    }
    if (!event.slug.startsWith('enjoytokyo-')) {
      skipped += 1
      console.log(
        `[enrich-enjoytokyo-ai] skipped (not enjoytokyo slug): ${event.slug}`,
      )
      continue
    }

    const extra = event.source_url
      ? detailExtras.get(event.source_url)
      : undefined
    const description =
      extra?.description ?? event.summary ?? null

    console.log(
      `[enrich-enjoytokyo-ai] processing (${i + 1}/${targets.length}): ${event.title}`,
    )

    let ai: AiEnrichment | null = null
    try {
      ai = await enrichEventWithAi(client, model, {
        title: event.title,
        description,
        venue: event.venue,
        address: event.address,
        price_text: event.price_text,
        start_date: event.start_date,
        end_date: event.end_date,
        start_time: event.start_time,
        end_time: event.end_time,
        area_hint: extra?.area ?? null,
      })

      const ruleArea = resolveAreaSlug({
        areaHint: extra?.area ?? event.area,
        address: event.address,
        venue: event.venue,
      })
      const ruleIsFree = inferIsFreeFromPriceText(event.price_text)
      const resolved = {
        ruleArea,
        ruleIsFree,
        area: ruleArea ?? ai.area.value ?? event.area ?? null,
        is_free: ruleIsFree ?? ai.is_free.value ?? null,
      }

      logResult(i + 1, targets.length, event, ai, null, resolved)

      if (DRY_RUN) {
        continue
      }

      const { data, error } = await supabase
        .from('events')
        .update({
          area: resolved.area,
          is_free: resolved.is_free,
          is_indoor: ai.is_indoor.value,
          is_kids: ai.is_kids.value,
          is_night: ai.is_night.value,
          category: ai.category,
          summary: ai.summary || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', event.id)
        .eq('status', 'draft')
        .like('slug', 'enjoytokyo-%')
        .select('id')

      if (error) throw error
      if (!data || data.length === 0) {
        skipped += 1
        console.log(
          `[enrich-enjoytokyo-ai] skipped update (no matching draft row): ${event.slug}`,
        )
        continue
      }

      updated += 1
      console.log(
        `[enrich-enjoytokyo-ai] updated ok: ${event.slug} area=${resolved.area} is_free=${resolved.is_free}`,
      )
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[enrich-enjoytokyo-ai] error: ${message}`)
      logResult(i + 1, targets.length, event, null, message)
      continue
    }
  }

  console.log('[enrich-enjoytokyo-ai] ---- summary ----')
  console.log(`[enrich-enjoytokyo-ai] processed: ${processed}`)
  console.log(`[enrich-enjoytokyo-ai] updated: ${updated}`)
  console.log(`[enrich-enjoytokyo-ai] skipped: ${skipped}`)
  console.log(`[enrich-enjoytokyo-ai] failed: ${failed}`)
  console.log(
    `[enrich-enjoytokyo-ai] done (${DRY_RUN ? 'dry-run, no DB write' : 'write mode'})`,
  )
}

main().catch((error) => {
  console.error('[enrich-enjoytokyo-ai] unexpected error:', error)
  process.exit(1)
})
