/**
 * DEV admin: イベント専用イメージ画像を1枚生成し、採用状態だけを変える。
 * image_url / image_usage_status / image_credit / 本文は触らない。
 */
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'
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

  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: '1件だけ指定してください' }
  }
  const eventId = ids[0]
  const intent = String(form.get('intent') ?? '')
  const admin = createAdminClient()
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
