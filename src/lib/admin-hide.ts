/**
 * DEV admin: published → hidden / hidden → published
 * hidden は公開サイト・SSG から除外。sync 本体は published と同様保護。
 */
import { createAdminClient } from './supabase-admin'
import {
  parsePositiveIntIds,
  readAdminPostForm,
  verifyAdminCsrf,
} from './admin-security'

type AdminCookies = {
  get: (name: string) => { value: string } | undefined
}

export type AdminHideResult =
  | { ok: true; redirectTo: string }
  | { ok: false; message: string }

export async function processAdminHidePost(opts: {
  request: Request
  url: URL
  cookies: AdminCookies
  form?: FormData
}): Promise<AdminHideResult> {
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
  if (intent !== 'hide_event' && intent !== 'unhide_event') {
    return { ok: false, message: 'Invalid hide request' }
  }

  const ids = parsePositiveIntIds(
    [form.get('event_id')].filter(Boolean) as FormDataEntryValue[],
  )
  if (ids.length !== 1) {
    return { ok: false, message: 'Invalid event id' }
  }
  const eventId = ids[0]

  const admin = createAdminClient()
  const { data: existing, error: selErr } = await admin
    .from('events')
    .select('id, status, title')
    .eq('id', eventId)
    .maybeSingle()

  if (selErr) throw selErr
  if (!existing) {
    return { ok: false, message: `Event id=${eventId} not found` }
  }

  const now = new Date().toISOString()

  if (intent === 'hide_event') {
    if (existing.status !== 'published') {
      return {
        ok: false,
        message: `非表示は published のみ可能です (現在: ${existing.status})`,
      }
    }
    const { error: updErr } = await admin
      .from('events')
      .update({ status: 'hidden', updated_at: now })
      .eq('id', eventId)
      .eq('status', 'published')
    if (updErr) throw updErr
    return {
      ok: true,
      redirectTo: `/admin/events/${eventId}/?hidden=1`,
    }
  }

  if (existing.status !== 'hidden') {
    return {
      ok: false,
      message: `再公開は hidden のみ可能です (現在: ${existing.status})`,
    }
  }
  const { error: updErr } = await admin
    .from('events')
    .update({ status: 'published', updated_at: now })
    .eq('id', eventId)
    .eq('status', 'hidden')
  if (updErr) throw updErr
  return {
    ok: true,
    redirectTo: `/admin/events/${eventId}/?unhidden=1`,
  }
}
