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
  resolveEventDisplayImage,
  type EventDisplayImage,
  type ImageUsageStatus,
} from './event-image-usage'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminImageResult =
  | { ok: true; redirectTo: string }
  | { ok: true; ajax: true; updates: ImageUsageUpdateResult[] }
  | { ok: false; message: string }

export type ImageUsageUpdateResult = {
  event_id: number
  image_usage_status: ImageUsageStatus
  image_credit: string | null
  display_image: EventDisplayImage
}

type UpdateOneResult =
  | { ok: true; data: ImageUsageUpdateResult }
  | { ok: false; message: string }

function parseCreditForStatus(
  status: ImageUsageStatus,
  creditRaw: string,
): string | null {
  return status === 'licensed' || status === 'organizer_granted'
    ? creditRaw || null
    : null
}

async function updateOneEventImageUsage(
  eventId: number,
  status: ImageUsageStatus,
  credit: string | null,
  source: string | null,
): Promise<UpdateOneResult> {
  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('events')
    .select(
      'id, status, title, image_source, image_url, image_usage_status, image_credit, category',
    )
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
      image_source: source ?? existing.image_source ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', eventId)

  if (updErr) throw updErr

  const display_image = resolveEventDisplayImage({
    image_url: existing.image_url,
    image_usage_status: status,
    image_credit: credit,
    category: existing.category,
  })

  return {
    ok: true,
    data: {
      event_id: eventId,
      image_usage_status: status,
      image_credit: credit,
      display_image,
    },
  }
}

function wantsAjax(form: FormData): boolean {
  return String(form.get('ajax') ?? '') === '1'
}

export async function processAdminImageUsagePost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminImageResult> {
  const { request, url, cookies } = opts
  const form = opts.form ?? (await readAdminPostForm(request))
  const ajax = wantsAjax(form)
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

  if (intent === 'image_usage_bulk') {
    const ids = parsePositiveIntIds(form.getAll('event_ids'))
    if (ids.length === 0) {
      return { ok: false, message: 'イベントが選択されていません' }
    }

    const statusRaw = String(form.get('image_usage_status') ?? '').trim()
    if (!isImageUsageStatus(statusRaw)) {
      return {
        ok: false,
        message: `Invalid image_usage_status (allowed: ${IMAGE_USAGE_STATUSES.join(', ')})`,
      }
    }
    const status: ImageUsageStatus = statusRaw
    const credit = parseCreditForStatus(
      status,
      String(form.get('image_credit') ?? '').trim(),
    )

    const updates: ImageUsageUpdateResult[] = []
    for (const eventId of ids) {
      const result = await updateOneEventImageUsage(eventId, status, credit, null)
      if (!result.ok) {
        return { ok: false, message: result.message }
      }
      updates.push(result.data)
    }

    if (ajax) {
      return { ok: true, ajax: true, updates }
    }

    return {
      ok: true,
      redirectTo: `/admin/events/reviews/image/?image=bulk&count=${updates.length}&status=${encodeURIComponent(status)}`,
    }
  }

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
  const credit = parseCreditForStatus(
    status,
    String(form.get('image_credit') ?? '').trim(),
  )
  const sourceRaw = String(form.get('image_source') ?? '').trim()
  const source = sourceRaw || null

  const result = await updateOneEventImageUsage(eventId, status, credit, source)
  if (!result.ok) {
    return { ok: false, message: result.message }
  }

  if (ajax) {
    return { ok: true, ajax: true, updates: [result.data] }
  }

  return {
    ok: true,
    redirectTo: `/admin/events/reviews/image/?image=updated&event_id=${eventId}&status=${encodeURIComponent(status)}#event-${eventId}`,
  }
}
