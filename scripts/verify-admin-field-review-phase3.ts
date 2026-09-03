/**
 * Admin Phase 3 field review 最終確認（dev のみ）。
 * 用法: npx tsx scripts/verify-admin-field-review-phase3.ts
 *
 * - allowlist 整合チェック
 * - テスト pending 作成 → HTTP POST → DB 検証 → 後片付け
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import {
  REVIEWABLE_FIELD_COLUMN,
  REVIEWABLE_FIELD_NAMES,
  hashProposedValue,
} from '../src/lib/event-field-review'

config()

const LOG = '[verify-phase3]'
const SOURCE_PREFIX = 'phase3_test'
const DEV_BASE = process.env.ADMIN_DEV_URL ?? 'http://localhost:4321'
const FIELD_PENDING = `${DEV_BASE}/admin/events/reviews/field/pending/`
const FIELD_ACCEPTED = `${DEV_BASE}/admin/events/reviews/field/accepted/`

const url = process.env.PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(1)
}

const admin = createClient(url, key, { auth: { persistSession: false } })

type TestReviewIds = {
  acceptVenueId: number
  rejectAreaId: number
  bulkVenueId: number
  bulkAreaId: number
  disallowedTitleId: number
  eventAccept: number
  eventBulk: number
  originalVenueAccept: string | null
  originalVenueBulk: string | null
  originalAreaBulk: string | null
}

function checkAllowlist(): boolean {
  const names = [...REVIEWABLE_FIELD_NAMES]
  const columnKeys = Object.keys(REVIEWABLE_FIELD_COLUMN)
  const missingInColumn = names.filter((n) => !(n in REVIEWABLE_FIELD_COLUMN))
  const extraInColumn = columnKeys.filter(
    (k) => !(names as readonly string[]).includes(k),
  )
  const mismatch = names.filter(
    (n) => REVIEWABLE_FIELD_COLUMN[n as keyof typeof REVIEWABLE_FIELD_COLUMN] !== n,
  )

  console.log(`${LOG} allowlist count: ${names.length}`)
  console.log(`${LOG} REVIEWABLE_FIELD_NAMES:`, names.join(', '))

  let ok = true
  if (missingInColumn.length) {
    console.error(`${LOG} FAIL missing in COLUMN:`, missingInColumn)
    ok = false
  }
  if (extraInColumn.length) {
    console.error(`${LOG} FAIL extra in COLUMN:`, extraInColumn)
    ok = false
  }
  if (mismatch.length) {
    console.error(`${LOG} FAIL column value mismatch:`, mismatch)
    ok = false
  }
  if (ok) console.log(`${LOG} OK allowlist keys match (${names.length} fields)`)
  return ok
}

async function pickPublishedEvent(excludeId?: number): Promise<number> {
  let q = admin.from('events').select('id').eq('status', 'published').order('id')
  const { data, error } = await q.limit(10)
  if (error) throw error
  const id = (data ?? []).map((r) => Number(r.id)).find((id) => id !== excludeId)
  if (!id) throw new Error('No published event for test')
  return id
}

function testHash(field: string, value: unknown): string {
  if ((REVIEWABLE_FIELD_NAMES as readonly string[]).includes(field)) {
    return hashProposedValue(field as (typeof REVIEWABLE_FIELD_NAMES)[number], value)
  }
  const payload = `${field}:${JSON.stringify(value)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

async function insertTestReview(opts: {
  eventId: number
  sourceName: string
  fieldName: string
  current: unknown
  proposed: unknown
}): Promise<number> {
  const proposal_hash = testHash(opts.fieldName, opts.proposed)
  const { data, error } = await admin
    .from('event_field_reviews')
    .insert({
      event_id: opts.eventId,
      source_name: opts.sourceName,
      source_url: 'https://example.com/phase3-test',
      field_name: opts.fieldName,
      current_value: opts.current,
      proposed_value: opts.proposed,
      proposal_hash,
      status: 'pending',
      reason: 'phase3_test',
    })
    .select('id')
    .single()
  if (error) throw error
  return Number(data.id)
}

async function setupTests(): Promise<TestReviewIds & { sourceName: string }> {
  const eventAccept = await pickPublishedEvent()
  const eventBulk = await pickPublishedEvent(eventAccept)
  const ts = Date.now()
  const sourceName = `${SOURCE_PREFIX}_${ts}`

  const { data: evA } = await admin
    .from('events')
    .select('venue, area')
    .eq('id', eventAccept)
    .single()
  const { data: evB } = await admin
    .from('events')
    .select('venue, area')
    .eq('id', eventBulk)
    .single()

  const originalVenueAccept = (evA?.venue as string | null) ?? null
  const originalVenueBulk = (evB?.venue as string | null) ?? null
  const originalAreaBulk = (evB?.area as string | null) ?? null

  const acceptVenueId = await insertTestReview({
    eventId: eventAccept,
    sourceName,
    fieldName: 'venue',
    current: originalVenueAccept,
    proposed: `Phase3 Accept Venue ${Date.now()}`,
  })
  const rejectAreaId = await insertTestReview({
    eventId: eventAccept,
    sourceName,
    fieldName: 'area',
    current: evA?.area ?? null,
    proposed: `shibuya-${Date.now()}`,
  })
  const disallowedTitleId = await insertTestReview({
    eventId: eventAccept,
    sourceName,
    fieldName: 'title',
    current: 'Current Title',
    proposed: `Disallowed Title Proposal ${ts}`,
  })
  const bulkVenueId = await insertTestReview({
    eventId: eventBulk,
    sourceName,
    fieldName: 'venue',
    current: originalVenueBulk,
    proposed: `Phase3 Bulk Venue ${Date.now()}`,
  })
  const bulkAreaId = await insertTestReview({
    eventId: eventBulk,
    sourceName,
    fieldName: 'area',
    current: originalAreaBulk,
    proposed: `ueno-${Date.now()}`,
  })

  console.log(`${LOG} test reviews created`, {
    eventAccept,
    eventBulk,
    acceptVenueId,
    rejectAreaId,
    disallowedTitleId,
    bulkVenueId,
    bulkAreaId,
  })

  return {
    acceptVenueId,
    rejectAreaId,
    bulkVenueId,
    bulkAreaId,
    disallowedTitleId,
    eventAccept,
    eventBulk,
    originalVenueAccept,
    originalVenueBulk,
    originalAreaBulk,
    sourceName,
  }
}

async function getCsrf(): Promise<{ token: string; cookie: string }> {
  const res = await fetch(`${DEV_BASE}/admin/events/reviews/field/pending/`, {
    redirect: 'manual',
  })
  if (!res.ok && res.status !== 302) {
    throw new Error(`DEV server GET failed: ${res.status}. Is npm run dev running?`)
  }
  const setCookies = res.headers.getSetCookie?.() ?? []
  let csrf = ''
  for (const c of setCookies) {
    const m = c.match(/seekigo_admin_csrf=([^;]+)/)
    if (m) csrf = m[1]
  }
  if (!csrf || csrf.length < 32) {
    throw new Error('CSRF cookie not obtained from dev server')
  }
  return { token: csrf, cookie: `seekigo_admin_csrf=${csrf}` }
}

async function adminPost(
  csrf: { token: string; cookie: string },
  fields: Record<string, string>,
): Promise<{ status: number; location: string | null }> {
  const body = new URLSearchParams({ csrf_token: csrf.token, ...fields })
  console.log(`${LOG} POST /admin/events/`, fields)
  const res = await fetch(`${DEV_BASE}/admin/events/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: csrf.cookie,
      Origin: DEV_BASE,
      Referer: `${DEV_BASE}/admin/events/reviews/field/pending/`,
    },
    body,
    redirect: 'manual',
  })
  return { status: res.status, location: res.headers.get('location') }
}

async function verifyReviewState(
  reviewId: number,
  expected: { status: string; decided_by?: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from('event_field_reviews')
    .select('status, decided_by, decided_at')
    .eq('id', reviewId)
    .single()
  if (error) throw error
  const ok =
    data.status === expected.status &&
    (expected.decided_by == null || data.decided_by === expected.decided_by) &&
    (expected.status !== 'pending' ? !!data.decided_at : true)
  console.log(`${LOG} review #${reviewId} state:`, data, ok ? 'OK' : 'FAIL')
  return ok
}

async function cleanup(ids: TestReviewIds): Promise<void> {
  await admin.from('events').update({ venue: ids.originalVenueAccept }).eq('id', ids.eventAccept)
  await admin.from('events').update({
    venue: ids.originalVenueBulk,
    area: ids.originalAreaBulk,
  }).eq('id', ids.eventBulk)
  console.log(`${LOG} cleanup done (restored event fields; test reviews left as accepted/rejected)`)
}

async function checkUiHtml(disallowedTitleId: number): Promise<void> {
  const res = await fetch(FIELD_PENDING)
  const html = await res.text()
  const main = html.split('<main class="admin-main">')[1]?.split('</main>')[0] ?? html

  const titleCard = main.includes(`name="review_id" value="${disallowedTitleId}"`)
    ? main.slice(
        main.indexOf(`name="review_id" value="${disallowedTitleId}"`) - 2000,
        main.indexOf(`name="review_id" value="${disallowedTitleId}"`) + 500,
      )
    : ''

  const titleHasAccept = titleCard.includes('承認して反映')
  console.log(`${LOG} UI disallowed title #${disallowedTitleId} has accept btn: ${titleHasAccept ? 'FAIL' : 'OK'}`)
  if (titleHasAccept) throw new Error('Disallowed field shows accept button')

  const acc = await fetch(FIELD_ACCEPTED)
  const accHtml = await acc.text()
  const accMain = accHtml.split('<main class="admin-main">')[1]?.split('</main>')[0] ?? accHtml
  const reprocess =
    accMain.includes('class="actions"') ||
    accMain.includes('name="intent" value="field_accept"') ||
    accMain.includes('name="intent" value="field_reject"')
  console.log(`${LOG} UI accepted page action forms in main: ${reprocess ? 'FAIL' : 'OK'}`)
  if (reprocess) throw new Error('Accepted history shows action forms')

  const hasProcessedHint = accMain.includes('処理済みの review です')
  console.log(`${LOG} UI accepted page shows processed hint: ${hasProcessedHint ? 'OK' : '(no cards or hint)'}`)
}

async function main() {
  console.log(`${LOG} ---- Phase 3 final verification ----`)

  if (!checkAllowlist()) process.exit(1)

  const ids = await setupTests()
  const csrf = await getCsrf()

  await checkUiHtml(ids.disallowedTitleId)

  // single accept
  const acceptRes = await adminPost(csrf, {
    intent: 'field_accept',
    review_id: String(ids.acceptVenueId),
    return_to: '/admin/events/reviews/field/pending/',
  })
  if (acceptRes.status !== 302) throw new Error(`accept POST failed: ${acceptRes.status}`)
  console.log(`${LOG} accept redirect:`, acceptRes.location)

  const { data: evAfterAccept } = await admin
    .from('events')
    .select('venue, status')
    .eq('id', ids.eventAccept)
    .single()
  console.log(`${LOG} event after accept:`, evAfterAccept)
  if (evAfterAccept?.status !== 'published') throw new Error('event status changed')
  if (!evAfterAccept?.venue?.includes('Phase3 Accept Venue')) {
    throw new Error('venue not updated on accept')
  }
  if (!(await verifyReviewState(ids.acceptVenueId, { status: 'accepted', decided_by: 'local_admin' }))) {
    throw new Error('review not accepted')
  }

  // single reject
  const rejectRes = await adminPost(csrf, {
    intent: 'field_reject',
    review_id: String(ids.rejectAreaId),
  })
  if (rejectRes.status !== 302) throw new Error(`reject POST failed: ${rejectRes.status}`)
  if (!(await verifyReviewState(ids.rejectAreaId, { status: 'rejected', decided_by: 'local_admin' }))) {
    throw new Error('review not rejected')
  }

  // disallowed title reject (no accept available; reject should work)
  const titleReject = await adminPost(csrf, {
    intent: 'field_reject',
    review_id: String(ids.disallowedTitleId),
  })
  if (titleReject.status !== 302) throw new Error('title reject failed')
  if (!(await verifyReviewState(ids.disallowedTitleId, { status: 'rejected' }))) {
    throw new Error('disallowed title not rejected')
  }

  // bulk accept
  const bulkRes = await adminPost(csrf, {
    intent: 'field_accept_bulk',
    event_id: String(ids.eventBulk),
    confirm_bulk: '1',
    ack_bulk: '1',
  })
  if (bulkRes.status !== 302) throw new Error(`bulk accept failed: ${bulkRes.status}`)
  console.log(`${LOG} bulk redirect:`, bulkRes.location)

  if (!(await verifyReviewState(ids.bulkVenueId, { status: 'accepted' }))) {
    throw new Error('bulk venue not accepted')
  }
  if (!(await verifyReviewState(ids.bulkAreaId, { status: 'accepted' }))) {
    throw new Error('bulk area not accepted')
  }

  const { data: evBulk } = await admin
    .from('events')
    .select('venue, area, status')
    .eq('id', ids.eventBulk)
    .single()
  console.log(`${LOG} event after bulk:`, evBulk)
  if (!evBulk?.venue?.includes('Phase3 Bulk Venue') || !String(evBulk.area).startsWith('ueno-')) {
    throw new Error('bulk accept did not update events')
  }

  await cleanup(ids)

  console.log(`${LOG} ---- ALL CHECKS PASSED ----`)
  console.log(`${LOG} Note: check dev server terminal for [admin/field-review] POST logs`)
}

main().catch(async (e) => {
  console.error(`${LOG} FAILED:`, e)
  process.exit(1)
})
