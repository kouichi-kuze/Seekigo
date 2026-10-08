/**
 * 港区オープンデータ由来の draft だけを、公開前に整形する。
 *
 * 1) 正規化済み JSON の事実を写す（address / lat / lng / price_text）
 * 2) area は会場・住所だけを resolveAreaSlug に渡す。
 *    タイトルの自治体名や記念名称では決めない。特定できなければ null。
 *    price_type / is_indoor / is_kids / is_night は本文・料金・会場の明示だけ。
 *    AI の true / false ではこれらを埋めない。
 * 3) category と summary だけ既存 enrichEventWithAi を使う。
 *    summary が入力にない無料・夜間などを足していたら捨てる。
 *
 * published / hidden は更新しない。画像・訪問属性・自動公開はしない。
 *
 * category と summary が両方ある Draft は整形済み。
 * 日次の再実行では AI を呼ばず、area と各フラグも保存値のままにする。
 * null は未判定として残し、null だから再判定しない。
 * AI の対象は、新規 Draft と、category か summary が空の未整形 Draft だけ。
 *
 * DRY_RUN=true（デフォルト）: 表示のみ
 * DRY_RUN=false: 未整形の draft だけ UPDATE
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
import { inferKidsFromAudienceText } from './lib/kids-inference'
import type { MinatoNormalizedEvent } from './lib/minato-opendata'
import {
  cleanAddressAccess,
  inferPriceTypeFromPriceText,
  normalizePriceType,
  inferIsNight,
  resolveAreaSlug,
} from '../src/lib/event-field-rules'

config()

const LOG = '[enrich-minato]'
const DRY_RUN = process.env.DRY_RUN !== 'false'
const SOURCE_NAME = 'minato_opendata'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const jsonPath = path.join(rootDir, 'tmp', 'minato-events.json')

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
  area: string | null
  price_type: 'free' | 'partially_paid' | 'paid' | 'varies' | null
  is_indoor: boolean | null
  is_kids: boolean | null
  is_night: boolean | null
  category: string[] | null
  summary: string | null
  latitude: number | null
  longitude: number | null
}

type Facts = {
  address: string | null
  latitude: number | null
  longitude: number | null
  price_text: string | null
  area: string | null
  price_type: 'free' | 'partially_paid' | 'paid' | 'varies' | null
  is_indoor: boolean | null
  is_kids: boolean | null
  is_night: boolean | null
}

type Planned = Facts & {
  category: string[]
  summary: string | null
}

type JsonFile = {
  events?: MinatoNormalizedEvent[]
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

function asBool(value: unknown): boolean | null {
  if (value === true || value === false) return value
  return null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function asCategories(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter((item): item is string => typeof item === 'string')
  return items.length > 0 ? items : []
}

async function loadJsonBySourceUrl(): Promise<Map<string, MinatoNormalizedEvent>> {
  const raw = await readFile(jsonPath, 'utf8')
  const file = JSON.parse(raw) as JsonFile
  const map = new Map<string, MinatoNormalizedEvent>()
  for (const event of file.events ?? []) {
    const url = event.source_url?.trim()
    if (!url) continue
    map.set(url, event)
  }
  return map
}

async function fetchTargetDrafts(supabase: SupabaseClient): Promise<DbEvent[]> {
  const { data: sources, error: srcErr } = await supabase
    .from('event_sources')
    .select('event_id')
    .eq('source_name', SOURCE_NAME)

  if (srcErr) {
    throw new Error(`event_sources fetch failed: ${srcErr.message}`)
  }

  const eventIds = [...new Set((sources ?? []).map((row) => Number(row.event_id)))]
  if (eventIds.length === 0) return []

  const { data, error } = await supabase
    .from('events')
    .select(
      'id, slug, title, status, start_date, end_date, start_time, end_time, venue, address, price_text, official_url, source_url, area, price_type, is_indoor, is_kids, is_night, category, summary, latitude, longitude',
    )
    .in('id', eventIds)
    .eq('status', 'draft')
    .order('id', { ascending: true })

  if (error) {
    throw new Error(`events fetch failed: ${error.message}`)
  }

  return (data ?? []).map((row) => {
    const event = row as Record<string, unknown>
    return {
      id: Number(event.id),
      slug: String(event.slug ?? ''),
      title: String(event.title ?? ''),
      status: String(event.status ?? ''),
      start_date: (event.start_date as string | null) ?? null,
      end_date: (event.end_date as string | null) ?? null,
      start_time: (event.start_time as string | null) ?? null,
      end_time: (event.end_time as string | null) ?? null,
      venue: (event.venue as string | null) ?? null,
      address: (event.address as string | null) ?? null,
      price_text: (event.price_text as string | null) ?? null,
      official_url: (event.official_url as string | null) ?? null,
      source_url: (event.source_url as string | null) ?? null,
      area: (event.area as string | null) ?? null,
      price_type: normalizePriceType(event.price_type),
      is_indoor: asBool(event.is_indoor),
      is_kids: asBool(event.is_kids),
      is_night: asBool(event.is_night),
      category: asCategories(event.category),
      summary: (event.summary as string | null) ?? null,
      latitude: asNumber(event.latitude),
      longitude: asNumber(event.longitude),
    }
  })
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function placeText(source: MinatoNormalizedEvent, address: string | null): string {
  return [source.venue_name, address, source.description_raw]
    .map((value) => textOrNull(value))
    .filter((value): value is string => Boolean(value))
    .join('\n')
}

function audienceText(event: DbEvent, source: MinatoNormalizedEvent): string {
  return [event.title, source.target_raw, source.description_raw]
    .map((value) => textOrNull(value))
    .filter((value): value is string => Boolean(value))
    .join('\n')
}

/** 屋内/屋外は会場と本文に明示があるときだけ。タイトルや一般知識では決めない。 */
function judgeIndoor(place: string): boolean | null {
  if (!place) return null
  const indoor =
    /屋内|室内|[0-9０-９]+階|ホール|プラネタリウム|美術館|博物館|科学館|ギャラリー/.test(
      place,
    )
  const outdoor = /屋外|野外|運河|船上|クルーズ/.test(place)
  if (indoor === outdoor) return null
  return indoor
}

/** 子ども向けの明示があるときだけ true。対象外の明示があるときだけ false。 */
function judgeKids(audience: string): boolean | null {
  return inferKidsFromAudienceText(audience)
}

/** 夜の外出先だけ true。花火や遅い閉館だけでは付けない。 */
function judgeNight(event: DbEvent, source: MinatoNormalizedEvent): boolean | null {
  return inferIsNight({
    title: event.title,
    summary: event.summary,
    venue: source.venue_name ?? event.venue,
    description: source.description_raw,
    startTime: event.start_time,
    endTime: event.end_time,
  })
}

function applyFacts(event: DbEvent, source: MinatoNormalizedEvent): Facts {
  const address =
    cleanAddressAccess(source.address) ?? textOrNull(source.address)
  const priceText = textOrNull(source.price_text) ?? textOrNull(event.price_text)
  const venue = textOrNull(source.venue_name) ?? event.venue

  return {
    address,
    latitude: asNumber(source.latitude),
    longitude: asNumber(source.longitude),
    price_text: priceText,
    area: resolveAreaSlug({
      address,
      venue,
    }),
    price_type: inferPriceTypeFromPriceText(priceText),
    is_indoor: judgeIndoor(placeText(source, address)),
    is_kids: judgeKids(audienceText(event, source)),
    is_night: judgeNight(event, source),
  }
}

function sourceCorpus(event: DbEvent, source: MinatoNormalizedEvent): string {
  return [
    event.title,
    source.description_raw,
    source.target_raw,
    source.venue_name,
    source.address,
    source.price_text,
  ]
    .map((value) => textOrNull(value))
    .filter((value): value is string => Boolean(value))
    .join('\n')
}

/** AI summary が入力にない料金・時間帯を足していたら、本文の抜粋か null に戻す。 */
function groundedSummary(
  aiSummary: string,
  event: DbEvent,
  source: MinatoNormalizedEvent,
): string | null {
  const summary = aiSummary.trim()
  const corpus = sourceCorpus(event, source)
  const unsupported = ['無料', '有料', '夜間', 'ナイト', '屋内', '屋外', '夜'].filter(
    (word) => summary.includes(word) && !corpus.includes(word),
  )
  if (summary && unsupported.length === 0) return summary
  const body = textOrNull(source.description_raw)
  if (!body) return null
  return body.length > 140 ? `${body.slice(0, 140)}…` : body
}

function descriptionForAi(source: MinatoNormalizedEvent): string | null {
  const parts: string[] = []
  const body = textOrNull(source.description_raw)
  const target = textOrNull(source.target_raw)
  if (body) parts.push(body)
  if (target) parts.push(`対象: ${target}`)
  return parts.length > 0 ? parts.join('\n') : null
}

function fmt(value: unknown): string {
  if (value == null) return 'null'
  if (Array.isArray(value)) return value.length > 0 ? value.join('|') : '[]'
  return String(value)
}

function logStages(
  index: number,
  total: number,
  event: DbEvent,
  facts: Facts | null,
  planned: Planned | null,
  aiError: string | null,
) {
  console.log(`${LOG} ---- ${index}/${total} id=${event.id} ----`)
  console.log(`${LOG} title: ${event.title}`)
  if (aiError) console.log(`${LOG} error: ${aiError}`)

  const rows: Array<[string, unknown, unknown, unknown]> = [
    ['address', event.address, facts?.address ?? null, planned?.address ?? null],
    ['latitude', event.latitude, facts?.latitude ?? null, planned?.latitude ?? null],
    ['longitude', event.longitude, facts?.longitude ?? null, planned?.longitude ?? null],
    ['price_text', event.price_text, facts?.price_text ?? null, planned?.price_text ?? null],
    ['area', event.area, facts?.area ?? null, planned?.area ?? null],
    ['is_indoor', event.is_indoor, facts?.is_indoor ?? null, planned?.is_indoor ?? null],
    ['is_kids', event.is_kids, facts?.is_kids ?? null, planned?.is_kids ?? null],
    ['is_night', event.is_night, facts?.is_night ?? null, planned?.is_night ?? null],
    ['category', event.category ?? [], facts ? (event.category ?? []) : null, planned?.category ?? null],
    ['summary', event.summary, facts ? event.summary : null, planned?.summary ?? null],
  ]

  for (const [name, current, afterFacts, afterAi] of rows) {
    console.log(
      `${LOG} ${name}: ${fmt(current)} → ${fmt(afterFacts)} → ${fmt(afterAi)}`,
    )
  }
}

function alreadyEnriched(event: DbEvent): boolean {
  return (event.category ?? []).length > 0 && Boolean(textOrNull(event.summary))
}

function sameList(left: string[] | null | undefined, right: string[]): boolean {
  const current = left ?? []
  if (current.length !== right.length) return false
  return current.every((item, index) => item === right[index])
}

function plannedFromStored(event: DbEvent): Planned {
  return {
    address: event.address,
    latitude: event.latitude,
    longitude: event.longitude,
    price_text: event.price_text,
    area: event.area,
    price_type: event.price_type,
    is_indoor: event.is_indoor,
    is_kids: event.is_kids,
    is_night: event.is_night,
    category: event.category ?? [],
    summary: textOrNull(event.summary),
  }
}

function wouldChange(event: DbEvent, planned: Planned): boolean {
  return (
    (event.address ?? null) !== (planned.address ?? null) ||
    (event.latitude ?? null) !== (planned.latitude ?? null) ||
    (event.longitude ?? null) !== (planned.longitude ?? null) ||
    (event.price_text ?? null) !== (planned.price_text ?? null) ||
    (event.area ?? null) !== (planned.area ?? null) ||
    (planned.price_type != null && (event.price_type ?? null) !== planned.price_type) ||
    (event.is_indoor ?? null) !== (planned.is_indoor ?? null) ||
    (event.is_kids ?? null) !== (planned.is_kids ?? null) ||
    (event.is_night ?? null) !== (planned.is_night ?? null) ||
    !sameList(event.category, planned.category) ||
    textOrNull(event.summary) !== textOrNull(planned.summary)
  )
}

function tallyFlag(counts: Record<'true' | 'false' | 'null', number>, value: boolean | null) {
  if (value === true) counts.true += 1
  else if (value === false) counts.false += 1
  else counts.null += 1
}

async function main() {
  console.log(`${LOG} start`)
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  console.log(`${LOG} target: minato_opendata draft only`)

  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL

  const supabase = createServiceClient()
  const byUrl = await loadJsonBySourceUrl()
  const targets = await fetchTargetDrafts(supabase)
  const aiNeeded = targets.filter(
    (event) => event.status === 'draft' && !alreadyEnriched(event),
  ).length
  console.log(`${LOG} candidates: ${targets.length}`)
  console.log(`${LOG} ai対象: ${aiNeeded}`)
  if (aiNeeded > 0) {
    if (!apiKey) {
      console.error(`${LOG} OPENAI_API_KEY is missing. Add it to .env and retry.`)
      process.exit(1)
    }
    console.log(`${LOG} model: ${model}`)
  }

  if (DRY_RUN) {
    console.log(`${LOG} dry-run mode — no DB write`)
  }

  const client = apiKey ? new OpenAI({ apiKey }) : null
  let wouldUpdate = 0
  let skippedEnriched = 0
  const categoryFill = { n: 0 }
  const summaryShape = { n: 0 }
  const areaImprove = { n: 0 }
  const addressFill = { n: 0 }
  const latFill = { n: 0 }
  const lngFill = { n: 0 }
  let errors = 0
  const flags = {
    is_indoor: { true: 0, false: 0, null: 0 },
    is_kids: { true: 0, false: 0, null: 0 },
    is_night: { true: 0, false: 0, null: 0 },
  }

  for (let i = 0; i < targets.length; i++) {
    const event = targets[i]
    if (event.status !== 'draft') {
      errors += 1
      logStages(i + 1, targets.length, event, null, null, `status=${event.status} は対象外`)
      continue
    }

    const sourceUrl = event.source_url?.trim() ?? ''
    const source = sourceUrl ? byUrl.get(sourceUrl) : undefined
    if (!source) {
      errors += 1
      logStages(i + 1, targets.length, event, null, null, '正規化JSONに source_url が無い')
      continue
    }

    if (alreadyEnriched(event)) {
      skippedEnriched += 1
      const planned = plannedFromStored(event)
      if (wouldChange(event, planned)) wouldUpdate += 1
      console.log(
        `${LOG} unchanged id=${event.id} already enriched (no AI): ${event.title}`,
      )
      continue
    }

    if (!client) {
      errors += 1
      console.error(`${LOG} OPENAI client missing for id=${event.id}`)
      continue
    }

    const facts = applyFacts(event, source)
    let ai: AiEnrichment | null = null
    try {
      ai = await enrichEventWithAi(client, model, {
        title: event.title,
        description: descriptionForAi(source),
        venue: textOrNull(source.venue_name) ?? event.venue,
        address: facts.address,
        price_text: facts.price_text,
        start_date: event.start_date,
        end_date: event.end_date,
        start_time: event.start_time,
        end_time: event.end_time,
        area_hint: null,
      })
    } catch (error) {
      errors += 1
      const message = error instanceof Error ? error.message : String(error)
      logStages(i + 1, targets.length, event, facts, null, message)
      continue
    }

    const currentCategory = event.category ?? []
    const currentSummary = textOrNull(event.summary)
    const priceType =
      facts.price_type ?? normalizePriceType(ai.price_type.value)
    const planned: Planned = {
      ...facts,
      price_type: priceType,
      area: event.area,
      category: currentCategory.length > 0 ? currentCategory : ai.category,
      summary: currentSummary ?? groundedSummary(ai.summary, event, source),
    }
    if (currentCategory.length === 0 && planned.category.length > 0) categoryFill.n += 1
    if (planned.summary && planned.summary !== currentSummary) summaryShape.n += 1
    if (planned.area !== event.area) areaImprove.n += 1
    if (!textOrNull(event.address) && planned.address) addressFill.n += 1
    if (event.latitude == null && planned.latitude != null) latFill.n += 1
    if (event.longitude == null && planned.longitude != null) lngFill.n += 1
    tallyFlag(flags.is_indoor, planned.is_indoor)
    tallyFlag(flags.is_kids, planned.is_kids)
    tallyFlag(flags.is_night, planned.is_night)

    const changes = wouldChange(event, planned)
    if (changes) wouldUpdate += 1

    logStages(i + 1, targets.length, event, facts, planned, null)
    console.log(
      `${LOG} ai_raw area=${fmt(ai.area.value)} price_type=${fmt(ai.price_type.value)} is_indoor=${fmt(ai.is_indoor.value)} is_kids=${fmt(ai.is_kids.value)} is_night=${fmt(ai.is_night.value)}`,
    )

    if (DRY_RUN || !changes) continue

    const { data, error } = await supabase
      .from('events')
      .update({
        address: planned.address,
        latitude: planned.latitude,
        longitude: planned.longitude,
        price_text: planned.price_text,
        ...(planned.price_type ? { price_type: planned.price_type } : {}),
        is_indoor: planned.is_indoor,
        is_kids: planned.is_kids,
        is_night: planned.is_night,
        category: planned.category,
        summary: planned.summary,
        updated_at: new Date().toISOString(),
      })
      .eq('id', event.id)
      .eq('status', 'draft')
      .select('id')

    if (error) {
      errors += 1
      console.error(`${LOG} update failed id=${event.id}: ${error.message}`)
      continue
    }
    if (!data?.length) {
      errors += 1
      console.error(`${LOG} update skipped (not draft) id=${event.id}`)
    }
  }

  console.log(`${LOG} ---- counts ----`)
  console.log(`${LOG} candidates: ${targets.length}`)
  console.log(`${LOG} ai対象: ${aiNeeded}`)
  console.log(`${LOG} enriched_skip: ${skippedEnriched}`)
  console.log(`${LOG} 変更予定: ${wouldUpdate}`)
  console.log(`${LOG} category 補完予定: ${categoryFill.n}`)
  console.log(`${LOG} summary 補完/整形予定: ${summaryShape.n}`)
  console.log(`${LOG} area 改善予定: ${areaImprove.n}`)
  console.log(
    `${LOG} is_indoor true / false / null: ${flags.is_indoor.true} / ${flags.is_indoor.false} / ${flags.is_indoor.null}`,
  )
  console.log(
    `${LOG} is_kids true / false / null: ${flags.is_kids.true} / ${flags.is_kids.false} / ${flags.is_kids.null}`,
  )
  console.log(
    `${LOG} is_night true / false / null: ${flags.is_night.true} / ${flags.is_night.false} / ${flags.is_night.null}`,
  )
  console.log(`${LOG} address 補完予定: ${addressFill.n}`)
  console.log(`${LOG} lat 補完予定: ${latFill.n}`)
  console.log(`${LOG} lng 補完予定: ${lngFill.n}`)
  console.log(`${LOG} errors: ${errors}`)
  console.log(`${LOG} done (${DRY_RUN ? 'dry-run, no DB write' : 'write mode'})`)
  if (errors > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`${LOG} unexpected error:`, error)
  process.exit(1)
})
