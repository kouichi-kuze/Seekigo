/**
 * DEV admin: イベント専用イメージ画像を1枚生成し、採用状態だけを変える。
 * image_url / image_usage_status / image_credit / 本文は触らない。
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
import {
  classifyDisplayedApprovals,
  type GeneratedImageReviewRow,
} from './generated-image-review'
import {
  generateEventImage,
  normalizeGeneratedImageInstruction,
  saveUploadedEventImage,
  setGeneratedImageStatus,
} from './event-generated-image'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminGeneratedImageResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

export type DisplayedImageApproval = {
  approvedIds: number[]
  failedIds: number[]
}

/**
 * POSTされた ID だけを見る。DB上の pending を一括では更新しない。
 * pending かつ generated_image_url がある行だけを、1件ずつ approved にする。
 * events.status は更新しない。
 */
export async function approveDisplayedGeneratedImages(
  admin: SupabaseClient,
  requestedIds: number[],
): Promise<DisplayedImageApproval> {
  const approvedIds: number[] = []
  const failedIds: number[] = []

  for (const id of requestedIds) {
    const loaded = await admin
      .from('events')
      .select('id, generated_image_status, generated_image_url')
      .eq('id', id)
      .maybeSingle()
    if (loaded.error || !loaded.data) {
      failedIds.push(id)
      continue
    }
    const classified = classifyDisplayedApprovals(
      [id],
      [loaded.data as GeneratedImageReviewRow],
    )
    if (classified.approveIds.length !== 1) {
      failedIds.push(id)
      continue
    }
    const updated = await admin
      .from('events')
      .update({
        generated_image_status: 'approved',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('generated_image_status', 'pending')
      .select('id')
    if (updated.error || (updated.data ?? []).length !== 1) {
      failedIds.push(id)
      continue
    }
    approvedIds.push(id)
  }

  return { approvedIds, failedIds }
}

export async function processAdminGeneratedImagePost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminGeneratedImageResult> {
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
  const admin = createAdminClient()

  if (intent === 'generated_image_approve_displayed') {
    const requestedIds = parsePositiveIntIds([
      ...form.getAll('event_id'),
      ...form.getAll('event_ids'),
    ])
    if (requestedIds.length === 0) {
      return { ok: false, message: '表示中の画像がありません' }
    }
    const { approvedIds, failedIds } = await approveDisplayedGeneratedImages(
      admin,
      requestedIds,
    )
    const params = new URLSearchParams({
      generated_bulk: '1',
      ok: String(approvedIds.length),
      ng: String(failedIds.length),
    })
    if (failedIds.length > 0) params.set('failed', failedIds.join(','))
    return {
      ok: true,
      redirectTo: `/admin/events/reviews/image/?${params.toString()}`,
    }
  }

  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: '1件だけ指定してください' }
  }
  const eventId = ids[0]
  const returnTo = String(form.get('return_to') ?? '').trim()
  const back =
    returnTo.startsWith('/admin/events/') ? returnTo : `/admin/events/${eventId}/`

  if (intent === 'generated_image_create' || intent === 'generated_image_regenerate') {
    const result = await generateEventImage(admin, eventId)
    if (!result.ok) return result
    return {
      ok: true,
      redirectTo: `${back}?generated=pending&event_id=${eventId}`,
    }
  }

  if (intent === 'generated_image_custom') {
    const instruction = normalizeGeneratedImageInstruction(
      String(form.get('generated_image_instruction') ?? ''),
    )
    if ('error' in instruction) return { ok: false, message: instruction.error }
    if (!instruction.text) {
      return { ok: false, message: '追加指示を入力してください' }
    }
    const result = await generateEventImage(admin, eventId, instruction.text)
    if (!result.ok) return result
    return {
      ok: true,
      redirectTo: `${back}?generated=pending&event_id=${eventId}`,
    }
  }

  if (intent === 'generated_image_upload') {
    const file = form.get('generated_image_file')
    if (!file || typeof file === 'string' || file.size <= 0) {
      return { ok: false, message: '画像ファイルを選択してください' }
    }
    const result = await saveUploadedEventImage(admin, eventId, file)
    if (!result.ok) return result
    const joiner = back.includes('?') ? '&' : '?'
    return {
      ok: true,
      redirectTo: `${back}${joiner}generated=pending&source=upload&event_id=${eventId}`,
    }
  }

  if (intent === 'generated_image_approve' || intent === 'generated_image_reject') {
    const status = intent === 'generated_image_approve' ? 'approved' : 'rejected'
    const result = await setGeneratedImageStatus(admin, eventId, status)
    if (!result.ok) return result
    return {
      ok: true,
      redirectTo: `/admin/events/reviews/image/?generated=${status}&event_id=${eventId}`,
    }
  }

  return { ok: false, message: 'Invalid generated image request' }
}
