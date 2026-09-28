/**
 * 港区オープンデータ Phase 2.6 — 取り込み。
 * 新規は draft。published / hidden の本文は上書きしない。
 * 非連続の開催回は event_occurrences。events の開始・終了は次回の1回だけ（全期間にはしない）。
 * DRY_RUN が false 以外のときは INSERT / UPDATE しない。sync-all には未接続。
 *
 *   $env:DRY_RUN="true"
 *   npx tsx scripts/import-minato-opendata-supabase.ts
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  matchAgainstExisting,
  type DedupeExisting,
  type DuplicateMatchResult,
  type DuplicateStatus,
} from '../src/lib/event-dedupe'
import { isBodyProtectedFromSync } from '../src/lib/event-status'
import { resolveEventPlace } from '../src/lib/event-field-rules'
import { syncFieldReviewsForPublishedEvent } from './lib/field-reviews'
import type {
  MinatoAreaStatus,
  MinatoNormalizedEvent,
  MinatoOccurrence,
} from './lib/minato-opendata'

config()

const LOG = '[import-minato]'
const AS_OF = '2026-09-27'
const SOURCE_NAME = 'minato_opendata'
const DRY_RUN = process.env.DRY_RUN !== 'false'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const inputPath = path.join(
  path.resolve(__dirname, '..'),
  'tmp',
  'minato-events.json',
)

type InputFile = {
  asOf?: string
  events?: MinatoNormalizedEvent[]
}

const PUBLISH_RE =
  /祭|華火|花火|クルーズ|子ども|こども|親子|展示|文化|スポーツ|体験|ワークショップ|自然観察|生き物観察|収穫|料理|音楽|コンサート|フェス|マルシェ|ボッチャ|江戸カフェ/

const NOT_OUTING_RE =
  /介護|予防教室|家族介護|ひきこもり|ボランティア|養成|研修|人権|ユマニチュード|認知症|語り部ガイド|パソコン教室|タブレット|麻雀|ウクレレ|水泳教室|テニスレッスン|体操教室|鍼|マッサージ/

function createReadClient(): SupabaseClient {
  const url =
    process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
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

async function fetchExisting(client: SupabaseClient): Promise<DedupeExisting[]> {
  const { data: events, error } = await client
    .from('events')
    .select(
      'id, slug, title, start_date, end_date, venue, area, official_url, source_url, status',
    )
  if (error) throw new Error(error.message)

  const { data: sources, error: srcErr } = await client
    .from('event_sources')
    .select('event_id, source_url')
  if (srcErr) throw new Error(srcErr.message)

  const alts = new Map<number, string[]>()
  for (const source of sources ?? []) {
    const id = Number(source.event_id)
    if (!Number.isFinite(id) || !source.source_url) continue
    const list = alts.get(id) ?? []
    list.push(String(source.source_url))
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

type MinatoLink = {
  eventId: number
  status: string | null
}

async function fetchMinatoLinks(
  client: SupabaseClient,
): Promise<Map<string, MinatoLink>> {
  const { data: sources, error } = await client
    .from('event_sources')
    .select('event_id, source_url')
    .eq('source_name', SOURCE_NAME)
  if (error) throw new Error(error.message)

  const ids = [
    ...new Set(
      (sources ?? [])
        .map((row) => Number(row.event_id))
        .filter((id) => Number.isFinite(id)),
    ),
  ]
  const statusById = new Map<number, string | null>()
  if (ids.length > 0) {
    const { data: events, error: evErr } = await client
      .from('events')
      .select('id, status')
      .in('id', ids)
    if (evErr) throw new Error(evErr.message)
    for (const row of events ?? []) {
      statusById.set(Number(row.id), (row.status as string | null) ?? null)
    }
  }

  const links = new Map<string, MinatoLink>()
  for (const row of sources ?? []) {
    const url = String(row.source_url ?? '').trim()
    const eventId = Number(row.event_id)
    if (!url || !Number.isFinite(eventId)) continue
    links.set(url, { eventId, status: statusById.get(eventId) ?? null })
  }
  return links
}

function occurrenceKey(item: {
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
}): string {
  return [
    item.start_date,
    item.end_date,
    item.start_time ?? '',
    item.end_time ?? '',
  ].join('|')
}

async function fetchOccurrenceKeys(
  client: SupabaseClient,
  eventIds: number[],
): Promise<Map<number, Set<string>>> {
  const keys = new Map<number, Set<string>>()
  if (eventIds.length === 0) return keys
  const { data, error } = await client
    .from('event_occurrences')
    .select('event_id, start_date, end_date, start_time, end_time')
    .in('event_id', eventIds)
  if (error) throw new Error(error.message)
  for (const row of data ?? []) {
    const eventId = Number(row.event_id)
    const set = keys.get(eventId) ?? new Set<string>()
    set.add(
      occurrenceKey({
        start_date: String(row.start_date).slice(0, 10),
        end_date: String(row.end_date).slice(0, 10),
        start_time: row.start_time ? String(row.start_time).slice(0, 8) : null,
        end_time: row.end_time ? String(row.end_time).slice(0, 8) : null,
      }),
    )
    keys.set(eventId, set)
  }
  return keys
}

function missingOccurrences(
  existing: Set<string> | undefined,
  incoming: MinatoOccurrence[],
): MinatoOccurrence[] {
  const have = existing ?? new Set<string>()
  return incoming.filter((item) => !have.has(occurrenceKey(item)))
}

function nearestOccurrence(
  occurrences: MinatoOccurrence[],
  asOf: string,
): MinatoOccurrence | null {
  return (
    occurrences
      .filter((item) => item.end_date >= asOf)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))[0] ?? null
  )
}

function decidePublish(event: MinatoNormalizedEvent): {
  publish_candidate: boolean
  reason: string
} {
  if (event.area_status === 'outside_minato') {
    return {
      publish_candidate: false,
      reason: '開催地が港区外のため、自動公開候補にしない',
    }
  }
  const text = `${event.title ?? ''}\n${event.category_raw ?? ''}\n${event.description_raw ?? ''}`
  const outing = PUBLISH_RE.test(text)
  const welfare = NOT_OUTING_RE.test(text)
  if (outing && welfare) {
    return {
      publish_candidate: false,
      reason: 'お出かけらしい語と、福祉・養成・教室の語が両方ある',
    }
  }
  if (welfare) {
    return {
      publish_candidate: false,
      reason: '講座や福祉・養成としては残るが、今日どこ行く？の自動公開にはしない',
    }
  }
  if (outing) {
    return {
      publish_candidate: true,
      reason:
        event.area_status === 'unknown'
          ? 'お出かけ候補。開催地は港区と断定できないのでレビューが必要'
          : '祭り・展示・体験など、一般のお出かけとして扱える',
    }
  }
  return {
    publish_candidate: false,
    reason: '一般のお出かけと断定できない',
  }
}

function dateLabel(event: MinatoNormalizedEvent, asOf: string): string {
  const next = nearestOccurrence(event.occurrences, asOf)
  if (!next) return '日付不明'
  return next.start_date === next.end_date
    ? next.start_date
    : `${next.start_date}..${next.end_date}`
}

function compatibleEventDates(
  occurrences: MinatoOccurrence[],
  asOf: string,
): { start_date: string; end_date: string } | null {
  if (occurrences.length === 0) return null
  if (occurrences.length === 1) {
    return {
      start_date: occurrences[0].start_date,
      end_date: occurrences[0].end_date,
    }
  }
  const next = nearestOccurrence(occurrences, asOf) ?? occurrences[0]
  return { start_date: next.start_date, end_date: next.end_date }
}

function buildSlug(sourceUrl: string, startDate: string): string {
  const year = startDate.slice(0, 4)
  const hash = createHash('sha1')
    .update(`seekigo:minato_opendata:${sourceUrl}`)
    .digest('hex')
    .slice(0, 10)
  return `minato-${hash}-${year}`
}

async function attachMinatoSource(
  client: SupabaseClient,
  eventId: number,
  event: MinatoNormalizedEvent,
): Promise<void> {
  const now = new Date().toISOString()
  const sourceUrl = event.source_url ?? event.official_url
  if (!sourceUrl) throw new Error('source_url is required')
  const { data: existing, error: selErr } = await client
    .from('event_sources')
    .select('id')
    .eq('event_id', eventId)
    .eq('source_name', SOURCE_NAME)
    .eq('source_url', sourceUrl)
    .maybeSingle()
  if (selErr) throw selErr
  const row = {
    source_event_id: null,
    official_url: event.official_url,
    dataset_url: event.dataset_url,
    last_checked_at: now,
    updated_at: now,
  }
  if (existing?.id) {
    const { error } = await client.from('event_sources').update(row).eq('id', existing.id)
    if (error) throw error
    return
  }
  const { error } = await client.from('event_sources').insert({
    event_id: eventId,
    source_name: SOURCE_NAME,
    source_url: sourceUrl,
    ...row,
  })
  if (error) throw error
}

async function replaceOccurrences(
  client: SupabaseClient,
  eventId: number,
  occurrences: MinatoOccurrence[],
  existing: Set<string> | undefined,
): Promise<number> {
  const missing = missingOccurrences(existing, occurrences)
  if (missing.length === 0) return 0
  const { error } = await client.from('event_occurrences').insert(
    missing.map((item) => ({
      event_id: eventId,
      start_date: item.start_date,
      end_date: item.end_date,
      start_time: item.start_time,
      end_time: item.end_time,
    })),
  )
  if (error) throw error
  return missing.length
}

async function saveDedupeReview(
  client: SupabaseClient,
  event: MinatoNormalizedEvent,
  match: DuplicateMatchResult,
  startDate: string | null,
  endDate: string | null,
): Promise<void> {
  if (match.duplicate_status !== 'likely' && match.duplicate_status !== 'ambiguous') return
  const sourceUrl = event.source_url ?? event.official_url
  if (!sourceUrl) return
  const candidateId =
    match.matched_event_id == null ? null : Number(match.matched_event_id)
  const { error } = await client.from('event_dedupe_reviews').insert({
    status: 'pending',
    incoming_source_name: SOURCE_NAME,
    incoming_source_url: sourceUrl,
    incoming_payload: {
      title: event.title,
      start_date: startDate,
      end_date: endDate,
      venue: event.venue_name,
      official_url: event.official_url,
      source_url: sourceUrl,
      dataset_url: event.dataset_url,
      price_text: event.price_text,
      summary: event.description_raw,
    },
    candidate_event_id: candidateId,
    duplicate_status: match.duplicate_status,
    reason: match.duplicate_reason,
    scores: match.scores ?? null,
  })
  if (error) throw error
}

async function main() {
  console.log(`${LOG} DRY_RUN: ${DRY_RUN}`)
  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as InputFile
  const asOf = raw.asOf || AS_OF
  const activeInclude = (raw.events ?? []).filter(
    (event) =>
      event.filter_status === 'include' &&
      (event.lifecycle === 'future' || event.lifecycle === 'ongoing'),
  )

  const client = createReadClient()
  const write = !DRY_RUN
  const pool = await fetchExisting(client)
  const minatoLinks = await fetchMinatoLinks(client)
  const occurrenceKeys = await fetchOccurrenceKeys(client, [
    ...new Set([...minatoLinks.values()].map((link) => link.eventId)),
  ])
  console.log(`${LOG} existing events for dedupe: ${pool.length}`)
  console.log(`${LOG} existing minato sources: ${minatoLinks.size}`)

  const counts = {
    input_active_include: activeInclude.length,
    publish_candidate: 0,
    review_candidate: 0,
    exact: 0,
    likely: 0,
    ambiguous: 0,
    none: 0,
    would_create_draft: 0,
    would_insert_occurrences: 0,
    recognized_existing: 0,
    would_attach_source: 0,
    would_create_review: 0,
    would_skip: 0,
    multiple_occurrence_review: 0,
    errors: 0,
  }

  const drafts: string[] = []
  const dupes: string[] = []
  const reviews: string[] = []

  for (const event of activeInclude) {
    if (!event.title) {
      counts.errors += 1
      counts.would_skip += 1
      continue
    }

    const sourceUrl = (event.source_url ?? event.official_url ?? '').trim()
    const linked = sourceUrl ? minatoLinks.get(sourceUrl) : undefined
    if (linked) {
      counts.recognized_existing += 1
      const protectedBody = isBodyProtectedFromSync(linked.status)
      const missing = protectedBody
        ? []
        : missingOccurrences(occurrenceKeys.get(linked.eventId), event.occurrences)
      counts.would_insert_occurrences += missing.length
      if (protectedBody) {
        counts.would_skip += 1
        reviews.push(
          `${event.title}\t既存 id=${linked.eventId} は ${linked.status} のため本文も開催回も変更しない`,
        )
        continue
      }
      if (write && missing.length > 0) {
        try {
          await replaceOccurrences(
            client,
            linked.eventId,
            event.occurrences,
            occurrenceKeys.get(linked.eventId),
          )
        } catch (error) {
          counts.errors += 1
          console.error(
            `${LOG} occurrence fill failed id=${linked.eventId}:`,
            error instanceof Error ? error.message : error,
          )
        }
      }
      continue
    }

    const publish = decidePublish(event)
    if (publish.publish_candidate) counts.publish_candidate += 1
    else counts.review_candidate += 1

    const multiple = event.occurrences.length > 1

    const next = nearestOccurrence(event.occurrences, asOf)
    const match: DuplicateMatchResult = matchAgainstExisting(
      {
        title: event.title,
        start_date: next?.start_date ?? null,
        end_date: next?.end_date ?? null,
        venue: event.venue_name,
        official_url: event.official_url,
        source_url: event.source_url,
        area: event.area_status === 'minato' ? 'minato' : null,
      },
      pool,
    )
    const status: DuplicateStatus = match.duplicate_status
    counts[status] += 1

    const protectedBody =
      match.matched_status != null && isBodyProtectedFromSync(match.matched_status)

    if (status === 'exact') {
      counts.would_attach_source += 1
      if (protectedBody) counts.would_create_review += 1
      dupes.push(
        [
          event.title,
          match.matched_title ?? '',
          'exact',
          String(match.scores?.title_similarity ?? ''),
          next?.start_date ?? '',
          String(match.scores?.venue_similarity ?? ''),
        ].join('\t'),
      )
      if (write && match.matched_event_id != null) {
        const eventId = Number(match.matched_event_id)
        try {
          await attachMinatoSource(client, eventId, event)
          if (!protectedBody) {
            await replaceOccurrences(
              client,
              eventId,
              event.occurrences,
              occurrenceKeys.get(eventId),
            )
          } else {
            await syncFieldReviewsForPublishedEvent(client, {
              eventId,
              eventStatus: 'published',
              sourceName: SOURCE_NAME,
              sourceUrl: event.source_url ?? event.official_url ?? '',
              proposed: {
                start_date: next?.start_date ?? null,
                end_date: next?.end_date ?? null,
                venue: event.venue_name,
                official_url: event.official_url,
                price_text: event.price_text,
              },
              write: true,
            })
          }
        } catch (error) {
          counts.errors += 1
          console.error(
            `${LOG} exact attach failed:`,
            error instanceof Error ? error.message : error,
          )
        }
      }
      continue
    }

    if (status === 'likely' || status === 'ambiguous') {
      counts.would_create_review += 1
      dupes.push(
        [
          event.title,
          match.matched_title ?? '',
          status,
          String(match.scores?.title_similarity ?? ''),
          String(match.scores?.date_overlap_ratio ?? ''),
          String(match.scores?.venue_similarity ?? ''),
        ].join('\t'),
      )
      reviews.push(`${event.title}\t重複判定 ${status}: ${match.duplicate_reason}`)
      if (write) {
        try {
          await saveDedupeReview(
            client,
            event,
            match,
            next?.start_date ?? null,
            next?.end_date ?? null,
          )
        } catch (error) {
          counts.errors += 1
          console.error(
            `${LOG} review insert failed:`,
            error instanceof Error ? error.message : error,
          )
        }
      }
      continue
    }

    if (!publish.publish_candidate || event.area_status === 'outside_minato') {
      counts.would_create_review += 1
      reviews.push(
        `${event.title}\t${publish.reason}${multiple ? `（開催 ${event.occurrences.length} 回）` : ''}`,
      )
      continue
    }

    const dates = compatibleEventDates(event.occurrences, asOf)
    if (!dates || !event.source_url) {
      counts.errors += 1
      counts.would_skip += 1
      continue
    }

    counts.would_create_draft += 1
    if (multiple) counts.multiple_occurrence_review += 1
    if (event.area_status === 'unknown') {
      counts.would_create_review += 1
      reviews.push(`${event.title}\t開催地を港区と断定できない`)
    }
    if (multiple) counts.multiple_occurrence_review += 0
    drafts.push(
      [
        event.title,
        dateLabel(event, asOf),
        event.venue_name ?? '',
        event.area_status,
        String(publish.publish_candidate),
        String(event.occurrences.length),
      ].join('\t'),
    )

    const place = resolveEventPlace({
      venue: event.venue_name,
      address: event.address,
    })
    const municipality =
      event.area_status === 'minato' ? 'minato' : place.municipality
    const area =
      event.area_status === 'minato'
        ? place.municipality === 'minato'
          ? place.area
          : null
        : place.area
    console.log(
      `${LOG} draft place municipality=${municipality} area=${area} title=${event.title}`,
    )

    if (!write) continue

    const slug = buildSlug(event.source_url, dates.start_date)
    const { data: inserted, error: insErr } = await client
      .from('events')
      .insert({
        title: event.title,
        slug,
        status: 'draft',
        source_url: event.source_url,
        official_url: event.official_url,
        venue: event.venue_name,
        municipality,
        area,
        address: null,
        start_date: dates.start_date,
        end_date: dates.end_date,
        start_time: null,
        end_time: null,
        price_text: event.price_text,
        summary: event.description_raw,
        category: [],
        image_usage_status: 'unknown',
        image_source: null,
        image_credit: null,
      })
      .select('id')
      .single()
    if (insErr || !inserted?.id) {
      counts.errors += 1
      console.error(`${LOG} draft insert failed:`, insErr?.message)
      continue
    }
    const eventId = Number(inserted.id)
    try {
      await attachMinatoSource(client, eventId, event)
      await replaceOccurrences(client, eventId, event.occurrences, new Set())
    } catch (error) {
      counts.errors += 1
      console.error(
        `${LOG} source or occurrences failed id=${eventId}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  console.log(`${LOG} input_active_include ${counts.input_active_include}`)
  console.log(`${LOG} publish_candidate ${counts.publish_candidate}`)
  console.log(`${LOG} review_candidate ${counts.review_candidate}`)
  console.log(`${LOG} exact ${counts.exact}`)
  console.log(`${LOG} likely ${counts.likely}`)
  console.log(`${LOG} ambiguous ${counts.ambiguous}`)
  console.log(`${LOG} none ${counts.none}`)
  console.log(`${LOG} recognized_existing ${counts.recognized_existing}`)
  console.log(`${LOG} would_create_draft ${counts.would_create_draft}`)
  console.log(`${LOG} would_attach_source ${counts.would_attach_source}`)
  console.log(`${LOG} would_insert_occurrences ${counts.would_insert_occurrences}`)
  console.log(`${LOG} would_create_review ${counts.would_create_review}`)
  console.log(`${LOG} would_skip ${counts.would_skip}`)
  console.log(`${LOG} multiple_occurrence_review ${counts.multiple_occurrence_review}`)
  console.log(`${LOG} errors ${counts.errors}`)

  console.log(`${LOG} --- draft candidates ---`)
  drafts.forEach((line, index) => console.log(`${LOG} ${index + 1}. ${line}`))
  console.log(`${LOG} --- duplicates ---`)
  dupes.forEach((line, index) => console.log(`${LOG} ${index + 1}. ${line}`))
  console.log(`${LOG} --- reviews ---`)
  reviews.forEach((line, index) => console.log(`${LOG} ${index + 1}. ${line}`))
  console.log(`${LOG} done (${DRY_RUN ? 'dry-run, no DB write' : 'write mode'})`)
}

main().catch((error) => {
  console.error(LOG, error instanceof Error ? error.message : error)
  process.exit(1)
})
