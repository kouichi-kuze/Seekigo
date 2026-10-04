/**
 * 開催中・今後開催で、画像が未着手の published だけ一括生成する。
 *
 * npm run generate:event-images -- --dry-run --limit=10
 * npm run generate:event-images -- --limit=10
 * npm run generate:event-images -- --event-id=123
 * npm run generate:event-images -- --event-id=92 --retry-blocked --dry-run
 * npm run generate:event-images -- --dry-run --allow-draft --walkerplus-batch=1 --limit=87
 * npm run generate:event-images -- --dry-run --allow-draft --walkerplus-batch=2 --limit=75
 *
 * --limit の初期値は 5。省略しても全件は生成しない。
 * 通常は published かつ開催中・今後開催だけ。draft は自動では探さない。
 * draft は --allow-draft と --event-id、--walkerplus-batch=1、--walkerplus-batch=2 のいずれかを併用したときだけ見る。
 * --walkerplus-batch=2 は第2公開バッチの event ID 75件だけを ID 指定で読む。draft 全件は走査しない。
 * --allow-draft だけでは実行しない。終了した draft、権利確認済み公式画像、既存の生成状態は対象にしない。
 * --event-id を指定しても対象条件は外さない。blocked の再試行は --retry-blocked と併用する。
 * --retry-blocked だけでは実行しない。
 * --dry-run は API・DB・ファイルを変更しない。
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { generateEventImage } from '../src/lib/event-generated-image'
import {
  BULK_IMAGE_EVENT_SELECT,
  BULK_IMAGE_EXCLUSION_LABELS,
  BULK_IMAGE_EXCLUSIONS,
  bulkImageExclusionReasons,
  isBulkImageCandidate,
  type BulkImageEvent,
  type BulkImageExclusion,
} from '../src/lib/event-generated-image-eligibility'
import {
  mergeOccurrenceSpans,
  resolveScheduleStatus,
  type OccurrenceDateRow,
  type ScheduleStatus,
} from '../src/lib/event-schedule'
import { WALKERPLUS_BATCH1_SOURCE_IDS } from './data/walkerplus-batch1-ids'
import { PUBLISH_BATCH2_EVENT_IDS } from './data/publish-batch2-event-ids'

config()

const LOG = '[generate-event-images]'
const DEFAULT_LIMIT = 5

type Args = {
  dryRun: boolean
  limit: number
  eventId: number | null
  retryBlocked: boolean
  allowDraft: boolean
  walkerplusBatch: 1 | 2 | null
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let limit = DEFAULT_LIMIT
  let eventId: number | null = null
  let retryBlocked = false
  let allowDraft = false
  let walkerplusBatch: 1 | 2 | null = null
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--retry-blocked') {
      retryBlocked = true
      continue
    }
    if (arg === '--allow-draft') {
      allowDraft = true
      continue
    }
    if (arg.startsWith('--walkerplus-batch=')) {
      const batch = Number(arg.slice('--walkerplus-batch='.length))
      if (batch !== 1 && batch !== 2) {
        throw new Error('--walkerplus-batch は 1 または 2 だけ指定できます')
      }
      walkerplusBatch = batch
      continue
    }
    if (arg.startsWith('--limit=')) {
      limit = Number(arg.slice('--limit='.length))
      continue
    }
    if (arg.startsWith('--event-id=')) {
      eventId = Number(arg.slice('--event-id='.length))
      continue
    }
    throw new Error(`不明な引数です: ${arg}`)
  }
  if (retryBlocked && eventId == null) {
    throw new Error('--retry-blocked は --event-id と併用してください')
  }
  if (allowDraft && eventId == null && walkerplusBatch == null) {
    throw new Error('--allow-draft は --event-id または --walkerplus-batch=1 または --walkerplus-batch=2 と併用してください')
  }
  if (walkerplusBatch != null && !allowDraft) {
    throw new Error(`--walkerplus-batch=${walkerplusBatch} は --allow-draft と併用してください`)
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit は 1 以上の整数にしてください')
  }
  if (eventId != null && (!Number.isInteger(eventId) || eventId < 1)) {
    throw new Error('--event-id は 1 以上の整数にしてください')
  }
  return { dryRun, limit, eventId, retryBlocked, allowDraft, walkerplusBatch }
}

function createService(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function loadByIds(
  client: SupabaseClient,
  eventIds: number[],
): Promise<BulkImageEvent[]> {
  if (eventIds.length === 0) return []
  const { data, error } = await client
    .from('events')
    .select(BULK_IMAGE_EVENT_SELECT)
    .in('id', eventIds)
    .order('id')
  if (error) throw new Error(error.message)
  return (data ?? []) as BulkImageEvent[]
}

async function loadWalkerplusBatch1(client: SupabaseClient): Promise<BulkImageEvent[]> {
  const sourceIds = [...WALKERPLUS_BATCH1_SOURCE_IDS]
  const { data: sources, error } = await client
    .from('event_sources')
    .select('event_id, source_event_id')
    .eq('source_name', 'walkerplus')
    .in('source_event_id', sourceIds)
  if (error) throw new Error(error.message)
  const ids = [...new Set((sources ?? []).map((row) => Number(row.event_id)))]
  if (ids.length !== sourceIds.length || (sources ?? []).length !== sourceIds.length) {
    throw new Error(
      `Walkerplus第1バッチは ${sourceIds.length} 件だけです。見つかったイベントは ${ids.length} 件です`,
    )
  }
  return loadByIds(client, ids)
}

async function loadPublishBatch2(client: SupabaseClient): Promise<BulkImageEvent[]> {
  const ids = [...PUBLISH_BATCH2_EVENT_IDS]
  const events = await loadByIds(client, ids)
  const found = new Set(events.map((event) => event.id))
  const missing = ids.filter((id) => !found.has(id))
  if (missing.length > 0 || events.length !== ids.length) {
    throw new Error(
      `第2公開バッチは ${ids.length} 件だけです。見つかったイベントは ${events.length} 件、不足は ${missing.join(',') || 'なし'}`,
    )
  }
  return events
}

async function loadPublished(client: SupabaseClient): Promise<BulkImageEvent[]> {
  const { data, error } = await client
    .from('events')
    .select(BULK_IMAGE_EVENT_SELECT)
    .eq('status', 'published')
    .order('id')
  if (error) throw new Error(error.message)
  return (data ?? []) as BulkImageEvent[]
}

async function loadOccurrences(
  client: SupabaseClient,
  eventIds: number[],
): Promise<Map<number, OccurrenceDateRow[]>> {
  const map = new Map<number, OccurrenceDateRow[]>()
  for (let i = 0; i < eventIds.length; i += 80) {
    const chunk = eventIds.slice(i, i + 80)
    const { data, error } = await client
      .from('event_occurrences')
      .select('event_id, start_date, end_date')
      .in('event_id', chunk)
    if (error) throw new Error(error.message)
    for (const row of data ?? []) {
      const eventId = Number(row.event_id)
      const list = map.get(eventId) ?? []
      list.push({
        start_date: row.start_date,
        end_date: row.end_date,
      })
      map.set(eventId, list)
    }
  }
  return map
}

function scheduleOf(
  event: BulkImageEvent,
  occurrences: Map<number, OccurrenceDateRow[]>,
): ScheduleStatus | null {
  const spans = mergeOccurrenceSpans(occurrences.get(event.id) ?? [])
  return resolveScheduleStatus(spans, event)
}

async function reloadEvent(
  client: SupabaseClient,
  eventId: number,
): Promise<BulkImageEvent | null> {
  const { data, error } = await client
    .from('events')
    .select(BULK_IMAGE_EVENT_SELECT)
    .eq('id', eventId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return (data as BulkImageEvent | null) ?? null
}

function printPlan(
  eligible: BulkImageEvent[],
  selected: BulkImageEvent[],
  excludedReasons: Map<BulkImageExclusion, number>,
  excludedEvents: number,
) {
  console.log(`${LOG} 候補総数: ${eligible.length}`)
  console.log(`${LOG} 今回対象: ${selected.length}`)
  for (const event of selected) {
    console.log(`  ${event.id} ${event.title ?? ''}`)
  }
  console.log(`${LOG} 除外件数: ${excludedEvents}`)
  for (const reason of BULK_IMAGE_EXCLUSIONS) {
    const count = excludedReasons.get(reason) ?? 0
    if (count === 0) continue
    console.log(`  ${BULK_IMAGE_EXCLUSION_LABELS[reason]}: ${count}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const client = createService()
  const eligibility = { allowDraft: args.allowDraft }
  const events = args.walkerplusBatch === 1
    ? await loadWalkerplusBatch1(client)
    : args.walkerplusBatch === 2
      ? await loadPublishBatch2(client)
      : args.allowDraft && args.eventId != null
        ? await loadByIds(client, [args.eventId])
        : await loadPublished(client)
  if (args.walkerplusBatch === 2) {
    const allowed = new Set<number>(PUBLISH_BATCH2_EVENT_IDS)
    const outside = events.filter((event) => !allowed.has(event.id))
    if (outside.length > 0) {
      throw new Error(
        `第2公開バッチ以外のイベントを読みました: ${outside.map((event) => event.id).join(',')}`,
      )
    }
    console.log(`${LOG} 指定 ID: ${PUBLISH_BATCH2_EVENT_IDS.length}`)
    console.log(`${LOG} 読込 ID: ${events.map((event) => event.id).join(',')}`)
  }
  const occurrences = await loadOccurrences(
    client,
    events.map((event) => event.id),
  )

  const eligible: BulkImageEvent[] = []
  const excludedReasons = new Map<BulkImageExclusion, number>()
  const excludedIds = new Map<BulkImageExclusion, number[]>()
  const inactiveIds: number[] = []
  const nonDraftIds: number[] = []
  const generatedStatusSkips: string[] = []
  let activeCount = 0
  let excludedEvents = 0
  let inactiveCount = 0
  for (const event of events) {
    if (args.walkerplusBatch === 2 && event.status !== 'draft') {
      nonDraftIds.push(event.id)
      continue
    }
    const schedule = scheduleOf(event, occurrences)
    const reasons = bulkImageExclusionReasons(event, schedule, eligibility)
    if (reasons.length === 0) {
      eligible.push(event)
      activeCount += 1
      continue
    }
    if (reasons.includes('not_active')) {
      inactiveCount += 1
      inactiveIds.push(event.id)
      continue
    }
    activeCount += 1
    excludedEvents += 1
    if (reasons.includes('generated_status')) {
      generatedStatusSkips.push(`${event.id}:${event.generated_image_status ?? 'null'}`)
    }
    for (const reason of reasons) {
      excludedReasons.set(reason, (excludedReasons.get(reason) ?? 0) + 1)
      const ids = excludedIds.get(reason) ?? []
      ids.push(event.id)
      excludedIds.set(reason, ids)
    }
  }
  console.log(`${LOG} 開催中・今後開催: ${activeCount}`)
  console.log(`${LOG} 終了または開催日なし: ${inactiveCount}`)
  if (args.walkerplusBatch === 2) {
    console.log(`${LOG} draft 以外: ${nonDraftIds.join(', ') || 'なし'}`)
    console.log(`${LOG} 終了または開催日なし ID: ${inactiveIds.join(', ') || 'なし'}`)
    console.log(`${LOG} 既存 generated 状態: ${generatedStatusSkips.join(', ') || 'なし'}`)
    for (const reason of BULK_IMAGE_EXCLUSIONS) {
      const ids = excludedIds.get(reason) ?? []
      if (ids.length === 0) continue
      console.log(`${LOG} 除外 ID ${reason}: ${ids.join(', ')}`)
    }
  }

  const allowBlocked = args.retryBlocked && args.eventId != null
  const retryTarget = allowBlocked
    ? events.filter((event) => {
        if (event.id !== args.eventId) return false
        return isBulkImageCandidate(event, scheduleOf(event, occurrences), {
          allowBlocked: true,
          allowDraft: args.allowDraft,
        })
      })
    : []
  const pool = args.eventId == null
    ? eligible
    : allowBlocked
      ? retryTarget
      : eligible.filter((event) => event.id === args.eventId)
  const selected = args.eventId == null ? pool.slice(0, args.limit) : pool

  printPlan(eligible, selected, excludedReasons, excludedEvents)

  if (args.eventId != null && selected.length === 0) {
    const found = events.find((event) => event.id === args.eventId)
    const reasons = found
      ? bulkImageExclusionReasons(found, scheduleOf(found, occurrences), {
          allowBlocked,
          allowDraft: args.allowDraft,
        })
      : []
    console.log(`${LOG} スキップ: ${args.eventId} は対象条件を満たしません`)
    for (const reason of reasons) {
      console.log(`  ${BULK_IMAGE_EXCLUSION_LABELS[reason]}`)
    }
    if (!found) {
      console.log(
        args.allowDraft
          ? '  指定したイベントが見つかりません'
          : '  published のイベントが見つかりません',
      )
    }
    console.log(`${LOG} 成功 0 / 失敗 0 / スキップ 1`)
    console.log(`${LOG} スキップ ID: ${args.eventId}`)
    return
  }

  if (args.dryRun) {
    console.log(`${LOG} dry-run のため API・DB・ファイルは変更していません`)
    return
  }

  const success: number[] = []
  const failed: { id: number; message: string }[] = []
  const skipped: { id: number; reasons: BulkImageExclusion[] }[] = []

  for (const planned of selected) {
    const current = await reloadEvent(client, planned.id)
    if (!current) {
      skipped.push({ id: planned.id, reasons: ['not_active'] })
      console.log(`${LOG} スキップ ${planned.id}: 再読込できませんでした`)
      continue
    }
    const occurrencesNow = await loadOccurrences(client, [current.id])
    const reasons = bulkImageExclusionReasons(
      current,
      scheduleOf(current, occurrencesNow),
      { allowBlocked: allowBlocked && current.id === args.eventId, allowDraft: args.allowDraft },
    )
    if (
      !isBulkImageCandidate(current, scheduleOf(current, occurrencesNow), {
        allowBlocked: allowBlocked && current.id === args.eventId,
        allowDraft: args.allowDraft,
      })
    ) {
      skipped.push({ id: current.id, reasons })
      console.log(`${LOG} スキップ ${current.id}: ${reasons.map((reason) => BULK_IMAGE_EXCLUSION_LABELS[reason]).join(', ')}`)
      continue
    }
    let result: { ok: true; url: string } | { ok: false; message: string }
    try {
      result = await generateEventImage(client, current.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ id: current.id, message })
      console.log(`${LOG} 失敗 ${current.id}: ${message}`)
      continue
    }
    if (!result.ok) {
      failed.push({ id: current.id, message: result.message })
      console.log(`${LOG} 失敗 ${current.id}: ${result.message}`)
      continue
    }
    success.push(current.id)
    console.log(`${LOG} 成功 ${current.id} ${result.url}`)
  }

  console.log(`${LOG} 成功 ${success.length} / 失敗 ${failed.length} / スキップ ${skipped.length}`)
  console.log(`${LOG} 成功 ID: ${success.join(', ') || 'なし'}`)
  console.log(`${LOG} 失敗 ID: ${failed.map((row) => row.id).join(', ') || 'なし'}`)
  console.log(`${LOG} スキップ ID: ${skipped.map((row) => row.id).join(', ') || 'なし'}`)
}

main().catch((error) => {
  console.error(LOG, error instanceof Error ? error.message : error)
  process.exit(1)
})
