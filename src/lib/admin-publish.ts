import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import { processAdminDedupeReviewPost } from './admin-dedupe-review'
import { processAdminImageUsagePost } from './admin-image-usage'
import { processAdminFieldReviewPost } from './admin-field-review'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminPostResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

/** @deprecated alias */
export type AdminPublishResult = AdminPostResult

/** DEV 用: /admin/events/ POST（Publish + dedupe review + image usage） */
export async function processAdminPublishPost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
}): Promise<AdminPostResult> {
  const { request, url, cookies } = opts
  const form = await readAdminPostForm(request)
  const intent = String(form.get('intent') ?? '')

  if (
    intent === 'dedupe_link' ||
    intent === 'dedupe_create' ||
    intent === 'dedupe_reject'
  ) {
    return processAdminDedupeReviewPost({ request, url, cookies, form })
  }

  if (intent === 'image_usage_update') {
    return processAdminImageUsagePost({ request, url, cookies, form })
  }

  if (intent === 'field_accept' || intent === 'field_reject') {
    return processAdminFieldReviewPost({ request, url, cookies, form })
  }

  const csrfCheck = verifyAdminCsrf({
    formToken: String(form.get('csrf_token') ?? ''),
    cookieToken: cookies.get('seekigo_admin_csrf')?.value,
    request,
    url,
  })

  if (!csrfCheck.ok) {
    return { ok: false, message: `Security check failed: ${csrfCheck.reason}` }
  }

  const admin = createAdminClient()

  if (intent === 'publish') {
    const ids = parsePositiveIntIds(
      [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
    )
    if (ids.length !== 1) {
      return { ok: false, message: 'Invalid event id' }
    }

    const eventId = ids[0]
    const { data: existing, error: selectError } = await admin
      .from('events')
      .select('id, status, title')
      .eq('id', eventId)
      .maybeSingle()

    if (selectError) throw selectError
    if (!existing) {
      return { ok: false, message: `Event id=${eventId} not found` }
    }
    if (existing.status !== 'draft') {
      return {
        ok: false,
        message: `Event is not draft (status=${existing.status})`,
      }
    }

    const { error: updateError } = await admin
      .from('events')
      .update({
        status: 'published',
        updated_at: new Date().toISOString(),
      })
      .eq('id', eventId)
      .eq('status', 'draft')

    if (updateError) throw updateError

    return {
      ok: true,
      redirectTo: `/admin/events/?published=1&title=${encodeURIComponent(String(existing.title ?? eventId))}`,
    }
  }

  if (intent === 'publish_selected') {
    const ids = parsePositiveIntIds(form.getAll('event_ids'))
    if (ids.length === 0) {
      return { ok: false, message: 'イベントが選択されていません' }
    }

    const now = new Date().toISOString()
    const { data: updated, error: updateError } = await admin
      .from('events')
      .update({
        status: 'published',
        updated_at: now,
      })
      .in('id', ids)
      .eq('status', 'draft')
      .select('id')

    if (updateError) throw updateError

    const count = updated?.length ?? 0
    return { ok: true, redirectTo: `/admin/events/?bulk=${count}` }
  }

  return { ok: false, message: 'Invalid publish request' }
}
