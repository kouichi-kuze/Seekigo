import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import { processAdminDedupeReviewPost } from './admin-dedupe-review'
import { processAdminImageUsagePost } from './admin-image-usage'
import { processAdminGeneratedImagePost } from './admin-generated-image'
import { processAdminFieldReviewPost } from './admin-field-review'
import { processAdminEventEditPost } from './admin-event-edit'
import { processAdminHidePost } from './admin-hide'
import { processAdminDeletePost } from './admin-delete'
import { processAdminReactionSummaryPost } from './admin-reaction-summary'
import {
  isTranslationIntent,
  processAdminEventTranslatePost,
} from './admin-event-translate'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminPostResult =
  | { ok: true; redirectTo: string }
  | { ok: true; ajax: true; updates: import('./admin-image-usage').ImageUsageUpdateResult[] }
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

  // 画像生成は公開・反応要約の source_count チェックより前に完結させる。
  if (
    intent === 'generated_image_create' ||
    intent === 'generated_image_regenerate' ||
    intent === 'generated_image_custom' ||
    intent === 'generated_image_upload' ||
    intent === 'generated_image_approve' ||
    intent === 'generated_image_reject' ||
    intent === 'generated_image_approve_displayed'
  ) {
    return processAdminGeneratedImagePost({ request, url, cookies, form })
  }

  if (
    intent === 'dedupe_link' ||
    intent === 'dedupe_create' ||
    intent === 'dedupe_reject'
  ) {
    return processAdminDedupeReviewPost({ request, url, cookies, form })
  }

  if (intent === 'image_usage_update' || intent === 'image_usage_bulk') {
    return processAdminImageUsagePost({ request, url, cookies, form })
  }

  if (
    intent === 'field_accept' ||
    intent === 'field_reject' ||
    intent === 'field_accept_bulk' ||
    intent === 'field_reject_bulk'
  ) {
    return processAdminFieldReviewPost({ request, url, cookies, form })
  }

  if (intent === 'event_update') {
    return processAdminEventEditPost({ request, url, cookies, form })
  }

  if (
    intent === 'reaction_save' ||
    intent === 'reaction_publish' ||
    intent === 'reaction_hide' ||
    intent === 'reaction_ai_generate'
  ) {
    return processAdminReactionSummaryPost({ request, url, cookies, form })
  }

  if (isTranslationIntent(intent)) {
    return processAdminEventTranslatePost({ request, url, cookies, form })
  }

  if (intent === 'hide_event' || intent === 'unhide_event') {
    return processAdminHidePost({ request, url, cookies, form })
  }

  if (intent === 'delete_event') {
    return processAdminDeletePost({ request, url, cookies, form })
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
    if (import.meta.env.DEV) {
      console.log('[admin-publish] intent=publish event_ids=', ids)
    }
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

    const { data: updated, error: updateError } = await admin
      .from('events')
      .update({
        status: 'published',
        updated_at: new Date().toISOString(),
      })
      .eq('id', eventId)
      .eq('status', 'draft')
      .select('id')

    if (import.meta.env.DEV) {
      console.log('[admin-publish] publish update rows=', updated?.length ?? 0, {
        error: updateError?.message ?? null,
      })
    }

    if (updateError) throw updateError
    if (!updated?.length) {
      return {
        ok: false,
        message: `Publish failed: no rows updated (event_id=${eventId})`,
      }
    }

    return {
      ok: true,
      redirectTo: `/admin/events/draft/?published=1&title=${encodeURIComponent(String(existing.title ?? eventId))}`,
    }
  }

  if (intent === 'publish_selected') {
    const ids = parsePositiveIntIds(form.getAll('event_ids'))
    if (import.meta.env.DEV) {
      console.log('[admin-publish] intent=publish_selected event_ids=', ids)
    }
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

    if (updateError) {
      if (import.meta.env.DEV) {
        console.log('[admin-publish] publish_selected error=', updateError.message)
      }
      throw updateError
    }

    const count = updated?.length ?? 0
    if (import.meta.env.DEV) {
      console.log('[admin-publish] publish_selected updated rows=', count)
    }
    return { ok: true, redirectTo: `/admin/events/draft/?bulk=${count}` }
  }

  return { ok: false, message: 'Invalid publish request' }
}
