/**
 * GO TOKYO 詳細データを OpenAI で Seekigo 用に分類・要約する試作。
 * - 事実フィールドは維持（推測で上書きしない）
 * - AI は area / flags / category / summary のみ生成
 * - Supabase 書き込みなし
 */
import { config } from 'dotenv'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import OpenAI from 'openai'
import { getGotokyoLimit } from './lib/gotokyo-limit'
import {
  DEFAULT_OPENAI_MODEL,
  enrichEventWithAi,
  type AiEnrichment,
} from './lib/ai-enrichment'
import {
  cleanAddressAccess,
  inferIsFreeFromPriceText,
  resolveAreaSlug,
} from '../src/lib/event-field-rules'

config()

const MAX_EVENTS = getGotokyoLimit()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const tmpDir = path.join(rootDir, 'tmp')
const inputPath = path.join(tmpDir, 'gotokyo-event-details.json')
const outputPath = path.join(tmpDir, 'gotokyo-events-enriched.json')

type SourceEvent = {
  title: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  price_text: string | null
  official_url: string | null
  image_url: string | null
  source_url: string
  error?: string | null
  [key: string]: unknown
}

type DetailsFile = {
  fetchedAt?: string
  count?: number
  events: SourceEvent[]
}

type EnrichedEvent = {
  title: string | null
  description: string | null
  start_date: string | null
  end_date: string | null
  start_time: string | null
  end_time: string | null
  venue: string | null
  address: string | null
  price_text: string | null
  official_url: string | null
  image_url: string | null
  source_url: string
  area: string | null
  area_reason: string | null
  is_free: boolean | null
  is_free_reason: string | null
  is_indoor: boolean | null
  is_indoor_reason: string | null
  is_kids: boolean | null
  is_kids_reason: string | null
  is_night: boolean | null
  is_night_reason: string | null
  category: string[]
  summary: string | null
  ai_error: string | null
}

function preserveFacts(event: SourceEvent) {
  const address =
    cleanAddressAccess(event.address) ?? event.address ?? null
  return {
    title: event.title,
    description: event.description,
    start_date: event.start_date,
    end_date: event.end_date,
    start_time: event.start_time,
    end_time: event.end_time,
    venue: event.venue,
    address,
    price_text: event.price_text,
    official_url: event.official_url,
    image_url: event.image_url,
    source_url: event.source_url,
  }
}

function emptyEnrichment(error: string): Omit<
  EnrichedEvent,
  keyof ReturnType<typeof preserveFacts>
> {
  return {
    area: null,
    area_reason: null,
    is_free: null,
    is_free_reason: null,
    is_indoor: null,
    is_indoor_reason: null,
    is_kids: null,
    is_kids_reason: null,
    is_night: null,
    is_night_reason: null,
    category: [],
    summary: null,
    ai_error: error,
  }
}

function mergeEnrichment(event: SourceEvent, ai: AiEnrichment): EnrichedEvent {
  const facts = preserveFacts(event)
  const ruleArea = resolveAreaSlug({
    address: facts.address,
    venue: facts.venue,
  })
  const ruleIsFree = inferIsFreeFromPriceText(facts.price_text)

  return {
    ...facts,
    area: ruleArea ?? ai.area?.value ?? null,
    area_reason: ruleArea
      ? `deterministic: ${ruleArea}`
      : (ai.area?.reason ?? null),
    is_free: ruleIsFree ?? ai.is_free?.value ?? null,
    is_free_reason: ruleIsFree !== null
      ? `deterministic: ${ruleIsFree}`
      : (ai.is_free?.reason ?? null),
    is_indoor: ai.is_indoor?.value ?? null,
    is_indoor_reason: ai.is_indoor?.reason ?? null,
    is_kids: ai.is_kids?.value ?? null,
    is_kids_reason: ai.is_kids?.reason ?? null,
    is_night: ai.is_night?.value ?? null,
    is_night_reason: ai.is_night?.reason ?? null,
    category: ai.category,
    summary: ai.summary,
    ai_error: null,
  }
}

function logEnriched(index: number, event: EnrichedEvent) {
  console.log(`[enrich-events-ai] ---- ${index + 1} ----`)
  console.log(`[enrich-events-ai] title: ${event.title}`)
  if (event.ai_error) {
    console.log(`[enrich-events-ai] ai_error: ${event.ai_error}`)
  }
  console.log(`[enrich-events-ai] area: ${event.area}`)
  console.log(`[enrich-events-ai] is_free: ${event.is_free}`)
  console.log(`[enrich-events-ai] is_indoor: ${event.is_indoor}`)
  console.log(`[enrich-events-ai] is_kids: ${event.is_kids}`)
  console.log(`[enrich-events-ai] is_night: ${event.is_night}`)
  console.log(`[enrich-events-ai] category: ${JSON.stringify(event.category)}`)
  console.log(`[enrich-events-ai] summary: ${event.summary}`)
}

async function main() {
  console.log('[enrich-events-ai] start')

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    console.error(
      '[enrich-events-ai] OPENAI_API_KEY is missing. Add it to .env and retry.',
    )
    process.exit(1)
  }

  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL
  console.log(`[enrich-events-ai] model: ${model}`)
  console.log(`[enrich-events-ai] max: ${MAX_EVENTS}`)

  let file: DetailsFile
  try {
    const raw = await readFile(inputPath, 'utf8')
    file = JSON.parse(raw) as DetailsFile
  } catch (error) {
    console.error(
      '[enrich-events-ai] failed to read tmp/gotokyo-event-details.json — run `npm run fetch:gotokyo:details` first',
      error,
    )
    process.exit(1)
  }

  const candidates = (file.events ?? [])
    .filter((e) => e && !e.error)
    .slice(0, MAX_EVENTS)

  if (candidates.length === 0) {
    console.error('[enrich-events-ai] no usable events in input JSON')
    process.exit(1)
  }

  const client = new OpenAI({ apiKey })
  const enriched: EnrichedEvent[] = []

  for (let i = 0; i < candidates.length; i++) {
    const event = candidates[i]
    console.log(
      `[enrich-events-ai] processing (${i + 1}/${candidates.length}): ${event.title}`,
    )

    try {
      const ai = await enrichEventWithAi(client, model, {
        title: event.title,
        description: event.description,
        venue: event.venue,
        address: event.address,
        price_text: event.price_text,
        start_date: event.start_date,
        end_date: event.end_date,
        start_time: event.start_time,
        end_time: event.end_time,
      })
      const merged = mergeEnrichment(event, ai)
      enriched.push(merged)
      logEnriched(i, merged)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[enrich-events-ai] error: ${message}`)
      const facts = preserveFacts(event)
      const ruleArea = resolveAreaSlug({
        address: facts.address,
        venue: facts.venue,
      })
      const ruleIsFree = inferIsFreeFromPriceText(facts.price_text)
      const failed: EnrichedEvent = {
        ...facts,
        ...emptyEnrichment(message),
        area: ruleArea,
        area_reason: ruleArea ? `deterministic: ${ruleArea}` : null,
        is_free: ruleIsFree,
        is_free_reason:
          ruleIsFree !== null ? `deterministic: ${ruleIsFree}` : null,
      }
      enriched.push(failed)
      logEnriched(i, failed)
    }
  }

  await mkdir(tmpDir, { recursive: true })
  const payload = {
    enrichedAt: new Date().toISOString(),
    model,
    source: path.relative(rootDir, inputPath).replace(/\\/g, '/'),
    count: enriched.length,
    events: enriched,
  }
  await writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8')
  console.log(
    `[enrich-events-ai] saved ${path.relative(rootDir, outputPath)} (gitignored)`,
  )
  console.log('[enrich-events-ai] done (no Supabase write)')
}

main().catch((error) => {
  console.error('[enrich-events-ai] unexpected error:', error)
  process.exit(1)
})
