/**
 * Walkerplus Phase 1B: event_field_reviews 検証（読み取りのみ）
 *
 * 用法: npx tsx scripts/verify-walkerplus-field-reviews.ts
 */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config()

const LOG = '[verify-walkerplus-field-reviews]'

function createClient_() {
  const url =
    process.env.PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) {
    throw new Error('PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

function display(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

async function main() {
  const sb = createClient_()

  const { data: reviews, error: revErr } = await sb
    .from('event_field_reviews')
    .select(
      'id, event_id, field_name, current_value, proposed_value, source_name, status, proposal_hash, created_at',
    )
    .eq('source_name', 'walkerplus')
    .order('id')
  if (revErr) throw revErr

  const eventIds = [...new Set((reviews ?? []).map((r) => r.event_id))]
  const { data: events, error: evErr } = await sb
    .from('events')
    .select('id, slug, title, status, summary, address, price_text, category, official_url, start_time, end_time, updated_at')
    .in('id', eventIds.length ? eventIds : [-1])
  if (evErr) throw evErr

  const eventById = new Map((events ?? []).map((e) => [Number(e.id), e]))

  console.log(`${LOG} ---- walkerplus field reviews (${reviews?.length ?? 0}) ----`)
  for (const r of reviews ?? []) {
    const ev = eventById.get(Number(r.event_id))
    console.log(`${LOG} review id=${r.id}`)
    console.log(`  event_id: ${r.event_id}`)
    console.log(`  event slug: ${ev?.slug ?? '(not found)'}`)
    console.log(`  event title: ${ev?.title ?? '(not found)'}`)
    console.log(`  event status: ${ev?.status ?? '(not found)'}`)
    console.log(`  field_name: ${r.field_name}`)
    console.log(`  current_value: ${display(r.current_value)}`)
    console.log(`  proposed_value: ${display(r.proposed_value)}`)
    console.log(`  source_name: ${r.source_name}`)
    console.log(`  status: ${r.status}`)
    console.log(`  proposal_hash: ${r.proposal_hash}`)
  }

  // duplicate proposal_hash per (event_id, source_name, field_name)
  const hashGroups = new Map<string, typeof reviews>()
  for (const r of reviews ?? []) {
    const key = `${r.event_id}|${r.source_name}|${r.field_name}|${r.proposal_hash}`
    const list = hashGroups.get(key) ?? []
    list.push(r)
    hashGroups.set(key, list)
  }
  const dupes = [...hashGroups.entries()].filter(([, list]) => list.length > 1)

  console.log(`${LOG} ---- idempotency: duplicate proposal_hash ----`)
  if (dupes.length === 0) {
    console.log(`${LOG} OK: no duplicate (event_id, source_name, field_name, proposal_hash)`)
  } else {
    for (const [key, list] of dupes) {
      console.log(`${LOG} DUPLICATE key=${key} ids=${list.map((r) => r.id).join(',')}`)
    }
  }

  // published-only check
  const nonPublished = (reviews ?? []).filter((r) => {
    const ev = eventById.get(Number(r.event_id))
    return ev?.status !== 'published'
  })
  console.log(`${LOG} ---- published-only check ----`)
  if (nonPublished.length === 0) {
    console.log(`${LOG} OK: all field reviews target published events`)
  } else {
    for (const r of nonPublished) {
      const ev = eventById.get(Number(r.event_id))
      console.log(
        `${LOG} FAIL: review id=${r.id} event_id=${r.event_id} status=${ev?.status ?? 'unknown'}`,
      )
    }
  }

  // draft events with walkerplus field reviews
  const { data: draftReviews, error: drErr } = await sb
    .from('event_field_reviews')
    .select('id, event_id')
    .eq('source_name', 'walkerplus')
  if (drErr) throw drErr

  const draftEventIds = (events ?? [])
    .filter((e) => e.status === 'draft')
    .map((e) => Number(e.id))
  const draftWithReviews = (draftReviews ?? []).filter((r) =>
    draftEventIds.includes(Number(r.event_id)),
  )
  console.log(`${LOG} ---- draft field review check ----`)
  if (draftWithReviews.length === 0) {
    console.log(`${LOG} OK: no field reviews on draft events`)
  } else {
    console.log(`${LOG} FAIL: ${draftWithReviews.length} review(s) on draft events`)
  }

  // published body unchanged: events linked to reviews should still be published
  console.log(`${LOG} ---- published body snapshot ----`)
  for (const id of eventIds) {
    const ev = eventById.get(Number(id))
    if (!ev) continue
    console.log(
      `${LOG} event id=${id} slug=${ev.slug} status=${ev.status} updated_at=${ev.updated_at}`,
    )
  }

  console.log(`${LOG} done`)
}

main().catch((err) => {
  console.error(`${LOG} fatal:`, err)
  process.exit(1)
})
