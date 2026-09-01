/**
 * DEV admin: イベント個別フィールドの手動更新。
 * - published / hidden: sync 本体は保護済み（draft のみ updateDraftBody で上書き）
 * - draft: 次回 sync でソース値に上書きされる可能性あり（UI で警告）
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
} from './event-image-usage'
import { normalizeHmToDb } from './event-time-rules'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminEventEditResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

function parseCategoryInput(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((s) => s.trim()).filter(Boolean)
      }
    } catch {
      /* fall through */
    }
  }
  return trimmed
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function emptyToNull(value: string): string | null {
  const t = value.trim()
  return t === '' ? null : t
}

export async function processAdminEventEditPost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminEventEditResult> {
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
  if (intent !== 'event_update') {
    return { ok: false, message: 'Invalid event edit request' }
  }

  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid event id' }
  }
  const eventId = ids[0]

  const imageStatusRaw = String(form.get('image_usage_status') ?? '').trim()
  if (!isImageUsageStatus(imageStatusRaw)) {
    return {
      ok: false,
      message: `Invalid image_usage_status (allowed: ${IMAGE_USAGE_STATUSES.join(', ')})`,
    }
  }

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('events')
    .select('id, status, image_url, image_usage_status, image_credit')
    .eq('id', eventId)
    .maybeSingle()

  if (selErr) throw selErr
  if (!existing) {
    return { ok: false, message: `Event id=${eventId} not found` }
  }

  const newImageUrl = emptyToNull(String(form.get('image_url') ?? ''))
  const imageChanged = (existing.image_url ?? null) !== newImageUrl
  const creditRaw = String(form.get('image_credit') ?? '').trim()
  const imageCredit =
    imageStatusRaw === 'licensed' || imageStatusRaw === 'organizer_granted'
      ? creditRaw || null
      : null

  const patch: Record<string, unknown> = {
    title: emptyToNull(String(form.get('title') ?? '')),
    start_date: emptyToNull(String(form.get('start_date') ?? '')),
    end_date: emptyToNull(String(form.get('end_date') ?? '')),
    start_time: normalizeHmToDb(String(form.get('start_time') ?? '')),
    end_time: normalizeHmToDb(String(form.get('end_time') ?? '')),
    venue: emptyToNull(String(form.get('venue') ?? '')),
    area: emptyToNull(String(form.get('area') ?? '')),
    address: emptyToNull(String(form.get('address') ?? '')),
    price_text: emptyToNull(String(form.get('price_text') ?? '')),
    category: parseCategoryInput(String(form.get('category') ?? '')),
    official_url: emptyToNull(String(form.get('official_url') ?? '')),
    summary: emptyToNull(String(form.get('summary') ?? '')),
    image_url: newImageUrl,
    image_usage_status: imageStatusRaw,
    image_credit: imageCredit,
    updated_at: new Date().toISOString(),
  }

  if (imageChanged && newImageUrl) {
    patch.image_source = emptyToNull(String(form.get('image_source') ?? '')) ?? 'seekigo'
  }

  const { error: updErr } = await admin
    .from('events')
    .update(patch)
    .eq('id', eventId)

  if (updErr) throw updErr

  return {
    ok: true,
    redirectTo: `/admin/events/${eventId}/?saved=1`,
  }
}
