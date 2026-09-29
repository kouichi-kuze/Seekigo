/**
 * 確認済み summary review だけを承認し、区・市 slug の area review 16件を却下する。
 * id 44 の category / price_text は pending のままにする。
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { isEventEnded } from '../src/lib/display'
import { CONFIRMED_SUMMARIES } from './register-walkerplus-summary-reviews'

config()

const AREA_REJECT_IDS = [40, 45, 47, 98, 103, 105, 106, 109, 118, 119, 123, 125, 126, 127, 129, 130]
const SUMMARY_IDS = Object.keys(CONFIRMED_SUMMARIES).map(Number)
const OPEN_ON = '2026-09-29'

function createService(): SupabaseClient {
  const url = process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) throw new Error('Supabase service env is missing')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function main() {
  const supabase = createService()
  const now = new Date().toISOString()

  const { data: areaReviews, error: areaError } = await supabase
    .from('event_field_reviews')
    .select('id, event_id, field_name, status, proposed_value')
    .in('event_id', AREA_REJECT_IDS)
    .eq('field_name', 'area')
    .eq('status', 'pending')
  if (areaError) throw new Error(areaError.message)

  const areaByEvent = new Map((areaReviews ?? []).map((row) => [row.event_id as number, row]))
  const areaSkipped: { id: number; reason: string }[] = []
  const areaRejectIds: number[] = []
  for (const eventId of AREA_REJECT_IDS) {
    const review = areaByEvent.get(eventId)
    if (!review) {
      areaSkipped.push({ id: eventId, reason: 'no pending area review' })
      continue
    }
    areaRejectIds.push(review.id as number)
  }

  if (areaRejectIds.length > 0) {
    const { data: rejected, error: rejectError } = await supabase
      .from('event_field_reviews')
      .update({
        status: 'rejected',
        decided_by: 'local_admin',
        decided_at: now,
        updated_at: now,
      })
      .in('id', areaRejectIds)
      .eq('status', 'pending')
      .eq('field_name', 'area')
      .select('id')
    if (rejectError) throw new Error(rejectError.message)
    if ((rejected?.length ?? 0) !== areaRejectIds.length) {
      throw new Error(`area reject count ${rejected?.length} !== ${areaRejectIds.length}`)
    }
  }

  const { data: events, error: eventError } = await supabase
    .from('events')
    .select('id, status, summary, area, slug, title')
    .in('id', SUMMARY_IDS)
  if (eventError) throw new Error(eventError.message)
  const eventBy = new Map((events ?? []).map((row) => [row.id as number, row]))

  const { data: summaryReviews, error: summaryError } = await supabase
    .from('event_field_reviews')
    .select('id, event_id, field_name, status, proposed_value')
    .in('event_id', SUMMARY_IDS)
    .eq('field_name', 'summary')
    .in('status', ['pending', 'accepted'])
  if (summaryError) throw new Error(summaryError.message)
  const summaryByEvent = new Map((summaryReviews ?? []).map((row) => [row.event_id as number, row]))

  const watchFields = 'id, area, municipality, category, price_text, price_type, price_min, price_max, is_night, start_date, end_date, venue'
  const { data: beforeEvents, error: beforeError } = await supabase
    .from('events')
    .select(watchFields)
    .in('id', SUMMARY_IDS)
  if (beforeError) throw new Error(beforeError.message)
  const beforeBy = new Map((beforeEvents ?? []).map((row) => [row.id as number, JSON.stringify(row)]))

  const summarySkipped: { id: number; reason: string }[] = []
  let summaryAccepted = 0
  for (const eventId of SUMMARY_IDS) {
    const expected = CONFIRMED_SUMMARIES[eventId]
    const event = eventBy.get(eventId)
    const review = summaryByEvent.get(eventId)
    if (!event || event.status !== 'published') {
      summarySkipped.push({ id: eventId, reason: `status ${event?.status ?? 'missing'}` })
      continue
    }
    const current = (event.summary as string | null)?.trim() ?? ''
    if (current && current !== expected) {
      summarySkipped.push({ id: eventId, reason: 'summary already set to a different text' })
      continue
    }
    if (!review || review.field_name !== 'summary') {
      summarySkipped.push({ id: eventId, reason: 'summary review is missing' })
      continue
    }
    if (review.status === 'accepted' && current === expected) {
      summaryAccepted += 1
      continue
    }
    if (review.status !== 'pending') {
      summarySkipped.push({ id: eventId, reason: `summary review status ${review.status}` })
      continue
    }
    if (review.proposed_value !== expected) {
      summarySkipped.push({ id: eventId, reason: 'proposed summary differs from confirmed text' })
      continue
    }

    if (!current) {
      const { data: written, error: writeError } = await supabase
        .from('events')
        .update({ summary: expected, updated_at: now })
        .eq('id', eventId)
        .eq('status', 'published')
        .is('summary', null)
        .select('id')
      if (writeError) throw new Error(writeError.message)
      if (!written || written.length !== 1) {
        summarySkipped.push({ id: eventId, reason: 'summary update matched 0 rows' })
        continue
      }
    }

    const { data: accepted, error: acceptError } = await supabase
      .from('event_field_reviews')
      .update({
        status: 'accepted',
        decided_by: 'local_admin',
        decided_at: now,
        updated_at: now,
      })
      .eq('id', review.id)
      .eq('status', 'pending')
      .eq('field_name', 'summary')
      .select('id')
    if (acceptError) throw new Error(acceptError.message)
    if ((accepted?.length ?? 0) !== 1) {
      throw new Error(`summary review ${review.id} was not marked accepted`)
    }
    summaryAccepted += 1
  }

  const { data: after, error: afterError } = await supabase
    .from('events')
    .select('id, title, area, summary, start_date, end_date, status, slug')
    .eq('status', 'published')
  if (afterError) throw new Error(afterError.message)

  const areaStill = (after ?? []).filter((row) => AREA_REJECT_IDS.includes(row.id as number))
  const areaNotNull = areaStill.filter((row) => row.area != null)

  const { data: areaFinal, error: areaFinalError } = await supabase
    .from('event_field_reviews')
    .select('id, event_id, status')
    .in('event_id', AREA_REJECT_IDS)
    .eq('field_name', 'area')
    .eq('status', 'rejected')
  if (areaFinalError) throw new Error(areaFinalError.message)

  const { data: id44, error: id44Error } = await supabase
    .from('event_field_reviews')
    .select('id, field_name, status')
    .eq('event_id', 44)
    .in('field_name', ['category', 'price_text'])
    .eq('status', 'pending')
  if (id44Error) throw new Error(id44Error.message)

  const { data: pending, error: pendingError } = await supabase
    .from('event_field_reviews')
    .select('id, event_id, field_name, status, proposed_value')
    .eq('status', 'pending')
    .order('event_id')
  if (pendingError) throw new Error(pendingError.message)

  const open = (after ?? []).filter(
    (row) => !isEventEnded(row.start_date as string | null, row.end_date as string | null, OPEN_ON),
  )
  const openWithSummary = open.filter((row) => ((row.summary as string | null)?.trim() ?? '') !== '')
  const openEmpty = open.filter((row) => ((row.summary as string | null)?.trim() ?? '') === '')

  const { data: afterWatch, error: watchError } = await supabase
    .from('events')
    .select(watchFields)
    .in('id', SUMMARY_IDS)
  if (watchError) throw new Error(watchError.message)
  const fieldChanges = (afterWatch ?? []).filter((row) => beforeBy.get(row.id as number) !== JSON.stringify(row)).map((row) => row.id)

  const samples = [40, 99, 119, 121, 123].map((id) => {
    const row = (after ?? []).find((event) => event.id === id)
    return { id, slug: row?.slug ?? null, summary: row?.summary ?? null, area: row?.area ?? null }
  })

  console.log(JSON.stringify({
    summary_accepted: summaryAccepted,
    summary_skipped: summarySkipped,
    area_rejected_now: areaRejectIds.length,
    area_rejected_total: areaFinal?.length ?? 0,
    area_skipped: areaSkipped,
    area_not_null: areaNotNull.map((row) => row.id),
    id44_pending: id44,
    pending_remaining: pending,
    open_published: open.length,
    open_summary_filled: openWithSummary.length,
    open_summary_empty: openEmpty.map((row) => ({ id: row.id, title: row.title })),
    other_field_changes: fieldChanges,
    samples,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
