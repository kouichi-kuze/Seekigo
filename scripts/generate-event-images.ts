/**
 * 開催中・今後開催で、画像が未着手の published だけ一括生成する。
 *
 * npm run generate:event-images -- --dry-run --limit=10
 * npm run generate:event-images -- --limit=10
 * npm run generate:event-images -- --event-id=123
 *
 * --limit の初期値は 5。省略しても全件は生成しない。
 * --event-id を指定しても対象条件は外さない。
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

config()

const LOG = '[generate-event-images]'
const DEFAULT_LIMIT = 5

type Args = {
  dryRun: boolean
  limit: number
  eventId: number | null
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let limit = DEFAULT_LIMIT
  let eventId: number | null = null
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true
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
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('--limit は 1 以上の整数にしてください')
  }
  if (eventId != null && (!Number.isInteger(eventId) || eventId < 1)) {
    throw new Error('--event-id は 1 以上の整数にしてください')
  }
  return { dryRun, limit, eventId }
}

function createService(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が必要です')
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
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
  const events = await loadPublished(client)
  const occurrences = await loadOccurrences(
    client,
    events.map((event) => event.id),
  )

  const eligible: BulkImageEvent[] = []
  const excludedReasons = new Map<BulkImageExclusion, number>()
  let activeCount = 0
  let excludedEvents = 0
  let inactiveCount = 0
  for (const event of events) {
    const schedule = scheduleOf(event, occurrences)
    const reasons = bulkImageExclusionReasons(event, schedule)
    if (reasons.length === 0) {
      eligible.push(event)
      activeCount += 1
      continue
    }
    if (reasons.includes('not_active')) {
      inactiveCount += 1
      continue
    }
    activeCount += 1
    excludedEvents += 1
    for (const reason of reasons) {
      excludedReasons.set(reason, (excludedReasons.get(reason) ?? 0) + 1)
    }
  }
  console.log(`${LOG} 開催中・今後開催: ${activeCount}`)
  console.log(`${LOG} 終了または開催日なし: ${inactiveCount}`)

  const pool = args.eventId == null
    ? eligible
    : eligible.filter((event) => event.id === args.eventId)
  const selected = args.eventId == null ? pool.slice(0, args.limit) : pool

  printPlan(eligible, selected, excludedReasons, excludedEvents)

  if (args.eventId != null && selected.length === 0) {
    const found = events.find((event) => event.id === args.eventId)
    const reasons = found
      ? bulkImageExclusionReasons(found, scheduleOf(found, occurrences))
      : []
    console.log(`${LOG} スキップ: ${args.eventId} は対象条件を満たしません`)
    for (const reason of reasons) {
      console.log(`  ${BULK_IMAGE_EXCLUSION_LABELS[reason]}`)
    }
    if (!found) console.log('  published のイベントが見つかりません')
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
    const reasons = bulkImageExclusionReasons(current, scheduleOf(current, occurrencesNow))
    if (!isBulkImageCandidate(current, scheduleOf(current, occurrencesNow))) {
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
