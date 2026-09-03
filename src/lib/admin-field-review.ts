/**
 * DEV admin: published フィールド差分レビューの採用 / 却下（単体・一括）。
 * - accept: 許可フィールドのみ events 更新 + review accepted
 * - reject: events 非変更 + review rejected
 */
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import {
  coerceProposedToDbValue,
  isReviewableFieldName,
  REVIEWABLE_FIELD_COLUMN,
  type ReviewableFieldName,
} from './event-field-review'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminFieldReviewResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

type ReviewRow = {
  id: number
  event_id: number
  field_name: string
  proposed_value: unknown
  status: string
}

function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null
  const path = raw.trim()
  if (!path.startsWith('/admin/') || path.includes('://')) return null
  return path
}

function fieldReviewRedirect(
  base: string,
  params: Record<string, string | number | undefined>,
): string {
  const u = new URL(base, 'http://local')
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') u.searchParams.set(k, String(v))
  }
  return `${u.pathname}${u.search}`
}

async function loadPendingReview(
  admin: ReturnType<typeof createAdminClient>,
  reviewId: number,
  opts: { requireReviewable?: boolean } = { requireReviewable: true },
): Promise<{ ok: true; review: ReviewRow } | { ok: false; message: string }> {
  const { data: review, error: selErr } = await admin
    .from('event_field_reviews')
    .select('id, event_id, field_name, proposed_value, status, source_name')
    .eq('id', reviewId)
    .maybeSingle()

  if (selErr) throw selErr
  if (!review) {
    return { ok: false, message: `Review id=${reviewId} not found` }
  }
  if (review.status !== 'pending') {
    return {
      ok: false,
      message: `Review is not pending (status=${review.status})`,
    }
  }

  const fieldName = String(review.field_name ?? '')
  if (opts.requireReviewable) {
    if (!isReviewableFieldName(fieldName)) {
      return {
        ok: false,
        message: `Field not allowed for review: ${fieldName}`,
      }
    }
    const field: ReviewableFieldName = fieldName
    const column = REVIEWABLE_FIELD_COLUMN[field]
    if (!column || column !== field) {
      return { ok: false, message: `Unsafe field mapping for ${fieldName}` }
    }
  }

  const eventId = Number(review.event_id)
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return { ok: false, message: 'Invalid event_id on review' }
  }

  return { ok: true, review: review as ReviewRow }
}

async function assertPublishedEvent(
  admin: ReturnType<typeof createAdminClient>,
  eventId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { data: eventRow, error: evErr } = await admin
    .from('events')
    .select('id, status')
    .eq('id', eventId)
    .maybeSingle()
  if (evErr) throw evErr
  if (!eventRow) {
    return { ok: false, message: `Event id=${eventId} not found` }
  }
  if (eventRow.status !== 'published') {
    return {
      ok: false,
      message: `Event is not published (status=${eventRow.status})`,
    }
  }
  return { ok: true }
}

async function rejectReview(
  admin: ReturnType<typeof createAdminClient>,
  reviewId: number,
  now: string,
): Promise<void> {
  const { error } = await admin
    .from('event_field_reviews')
    .update({
      status: 'rejected',
      decided_by: 'local_admin',
      decided_at: now,
      updated_at: now,
    })
    .eq('id', reviewId)
    .eq('status', 'pending')

  if (error) throw error
}

async function acceptReview(
  admin: ReturnType<typeof createAdminClient>,
  review: ReviewRow,
  now: string,
): Promise<void> {
  const fieldName = String(review.field_name)
  if (!isReviewableFieldName(fieldName)) {
    throw new Error(`Field not allowed: ${fieldName}`)
  }
  const field: ReviewableFieldName = fieldName
  const column = REVIEWABLE_FIELD_COLUMN[field]
  if (!column || column !== field) {
    throw new Error(`Unsafe field mapping for ${fieldName}`)
  }

  const eventId = Number(review.event_id)
  const dbValue = coerceProposedToDbValue(field, review.proposed_value)

  const patch: Record<string, unknown> = {
    updated_at: now,
  }
  patch[column] = dbValue

  const { error: updEvErr } = await admin
    .from('events')
    .update(patch)
    .eq('id', eventId)
    .eq('status', 'published')

  if (updEvErr) throw updEvErr

  const { error: accErr } = await admin
    .from('event_field_reviews')
    .update({
      status: 'accepted',
      decided_by: 'local_admin',
      decided_at: now,
      updated_at: now,
    })
    .eq('id', review.id)
    .eq('status', 'pending')

  if (accErr) throw accErr
}

async function loadPendingReviewsForEvent(
  admin: ReturnType<typeof createAdminClient>,
  eventId: number,
  mode: 'accept' | 'reject',
): Promise<{ ok: true; reviews: ReviewRow[] } | { ok: false; message: string }> {
  const { data, error } = await admin
    .from('event_field_reviews')
    .select('id, event_id, field_name, proposed_value, status')
    .eq('event_id', eventId)
    .eq('status', 'pending')
    .order('id')

  if (error) throw error
  const all = (data ?? []) as ReviewRow[]
  if (all.length === 0) {
    return { ok: false, message: 'No pending reviews for this event' }
  }

  const reviews =
    mode === 'reject'
      ? all
      : all.filter((r) => {
          const fieldName = String(r.field_name ?? '')
          if (!isReviewableFieldName(fieldName)) return false
          const column = REVIEWABLE_FIELD_COLUMN[fieldName]
          return column === fieldName
        })

  if (reviews.length === 0) {
    return {
      ok: false,
      message:
        mode === 'accept'
          ? 'No reviewable pending reviews for bulk accept'
          : 'No pending reviews for this event',
    }
  }

  return { ok: true, reviews }
}

function logFieldReviewPost(
  intent: string,
  details: Record<string, string | number | undefined>,
): void {
  if (!import.meta.env.DEV) return
  console.info('[admin/field-review] POST', { intent, ...details })
}

export async function processAdminFieldReviewPost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminFieldReviewResult> {
  const { request, url, cookies } = opts
  const form = opts.form ?? (await readAdminPostForm(request))
  const csrfCheck = verifyAdminCsrf({
    formToken: String(form.get('csrf_token') ?? ''),
    cookieToken: cookies.get('seekigo_admin_csrf')?.value,
    request,
    url,
  })

  if (!csrfCheck.ok) {
    return { ok: false, message: `Security check failed: ${csrfCheck.reason}` }
  }

  const intent = String(form.get('intent') ?? '')
  const returnTo =
    safeReturnTo(String(form.get('return_to') ?? '')) ??
    '/admin/events/reviews/field/pending/'

  const admin = createAdminClient()
  const now = new Date().toISOString()

  if (intent === 'field_reject') {
    const ids = parsePositiveIntIds(
      [form.get('review_id')].filter(Boolean) as FormDataEntryValue[],
    )
    if (ids.length !== 1) {
      return { ok: false, message: 'Invalid review id' }
    }
    const reviewId = ids[0]
    logFieldReviewPost(intent, {
      review_id: reviewId,
      post_to: '/admin/events/',
    })
    const loaded = await loadPendingReview(admin, reviewId, {
      requireReviewable: false,
    })
    if (!loaded.ok) return loaded

    await rejectReview(admin, reviewId, now)

    return {
      ok: true,
      redirectTo: fieldReviewRedirect(returnTo, {
        field: 'rejected',
        review_id: reviewId,
        event_id: loaded.review.event_id,
      }),
    }
  }

  if (intent === 'field_accept') {
    const ids = parsePositiveIntIds(
      [form.get('review_id')].filter(Boolean) as FormDataEntryValue[],
    )
    if (ids.length !== 1) {
      return { ok: false, message: 'Invalid review id' }
    }
    const reviewId = ids[0]
    logFieldReviewPost(intent, {
      review_id: reviewId,
      post_to: '/admin/events/',
    })
    const loaded = await loadPendingReview(admin, reviewId, {
      requireReviewable: true,
    })
    if (!loaded.ok) return loaded

    const eventId = Number(loaded.review.event_id)
    logFieldReviewPost(intent, {
      review_id: reviewId,
      event_id: eventId,
      field_name: String(loaded.review.field_name),
      post_to: '/admin/events/',
    })
    const pub = await assertPublishedEvent(admin, eventId)
    if (!pub.ok) return pub

    await acceptReview(admin, loaded.review, now)

    return {
      ok: true,
      redirectTo: fieldReviewRedirect(returnTo, {
        field: 'accepted',
        review_id: reviewId,
        event_id: eventId,
        fname: String(loaded.review.field_name),
      }),
    }
  }

  if (intent === 'field_reject_bulk') {
    if (String(form.get('confirm_bulk') ?? '') !== '1') {
      return { ok: false, message: 'Bulk reject confirmation required' }
    }
    const eventIds = parsePositiveIntIds(
      [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
    )
    if (eventIds.length !== 1) {
      return { ok: false, message: 'Invalid event id' }
    }
    const eventId = eventIds[0]
    logFieldReviewPost(intent, {
      event_id: eventId,
      post_to: '/admin/events/',
    })
    const loaded = await loadPendingReviewsForEvent(admin, eventId, 'reject')
    if (!loaded.ok) return loaded

    for (const r of loaded.reviews) {
      await rejectReview(admin, r.id, now)
    }

    return {
      ok: true,
      redirectTo: fieldReviewRedirect(returnTo, {
        field: 'rejected_bulk',
        event_id: eventId,
        count: loaded.reviews.length,
      }),
    }
  }

  if (intent === 'field_accept_bulk') {
    if (String(form.get('confirm_bulk') ?? '') !== '1') {
      return { ok: false, message: 'Bulk accept confirmation required' }
    }
    if (String(form.get('ack_bulk') ?? '') !== '1') {
      return { ok: false, message: 'Bulk accept acknowledgment required' }
    }

    const eventIds = parsePositiveIntIds(
      [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
    )
    if (eventIds.length !== 1) {
      return { ok: false, message: 'Invalid event id' }
    }
    const eventId = eventIds[0]
    logFieldReviewPost(intent, {
      event_id: eventId,
      post_to: '/admin/events/',
    })

    const pub = await assertPublishedEvent(admin, eventId)
    if (!pub.ok) return pub

    const loaded = await loadPendingReviewsForEvent(admin, eventId, 'accept')
    if (!loaded.ok) return loaded

    for (const r of loaded.reviews) {
      await acceptReview(admin, r, now)
    }

    return {
      ok: true,
      redirectTo: fieldReviewRedirect(returnTo, {
        field: 'accepted_bulk',
        event_id: eventId,
        count: loaded.reviews.length,
      }),
    }
  }

  return { ok: false, message: 'Invalid field review request' }
}
