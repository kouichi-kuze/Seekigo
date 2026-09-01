/**
 * DEV admin: published フィールド差分レビューの採用 / 却下。
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
  if (intent !== 'field_accept' && intent !== 'field_reject') {
    return { ok: false, message: 'Invalid field review request' }
  }

  const ids = parsePositiveIntIds(
    [form.get('review_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid review id' }
  }
  const reviewId = ids[0]

  const admin = createAdminClient()
  const { data: review, error: selErr } = await admin
    .from('event_field_reviews')
    .select(
      'id, event_id, field_name, proposed_value, status, source_name',
    )
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

  const eventId = Number(review.event_id)
  if (!Number.isFinite(eventId) || eventId <= 0) {
    return { ok: false, message: 'Invalid event_id on review' }
  }

  const now = new Date().toISOString()

  if (intent === 'field_reject') {
    const { error: rejErr } = await admin
      .from('event_field_reviews')
      .update({
        status: 'rejected',
        decided_by: 'local_admin',
        decided_at: now,
        updated_at: now,
      })
      .eq('id', reviewId)
      .eq('status', 'pending')

    if (rejErr) throw rejErr

    return {
      ok: true,
      redirectTo: `/admin/events/reviews/field/?field=rejected&review_id=${reviewId}&event_id=${eventId}`,
    }
  }

  // --- accept ---
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

  const dbValue = coerceProposedToDbValue(field, review.proposed_value)

  // 明示マップのカラムのみ更新（動的 SQL 禁止）
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
    .eq('id', reviewId)
    .eq('status', 'pending')

  if (accErr) throw accErr

  return {
    ok: true,
    redirectTo: `/admin/events/reviews/field/?field=accepted&review_id=${reviewId}&event_id=${eventId}&fname=${encodeURIComponent(field)}`,
  }
}
