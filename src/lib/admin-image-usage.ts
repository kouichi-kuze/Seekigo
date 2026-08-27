/**
 * DEV admin: 画像利用ステータス更新（draft / published とも管理画面のみ）。
 * sync からは呼ばない。
 */
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import {
  IMAGE_USAGE_STATUSES,
  isImageUsageStatus,
  type ImageUsageStatus,
} from './event-image-usage'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminImageResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

export async function processAdminImageUsagePost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminImageResult> {
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
  if (intent !== 'image_usage_update') {
    return { ok: false, message: 'Invalid image usage request' }
  }

  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid event id' }
  }
  const eventId = ids[0]

  const statusRaw = String(form.get('image_usage_status') ?? '').trim()
  if (!isImageUsageStatus(statusRaw)) {
    return {
      ok: false,
      message: `Invalid image_usage_status (allowed: ${IMAGE_USAGE_STATUSES.join(', ')})`,
    }
  }
  const status: ImageUsageStatus = statusRaw

  // credit は licensed / organizer_granted のみ任意入力。他はクリア。
  const creditRaw = String(form.get('image_credit') ?? '').trim()
  const credit =
    status === 'licensed' || status === 'organizer_granted'
      ? creditRaw || null
      : null

  const sourceRaw = String(form.get('image_source') ?? '').trim()
  const source = sourceRaw || null

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('events')
    .select('id, status, title, image_source')
    .eq('id', eventId)
    .maybeSingle()
  if (selErr) throw selErr
  if (!existing) {
    return { ok: false, message: `Event id=${eventId} not found` }
  }

  const { error: updErr } = await admin
    .from('events')
    .update({
      image_usage_status: status,
      image_credit: credit,
      // source 未送信時は既存を維持（フォーム省略でも消さない）
      image_source: source ?? existing.image_source ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', eventId)

  if (updErr) throw updErr

  return {
    ok: true,
    redirectTo: `/admin/events/?image=updated&event_id=${eventId}&status=${encodeURIComponent(status)}`,
  }
}
